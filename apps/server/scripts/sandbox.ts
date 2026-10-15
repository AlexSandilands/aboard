/**
 * `pnpm sandbox`: runs this checkout's board on its own ports so a change can be tried in the browser
 * without touching the board the user runs from main.
 *
 *   pnpm sandbox [--seed basic|review|threads|none]   isolated: own server, temp data dir, seeded (default)
 *   pnpm sandbox --live                               Vite only, on the real server's data (writes are rejected)
 *   pnpm sandbox status                               prints the running sandbox's ready line
 *   pnpm sandbox stop                                 stops it and deletes its data dir
 *
 * Prints one `SANDBOX_READY {json}` line once the board answers; agents wait for it before opening the URL.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, brandEnv } from "@repo/contracts";

const READY_PREFIX = "SANDBOX_READY";
const DEFAULT_SERVER_PORT = 4317;
const DEFAULT_WEB_PORT = 5317;
const isWindows = process.platform === "win32";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const serverDir = join(repoRoot, "apps", "server");
const webDir = join(repoRoot, "apps", "web");
// One sandbox per checkout: a second `pnpm sandbox` in the same worktree finds the first instead of racing it.
const sandboxName = basename(resolve(repoRoot)).replace(/[^\w.-]/g, "_");
const home = join(tmpdir(), `${BRAND.id}-sandbox-${sandboxName}`);
const stateFile = join(home, "sandbox.json");

interface SandboxState {
  pid: number;
  childPids: number[];
  mode: "isolated" | "live";
  seed: string | null;
  url: string;
  serverPort: number;
  webPort: number;
  home: string;
}

function fail(message: string): never {
  console.error(`[sandbox] ${message}`);
  process.exit(1);
}

/** The board the user runs every day. Nothing here may write to it. */
function assertNotRealHome(dir: string): void {
  const real = process.env[brandEnv("HOME")] ?? join(homedir(), `.${BRAND.id}`);
  const norm = (p: string) => resolve(p).toLowerCase();
  if (norm(dir) === norm(real) || norm(dir) === norm(join(homedir(), `.${BRAND.id}`))) {
    fail(`refusing to use the real data dir ${dir}`);
  }
}

function readState(): SandboxState | null {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as SandboxState;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid: number): void {
  if (!isAlive(pid)) return;
  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  // Children are spawned detached on POSIX, so each leads its own process group.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

function removeHome(): void {
  assertNotRealHome(home);
  // SQLite's files stay locked for a moment after the server dies on Windows.
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

async function waitForExit(pids: number[], timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isAlive) && Date.now() < deadline) await sleep(100);
}

async function stop(): Promise<void> {
  const state = readState();
  if (!state) {
    if (existsSync(home)) removeHome();
    console.log("[sandbox] no sandbox running");
    return;
  }
  const pids = [state.pid, ...state.childPids];
  for (const pid of pids) killTree(pid);
  await waitForExit(pids);
  const ports = state.mode === "live" ? [state.webPort] : [state.serverPort, state.webPort];
  const busy = await waitForPortsClosed(ports);
  if (busy.length > 0) {
    // Something else holds them now; this sandbox didn't start it, so leave it alone.
    console.warn(`[sandbox] port ${busy.join(", ")} still in use after stopping`);
  }
  removeHome();
  console.log(`[sandbox] stopped; removed ${home}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isListening = (port: number) =>
  new Promise<boolean>((resolveListening) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolveListening(true);
    });
    socket.once("error", () => resolveListening(false));
  });

/** The ports still listening once the timeout passes. */
async function waitForPortsClosed(ports: number[], timeoutMs = 10_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy: number[] = [];
    for (const port of ports) if (await isListening(port)) busy.push(port);
    if (busy.length === 0 || Date.now() > deadline) return busy;
    await sleep(200);
  }
}

/** A free localhost port that isn't one of the defaults the user's own board uses. */
function freePort(taken: number[]): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        if ([DEFAULT_SERVER_PORT, DEFAULT_WEB_PORT, ...taken].includes(port)) resolvePort(freePort(taken));
        else resolvePort(port);
      });
    });
  });
}

async function waitFor(url: string, check: (res: Response) => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (await check(res)) return;
    } catch {
      // Not listening yet.
    }
    await sleep(300);
  }
  throw new Error(`${what} did not answer at ${url}`);
}

const isOurHealth = async (res: Response) => res.ok && ((await res.json()) as { id?: string }).id === BRAND.id;

function run(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWindows,
  });
  const prefix = (chunk: Buffer) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `[${name}] ${line}\n`)
      .join("");
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(prefix(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(prefix(chunk)));
  return child;
}

function parseArgs(argv: string[], isScenarioName: (name: string) => boolean) {
  const live = argv.includes("--live");
  const seedIndex = argv.indexOf("--seed");
  const seed = seedIndex >= 0 ? argv[seedIndex + 1] : "basic";
  if (!seed || (seed !== "none" && !isScenarioName(seed)))
    fail(`unknown seed "${seed}" (basic, review, threads, none)`);
  if (live && seedIndex >= 0) fail("--seed has no effect with --live, which shows the real board");
  return { live, seed };
}

async function start(argv: string[]): Promise<void> {
  // Loaded here so `status` and `stop` don't open SQLite (and print its experimental warning).
  const { isScenarioName, seedDatabase } = await import("../src/dev/seeds.ts");
  const { live, seed } = parseArgs(argv, isScenarioName);
  const existing = readState();
  if (existing && isAlive(existing.pid)) {
    // Same checkout, so Vite already hot-reloads its edits: hand back the running one instead of a port clash.
    console.log(
      `[sandbox] already running (${existing.mode}${existing.seed ? `, seed ${existing.seed}` : ""}); ` +
        "run `pnpm sandbox stop` first for a fresh one",
    );
    console.log(`${READY_PREFIX} ${JSON.stringify(existing)}`);
    return;
  }
  if (existsSync(home)) removeHome();
  mkdirSync(home, { recursive: true });

  const realServerPort = Number(process.env[brandEnv("PORT")] ?? DEFAULT_SERVER_PORT);
  const serverPort = live ? realServerPort : await freePort([]);
  const webPort = await freePort([serverPort]);
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const url = `http://127.0.0.1:${webPort}/`;

  const env: NodeJS.ProcessEnv = { ...process.env };
  // Never inherit the user's own board settings: a token would lock the sandbox out, a home would share data.
  delete env[brandEnv("TOKEN")];
  delete env[brandEnv("HOME")];
  env[brandEnv("PORT")] = String(serverPort);
  env[brandEnv("WEB_PORT")] = String(webPort);

  const children: ChildProcess[] = [];
  let stopping = false;
  const shutdown = (code: number) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (child.pid) killTree(child.pid);
    void waitForExit(children.flatMap((c) => (c.pid ? [c.pid] : []))).then(() => {
      removeHome();
      process.exit(code);
    });
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  if (live) {
    try {
      await waitFor(`${serverUrl}/api/health`, isOurHealth, "the real server");
    } catch {
      removeHome();
      fail(`--live needs the real server on ${serverUrl}; start it (or the desktop app) first`);
    }
    console.warn(
      [
        "[sandbox] ================================================================",
        `[sandbox] LIVE MODE: this shows the REAL board from ${serverUrl}.`,
        `[sandbox] The real server only accepts writes from port ${DEFAULT_WEB_PORT}, so changes made here`,
        "[sandbox] are rejected (403). Use the isolated mode to try anything that writes.",
        "[sandbox] ================================================================",
      ].join("\n"),
    );
  } else {
    assertNotRealHome(home);
    const dataDir = join(home, "data");
    mkdirSync(dataDir, { recursive: true });
    if (seed !== "none" && isScenarioName(seed)) {
      seedDatabase(join(dataDir, "data.sqlite"), seed, { workspaceRoot: resolve(repoRoot) });
    }
    env[brandEnv("HOME")] = dataDir;
    env[brandEnv("POLLERS")] = "0";
    // A folder that doesn't exist: no T3 Code install is detected, so nothing reaches the user's T3 threads.
    env.T3CODE_HOME = join(home, "no-t3");
    // Vite serves the UI; a stale build in apps/web/dist would only confuse.
    env[brandEnv("WEB_DIST")] = join(home, "no-web-dist");
    children.push(
      run("server", ["--watch", "--watch-preserve-output", "--import", "tsx", "src/main.ts"], serverDir, env),
    );
  }

  const viteBin = join(
    dirname(createRequire(join(webDir, "package.json")).resolve("vite/package.json")),
    "bin",
    "vite.js",
  );
  children.push(run("web", [viteBin], webDir, env));

  for (const child of children) {
    child.once("exit", (code) => {
      if (stopping) return;
      console.error(`[sandbox] a child process exited (code ${code}); stopping`);
      shutdown(1);
    });
  }

  const state: SandboxState = {
    pid: process.pid,
    childPids: children.flatMap((c) => (c.pid ? [c.pid] : [])),
    mode: live ? "live" : "isolated",
    seed: live ? null : seed,
    url,
    serverPort,
    webPort,
    home,
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2));

  try {
    if (!live) await waitFor(`${serverUrl}/api/health`, isOurHealth, "the sandbox server");
    await waitFor(url, async (res) => res.ok, "Vite");
    // Through Vite's proxy too, so the ready line means the board can actually load its data.
    await waitFor(`http://127.0.0.1:${webPort}/api/health`, isOurHealth, "Vite's proxy");
  } catch (error) {
    console.error(`[sandbox] ${(error as Error).message}`);
    shutdown(1);
    return;
  }
  console.log(`${READY_PREFIX} ${JSON.stringify(state)}`);
  console.log(`[sandbox] open ${url}  ·  stop with \`pnpm sandbox stop\` (or Ctrl+C)`);
}

// pnpm forwards a literal "--" when the caller used one to separate its own flags.
const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
if (command === "stop") await stop();
else if (command === "status") {
  const state = readState();
  if (state && isAlive(state.pid)) console.log(`${READY_PREFIX} ${JSON.stringify(state)}`);
  else console.log("[sandbox] no sandbox running");
} else await start(command === undefined ? [] : [command, ...rest]);
