/**
 * `pnpm dev`'s server: `tsx watch` with stdin ignored. `concurrently` hands each child a stdin pipe nobody
 * writes to; on Windows `tsx watch` reads that pipe and the server it spawns, which inherits it, hangs
 * before loading any code, so the port never opens. The cost: Return no longer re-runs the server. `tsx watch`
 * rather than `node --watch`, which also restarts when a file is only read (NTFS last-access).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const child = spawn(process.execPath, [tsxCli, "watch", "--clear-screen=false", "src/main.ts"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  stdio: ["ignore", "inherit", "inherit"],
});

// Ctrl+C (the process group) and concurrently's tree-kill usually signal `tsx watch` directly, and it
// force-kills the server on a repeat signal mid-shutdown, so forward only once its own 5 s grace has passed:
// by then it has exited unless the signal was aimed at this process alone (pnpm forwards to its script).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => setTimeout(() => child.kill(signal), 6000).unref());
}
child.on("exit", (code) => process.exit(code ?? 1));
