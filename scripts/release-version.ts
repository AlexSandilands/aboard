/**
 * Checks a release tag and stamps its version into the root package.json, which BRAND (and so the app, the installer
 * names and the AUR package) reads. Releases are dated: `v2026.10.21`, with no leading zeros, because electron-builder
 * needs valid semver. Run by the release workflow before building: `node scripts/release-version.ts v2026.10.21`.
 * Prints the version without the `v`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TAG = /^v(\d{4})\.([1-9]\d?)\.([1-9]\d?)$/;

/** `v2026.10.21` → `2026.10.21`, or null for anything that isn't a real date in that form. */
export function releaseVersion(tag: string): string | null {
  const match = TAG.exec(tag);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? `${year}.${month}.${day}` : null;
}

if (import.meta.main) {
  const tag = process.argv[2] ?? "";
  const version = releaseVersion(tag);
  if (!version) {
    console.error(`"${tag}" isn't a release tag. Tag releases with the date, no leading zeros: v2026.10.21.`);
    process.exit(1);
  }
  const file = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  console.log(version);
}
