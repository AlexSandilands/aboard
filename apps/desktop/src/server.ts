import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { BRAND, brandEnv } from "@repo/contracts";
import { app, utilityProcess } from "electron";
import { LogTail, isOwnHealth } from "./shell.logic.ts";

export interface BoardServer {
  /** Base URL of the API/MCP server. */
  url: string;
  /** False when we attached to a server someone else started (e.g. `pnpm dev`); we never stop that one. */
  owned: boolean;
  stop(): Promise<void>;
}

export interface ServerOptions {
  port: number;
  /** Bundled server entry (`server.mjs`). */
  bundle: string;
  /** Built web app, or null to keep the server's own default (the repo's `apps/web/dist`). */
  webDist: string | null;
  /** Wait for an external server instead of starting one (`pnpm desktop` runs `pnpm dev` alongside). */
  attachOnly: boolean;
  /** Called if a server we own dies after startup. */
  onUnexpectedExit(details: string): void;
}

export class ServerStartError extends Error {
  constructor(
    message: string,
    readonly logs: string,
  ) {
    super(message);
  }
}

const READY_TIMEOUT_MS = 30_000;
const ATTACH_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5000;

async function probe(url: string): Promise<"ours" | "other" | "none"> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return isOwnHealth(await res.json().catch(() => null)) ? "ours" : "other";
  } catch {
    return "none";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connects to the board server: reuses one already answering on the port (two servers on one SQLite
 * file would fight), otherwise runs the bundled server in an Electron utilityProcess.
 */
export async function connectServer(options: ServerOptions): Promise<BoardServer> {
  const url = `http://127.0.0.1:${options.port}`;
  const attached: BoardServer = { url, owned: false, stop: async () => {} };

  const found = await probe(url);
  if (found === "ours") return attached;
  if (found === "other") {
    throw new ServerStartError(`Port ${options.port} is in use by another application.`, "");
  }
  if (options.attachOnly) {
    const deadline = Date.now() + ATTACH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(500);
      if ((await probe(url)) === "ours") return attached;
    }
    throw new ServerStartError(`No ${BRAND.name} server came up on ${url}. Is \`pnpm dev\` running?`, "");
  }
  return spawnServer(url, options);
}

function spawnServer(url: string, options: ServerOptions): Promise<BoardServer> {
  const tail = new LogTail();
  const logPath = join(app.getPath("logs"), "server.log");
  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} starting ${options.bundle}\n`);

  const child = utilityProcess.fork(options.bundle, [], {
    serviceName: `${BRAND.name} server`,
    stdio: "pipe",
    env: {
      ...process.env,
      [brandEnv("PORT")]: String(options.port),
      ...(options.webDist ? { [brandEnv("WEB_DIST")]: options.webDist } : {}),
      // The server's own node:sqlite warning is noise in our log.
      NODE_NO_WARNINGS: "1",
    },
  });
  const capture = (chunk: Buffer) => {
    log.write(chunk);
    tail.push(chunk.toString("utf8"));
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const report = () => `${tail.toString()}

Full log: ${logPath}`;
  let ready = false;
  let stopping = false;
  const exited = new Promise<number>((resolve) => child.once("exit", resolve));

  const server: BoardServer = {
    url,
    owned: true,
    async stop() {
      if (stopping) return;
      stopping = true;
      // A graceful stop checkpoints the SQLite WAL; kill() would skip that on Windows.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron UtilityProcess, not window.postMessage
      child.postMessage("shutdown");
      const timedOut = await Promise.race([exited.then(() => false), sleep(STOP_TIMEOUT_MS).then(() => true)]);
      if (timedOut) child.kill();
    },
  };

  return new Promise<BoardServer>((resolve, reject) => {
    const fail = (message: string) => reject(new ServerStartError(message, report()));
    const timer = setTimeout(() => {
      fail(`The server did not start within ${READY_TIMEOUT_MS / 1000}s.`);
      child.kill();
    }, READY_TIMEOUT_MS);
    child.on("message", (message: unknown) => {
      if ((message as { type?: unknown } | null)?.type !== "ready") return;
      clearTimeout(timer);
      ready = true;
      resolve(server);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      log.end(`--- exited with code ${code}
`);
      if (!ready) fail(`The server exited during startup (code ${code}).`);
      else if (!stopping) options.onUnexpectedExit(report());
    });
  });
}
