import { BRAND } from "@repo/contracts";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

/** Set when running as an Electron utilityProcess; the desktop shell talks to us over it. */
interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}
const parentPort = (process as { parentPort?: ParentPort }).parentPort;

const USAGE = `Usage:
  ${BRAND.id}-server [--runner]           start the server (--runner: the headless runner role, no web app)
  ${BRAND.id}-server service install       run the runner as a background service that survives logout
  ${BRAND.id}-server service uninstall     stop and remove that service
  ${BRAND.id}-server service status        whether the service is installed, running and answering
  ${BRAND.id}-server pair                  print a one-time code to pair this machine with a board
  ${BRAND.id}-server pair list             the board this machine is paired with
  ${BRAND.id}-server pair revoke <id>      unpair a board (--all: every board)
  ${BRAND.id}-server --version`;

async function start(args: string[]): Promise<void> {
  const config = loadConfig(process.env, args);
  const server = await startServer(config);
  const role = config.role === "runner" ? " as a runner" : "";
  console.log(`[${BRAND.id}] listening on ${server.url}${role}  (data: ${config.homeDir})`);
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
}

const args = process.argv.slice(2);
if (args[0] === "service") {
  const { runServiceCommand } = await import("./service/cli.ts");
  process.exitCode = await runServiceCommand(args.slice(1));
} else if (args[0] === "pair") {
  const { runPairCommand } = await import("./pairCli.ts");
  process.exitCode = runPairCommand(args.slice(1));
} else if (args.includes("--version")) {
  console.log(BRAND.version);
} else if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
} else if (args.every((arg) => arg === "--runner")) {
  await start(args);
} else {
  console.error(`Unknown arguments: ${args.join(" ")}\n\n${USAGE}`);
  process.exitCode = 2;
}
