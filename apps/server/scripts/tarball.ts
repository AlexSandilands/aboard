/**
 * The headless server release: one tarball per platform holding the bundled server, a launcher and a pinned Node
 * runtime, so a remote machine needs only `curl` and `tar` to run it (docs/features/remote-machines.md). Built by
 * `pnpm --filter @repo/server bundle --tarballs [platform...]` after the bundle, into `apps/server/release/`.
 *
 * The server is plain JavaScript, so one bundle serves every platform; only the Node binary differs. Any machine with
 * `tar` can build all of them.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BRAND, brandEnv } from "../../../packages/contracts/src/brand.ts";
import {
  RUNNER_INSTALL_SCRIPT,
  SERVER_CHECKSUMS,
  SERVER_LAUNCHER_NAME as LAUNCHER_NAME,
  runnerInstallScript,
  serverReleaseName,
  type ServerPlatform,
} from "../../../packages/contracts/src/runnerInstall.ts";

/** The Node release every tarball carries. Bump it with the checksums below, from its SHASUMS256.txt. */
export const NODE_VERSION = "24.22.3";

/** SHA-256 of `node-v<NODE_VERSION>-<platform>.tar.gz`, pinned so a changed download fails the build. */
const NODE_SHA256: Record<ServerPlatform, string> = {
  "linux-x64": "061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2",
  "linux-arm64": "261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8",
  "darwin-arm64": "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd",
};

/**
 * `bin/<id>-server`: runs the bundled server on the bundled Node. It follows a symlink to itself (one in
 * `~/.local/bin`, say) to find `lib/`, and passes the path it was started by to the server as `<ID>_LAUNCHER`, so a
 * service installed through a stable symlink keeps pointing at it when the release behind it changes.
 */
export function launcherScript(): string {
  const launcherEnv = brandEnv("LAUNCHER");
  return `#!/bin/sh
# Starts the ${BRAND.name} server on the Node runtime shipped beside it.
set -e
case "$0" in
  /*) self="$0" ;;
  *) self="$(pwd)/$0" ;;
esac
target="$self"
while [ -L "$target" ]; do
  link="$(readlink "$target")"
  case "$link" in
    /*) target="$link" ;;
    *) target="$(dirname "$target")/$link" ;;
  esac
done
lib="$(cd "$(dirname "$target")/../lib" && pwd)"
${launcherEnv}="$self"
export ${launcherEnv}
# node:sqlite prints an experimental warning on every start.
NODE_NO_WARNINGS="\${NODE_NO_WARNINGS:-1}"
export NODE_NO_WARNINGS
exec "$lib/node" "$lib/server.mjs" "$@"
`;
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${result.error?.message ?? result.status})`);
}

/** The Node archive for a platform, downloaded once into `cacheDir` and checked against its pinned checksum. */
async function nodeArchive(platform: ServerPlatform, cacheDir: string): Promise<string> {
  const name = `node-v${NODE_VERSION}-${platform}.tar.gz`;
  const path = join(cacheDir, name);
  if (!existsSync(path) || sha256(path) !== NODE_SHA256[platform]) {
    mkdirSync(cacheDir, { recursive: true });
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}`;
    console.log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    const actual = sha256(path);
    if (actual !== NODE_SHA256[platform]) {
      rmSync(path);
      throw new Error(`${name} has checksum ${actual}, not the pinned ${NODE_SHA256[platform]}`);
    }
  }
  return path;
}

/**
 * Builds a tarball per platform from the bundle in `distDir` (server.mjs and migrations) and writes their checksums.
 * Returns the tarball paths.
 */
export async function buildServerTarballs(options: {
  distDir: string;
  outDir: string;
  cacheDir: string;
  version: string;
  platforms: readonly ServerPlatform[];
}): Promise<string[]> {
  const { distDir, outDir, cacheDir, version, platforms } = options;
  if (!existsSync(join(distDir, "server.mjs"))) throw new Error(`no bundle in ${distDir}; run the bundle first`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), `${LAUNCHER_NAME}-tarball-`));
  const tarballs: string[] = [];
  try {
    for (const platform of platforms) {
      const archive = await nodeArchive(platform, cacheDir);
      const nodeDir = `node-v${NODE_VERSION}-${platform}`;
      const unpacked = join(work, `node-${platform}`);
      mkdirSync(unpacked);
      run("tar", ["-xzf", archive, "-C", unpacked, `${nodeDir}/bin/node`, `${nodeDir}/LICENSE`]);

      const name = serverReleaseName(version, platform);
      const root = join(work, name);
      mkdirSync(join(root, "bin"), { recursive: true });
      mkdirSync(join(root, "lib"));
      cpSync(join(distDir, "server.mjs"), join(root, "lib", "server.mjs"));
      cpSync(join(distDir, "migrations"), join(root, "lib", "migrations"), { recursive: true });
      cpSync(join(unpacked, nodeDir, "bin", "node"), join(root, "lib", "node"));
      cpSync(join(unpacked, nodeDir, "LICENSE"), join(root, "lib", "NODE-LICENSE"));
      chmodSync(join(root, "lib", "node"), 0o755);
      writeFileSync(join(root, "bin", LAUNCHER_NAME), launcherScript(), { mode: 0o755 });
      writeFileSync(join(root, "VERSION"), `${version}\n`);

      const tarball = join(outDir, `${name}.tar.gz`);
      run("tar", ["-czf", tarball, "-C", work, name]);
      tarballs.push(tarball);
      console.log(`built ${tarball}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  // The format `sha256sum -c` reads.
  const sums = tarballs.map((path) => `${sha256(path)}  ${basename(path)}\n`).join("");
  writeFileSync(join(outDir, SERVER_CHECKSUMS), sums);
  // Published beside the tarballs: what a machine runs to install a runner of this version by hand.
  writeFileSync(join(outDir, RUNNER_INSTALL_SCRIPT), runnerInstallScript(version), { mode: 0o755 });
  return tarballs;
}
