/**
 * Bundles the server into one ESM file (`dist/server.mjs`) that runs on plain Node or an Electron
 * utilityProcess, with no tsx or node_modules at runtime. Migrations are copied next to it because
 * `openDatabase` reads them relative to its own module URL.
 */
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const outdir = `${root}dist`;

rmSync(outdir, { recursive: true, force: true });
await build({
  entryPoints: [`${root}src/main.ts`],
  outfile: `${outdir}/server.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Bundled CommonJS deps call require() for Node built-ins, which ESM output lacks.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "warning",
});
cpSync(`${root}src/db/migrations`, `${outdir}/migrations`, { recursive: true });
console.log(`bundled ${outdir}/server.mjs`);
