/**
 * Checks a release tag and stamps its version into the root package.json, which BRAND (and so the app, the installer
 * names and the Arch packages) reads. Releases are semver, `v1.4.2`: three numbers with no leading zeros and nothing
 * after them, because electron-builder needs valid semver and pacman can't take a `-` in a version. Run by the release
 * workflow before building: `node scripts/release-version.ts v1.4.2`. Prints the version without the `v`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NUMBER = "(?:0|[1-9]\\d*)";
const TAG = new RegExp(`^v(${NUMBER}\\.${NUMBER}\\.${NUMBER})$`);

/** The committed version, which marks a build from source (the app checks for no updates then), so never a release. */
const SOURCE_VERSION = "0.0.0";

/** `v1.4.2` → `1.4.2`, or null for anything that isn't `vMAJOR.MINOR.PATCH`. */
export function releaseVersion(tag: string): string | null {
  const version = TAG.exec(tag)?.[1];
  return version && version !== SOURCE_VERSION ? version : null;
}

if (import.meta.main) {
  const tag = process.argv[2] ?? "";
  const version = releaseVersion(tag);
  if (!version) {
    console.error(
      `"${tag}" isn't a release tag. Tag releases vMAJOR.MINOR.PATCH, with no leading zeros or suffix: v1.4.2.`,
    );
    process.exit(1);
  }
  const file = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  console.log(version);
}
