import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp, type AppContext } from "./app.ts";
import type { Config } from "./config.ts";
import { createContext } from "./context.ts";
import { createHostedRunner } from "./hostedRunner.ts";
import { acceptsPeer } from "./http/addresses.ts";
import { removeServerFile, writeServerFile } from "./serverFile.ts";

const TRASH_PURGE_INTERVAL_MS = 60 * 60 * 1000;

export interface RunningServer {
  /** The bound port (differs from `config.port` when that was 0). */
  port: number;
  url: string;
  /** Stops pollers, closes the HTTP server (dropping open SSE streams) and the database. */
  close(): Promise<void>;
  /**
   * Registers what to do when a runner has updated itself and must be started again: the caller closes the server
   * and exits so that its service restarts it (integrations/machines/selfUpdate.ts).
   */
  onRestart(restart: () => void): void;
  /** What it runs on, for a board hosting a runner in its own process (hostedRunner.ts). */
  ctx: AppContext;
}

/**
 * Starts the full server: API, SSE, MCP, pollers and the built web app. Shared by the CLI (main.ts) and
 * the desktop shell, which runs the bundled server in a child process.
 */
export async function startServer(config: Config): Promise<RunningServer> {
  // Copied because the Origin guard reads the port per request and port 0 is only known after listen.
  const runtime: Config = { ...config };
  const ctx: ReturnType<typeof createContext> = createContext(runtime);
  // A board may also run tasks for another board, in a second server in this process; off unless the user lets it.
  if (runtime.role !== "runner") {
    ctx.hostedRunner = createHostedRunner({
      board: runtime,
      boardInstanceId: ctx.instanceId,
      boardServices: () => ctx.services,
      start: (runner) => startServer(runner),
      changed: () => ctx.bus.publish({ type: "runner.changed" }),
    });
    // Nothing is published when a setting changes; the runner's copy of the T3 token follows the board's from here.
    const update = ctx.services.settings.update.bind(ctx.services.settings);
    const hosted = ctx.hostedRunner;
    ctx.services.settings.update = (input) => {
      const result = update(input);
      if (input.t3Token !== undefined) hosted.syncT3Token();
      return result;
    };
  }
  const app = createApp(ctx);

  if (runtime.webDist && existsSync(runtime.webDist)) {
    app.use("/*", serveStatic({ root: runtime.webDist }));
    // SPA fallback for client-side routes.
    app.get("*", serveStatic({ root: runtime.webDist, path: "index.html" }));
  }

  const listen = (hostname: string) =>
    new Promise<Server>((resolve, reject) => {
      const s = serve({ fetch: app.fetch, port: runtime.port, hostname }, () => resolve(s as Server));
      s.once("error", reject);
      // Dropped before a byte is read: a peer from the public internet gets no answer, not even a 403.
      if (runtime.bind === "private") {
        s.on("connection", (socket) => {
          if (!acceptsPeer(socket)) socket.destroy();
        });
      }
    });
  // `private` listens on every interface, IPv6 too (a tailnet name resolves to both); `runtime.host` stays the
  // address local clients are told (server.json). A machine with IPv6 switched off gets IPv4 alone.
  const server = await (
    runtime.bind === "private"
      ? listen("::").catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EAFNOSUPPORT" && error.code !== "EADDRNOTAVAIL") throw error;
          return listen("0.0.0.0");
        })
      : listen(runtime.host)
  ).catch((error: unknown) => {
    ctx.db.close();
    throw error;
  });

  const address = server.address();
  runtime.port = typeof address === "object" && address ? address.port : runtime.port;
  // Runs a previous process left going can't be finished; flag them whether or not Autopilot runs now.
  ctx.services.autopilot.recover();
  ctx.services.attachments.sweep();
  // The trash keeps deleted tasks for the retention setting; past it they go for good, checked now and hourly.
  const purgeTrash = () => {
    try {
      ctx.services.tasks.purgeExpired();
    } catch (error) {
      console.error("Emptying the trash failed:", error);
    }
  };
  purgeTrash();
  const trashTimer = setInterval(purgeTrash, TRASH_PURGE_INTERVAL_MS).unref();
  ctx.services.projects.ensureGeneral();
  // After an update, installed copies of the board skill catch up with the app. A hosted runner leaves that to the
  // board it runs in, which installs the same skills into the same folders.
  if (!runtime.hostedBy) ctx.services.skillSync.syncAll();
  if (runtime.pollers) ctx.integrations.start();
  ctx.integrations.resumeImports();
  // Not a poller: it is how a task a machine holds stays the board's, so it runs whether or not the pollers do.
  if (runtime.role !== "runner") ctx.integrations.machineSync.start();
  const url = `http://${runtime.host}:${runtime.port}`;
  writeServerFile(runtime.homeDir, url);
  // Not awaited: the board is up whether or not its runner starts, which says why it didn't in Settings.
  void ctx.hostedRunner?.start();

  let closing: Promise<void> | null = null;
  return {
    port: runtime.port,
    url,
    onRestart: (restart) => ctx.integrations.runnerHost.onRestart(restart),
    ctx,
    close() {
      const stopBoard = () =>
        new Promise<void>((resolve) => {
          ctx.integrations.stop();
          clearInterval(trashTimer);
          removeServerFile(runtime.homeDir);
          server.close(() => {
            ctx.db.close();
            resolve();
          });
          // SSE streams never end on their own; without this close() waits for every open board tab.
          server.closeAllConnections();
        });
      // The runner it hosts first: it reads the board's settings as it stops.
      closing ??= (ctx.hostedRunner?.close() ?? Promise.resolve()).then(stopBoard, stopBoard);
      return closing;
    },
  };
}
