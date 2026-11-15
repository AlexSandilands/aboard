/**
 * Bundles the server into one ESM file (`dist/server.mjs`) that runs on plain Node or an Electron
 * utilityProcess, with no tsx or node_modules at runtime. Migrations are copied next to it because
 * `openDatabase` reads them relative to its own module URL.
 *
 * `--tarballs [platform...]` then builds the headless server release from it (scripts/tarball.ts): every platform
 * when none is named.
 */
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { BRAND } from "../../../packages/contracts/src/brand.ts";
import { SERVER_PLATFORMS, isServerPlatform } from "../../../packages/contracts/src/runnerInstall.ts";
import { buildServerTarballs } from "./tarball.ts";

// pnpm forwards a literal "--" when the caller used one to separate its own flags.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const tarballs = args[0] === "--tarballs";
const platforms = tarballs ? args.slice(1) : [];
const unknown = tarballs ? platforms.find((arg) => !isServerPlatform(arg)) : args[0];
if (unknown !== undefined) {
  console.error(`unknown argument "${unknown}" (--tarballs [${SERVER_PLATFORMS.join(" | ")} ...])`);
  process.exit(2);
}

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

if (tarballs) {
  await buildServerTarballs({
    distDir: outdir,
    outDir: `${root}release`,
    cacheDir: `${root}node_modules/.cache/node-runtime`,
    version: BRAND.version,
    platforms: platforms.length > 0 ? platforms.filter(isServerPlatform) : SERVER_PLATFORMS,
  });
}
