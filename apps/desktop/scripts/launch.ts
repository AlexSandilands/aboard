/**
 * Builds the main process and opens Electron on it. `--dev` (used by `pnpm desktop`) loads the Vite
 * dev server and attaches to the API server `pnpm dev` runs alongside. Exits when the app quits.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { brandEnv } from "@repo/contracts";

const root = fileURLToPath(new URL("../", import.meta.url));
// Outside Electron the package exports the binary's path; its typings describe the in-app API.
const electron = createRequire(import.meta.url)("electron") as string;

await import("./build.ts");
const env = { ...process.env };
// Terminals inside Electron apps (T3 Code, VS Code) export this, which would start Electron as plain Node.
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes("--dev")) env[brandEnv("DEV_URL")] = "http://localhost:5317";

// Extra flags (e.g. --inspect) go before the app path so Electron itself sees them.
const child = spawn(electron, [...process.argv.slice(2).filter((arg) => arg !== "--dev"), root], {
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code ?? 0));
