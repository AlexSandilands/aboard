import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.ts";
import type { Config } from "./config.ts";
import { createContext } from "./context.ts";
import { acceptsPeer } from "./http/addresses.ts";
import { removeServerFile, writeServerFile } from "./serverFile.ts";

const TRASH_PURGE_INTERVAL_MS = 60 * 60 * 1000;

export interface RunningServer {
  /** The bound port (differs from `config.port` when that was 0). */
  port: number;
  url: string;
  /** Stops pollers, closes the HTTP server (dropping open SSE streams) and the database. */
  close(): Promise<void>;
}

/**
 * Starts the full server: API, SSE, MCP, pollers and the built web app. Shared by the CLI (main.ts) and
 * the desktop shell, which runs the bundled server in a child process.
 */
export async function startServer(config: Config): Promise<RunningServer> {
  // Copied because the Origin guard reads the port per request and port 0 is only known after listen.
  const runtime: Config = { ...config };
  const ctx = createContext(runtime);
  const app = createApp(ctx);

  if (runtime.webDist && existsSync(runtime.webDist)) {
    app.use("/*", serveStatic({ root: runtime.webDist }));
    // SPA fallback for client-side routes.
    app.get("*", serveStatic({ root: runtime.webDist, path: "index.html" }));
  }

  const server = await new Promise<Server>((resolve, reject) => {
    // `private` listens on every interface; `runtime.host` stays the address local clients are told (server.json).
    const hostname = runtime.bind === "private" ? "0.0.0.0" : runtime.host;
    const s = serve({ fetch: app.fetch, port: runtime.port, hostname }, () => resolve(s as Server));
    s.once("error", reject);
    // Dropped before a byte is read: a peer from the public internet gets no answer, not even a 403.
    if (runtime.bind === "private") {
      s.on("connection", (socket) => {
        if (!acceptsPeer(socket)) socket.destroy();
      });
    }
  }).catch((error: unknown) => {
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
  // After an update, installed copies of the board skill catch up with the app.
  ctx.services.skillSync.syncAll();
  if (runtime.pollers) ctx.integrations.start();
  ctx.integrations.resumeImports();
  const url = `http://${runtime.host}:${runtime.port}`;
  writeServerFile(runtime.homeDir, url);

  let closing: Promise<void> | null = null;
  return {
    port: runtime.port,
    url,
    close() {
      closing ??= new Promise<void>((resolve) => {
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
      return closing;
    },
  };
}
