import { BRAND } from "@repo/contracts";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

/** Set when running as an Electron utilityProcess; the desktop shell talks to us over it. */
interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}
const parentPort = (process as { parentPort?: ParentPort }).parentPort;

const config = loadConfig();
const server = await startServer(config);
console.log(`[${BRAND.id}] listening on ${server.url}  (data: ${config.homeDir})`);
console.log(`[${BRAND.id}] MCP endpoint: ${server.url}/mcp`);

async function shutdown() {
  await server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

parentPort?.on("message", ({ data }) => {
  if (data === "shutdown") void shutdown();
});
// oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron MessagePortMain, not window.postMessage
parentPort?.postMessage({ type: "ready", url: server.url });
