/**
 * `pnpm dev`'s server: `tsx watch` with stdin ignored. `concurrently` hands each child a stdin pipe nobody
 * writes to; on Windows `tsx watch` reads that pipe and the server it spawns, which inherits it, hangs
 * before loading any code, so the port never opens. `tsx watch` rather than `node --watch`, which also
 * restarts when a file is only read (NTFS last-access).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const child = spawn(process.execPath, [tsxCli, "watch", "--clear-screen=false", "src/main.ts"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  stdio: ["ignore", "inherit", "inherit"],
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
