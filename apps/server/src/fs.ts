import type { FsBrowseResult } from "@taskboard/contracts";
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AppError } from "./errors.ts";

/** Pseudo-path that lists drive roots on Windows. */
const DRIVES_PATH = "/";

function expandPath(raw: string): string {
  const path = raw.trim();
  if (!path) return homedir();
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return resolve(path);
}

let driveCache: { at: number; result: FsBrowseResult } | null = null;

/** Probing unmapped drive letters is slow on Windows (seconds), so results are cached for a minute. */
function listDrives(): FsBrowseResult {
  if (driveCache && Date.now() - driveCache.at < 60_000) return driveCache.result;
  const entries: FsBrowseResult["entries"] = [];
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (existsSync(root)) entries.push({ name: root.slice(0, 2), fullPath: root });
  }
  const result = { path: DRIVES_PATH, parentPath: null, entries };
  driveCache = { at: Date.now(), result };
  return result;
}

function isDirectory(dir: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Lists the sub-directories of `rawPath` for the folder picker: hidden (dot) directories are
 * skipped, `~` expands to the home directory, and on Windows "/" lists the drive roots.
 */
export function browseDirectory(rawPath: string | undefined, platform: NodeJS.Platform = process.platform): FsBrowseResult {
  const trimmed = (rawPath ?? "").trim();
  if (platform === "win32" && (trimmed === "/" || trimmed === "\\")) return listDrives();

  const path = expandPath(trimmed);
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new AppError("NOT_FOUND", `Folder not found: ${path}`);
  }
  if (!stats.isDirectory()) throw new AppError("VALIDATION", `Not a folder: ${path}`);

  let dirents: Dirent[];
  try {
    dirents = readdirSync(path, { withFileTypes: true });
  } catch (error) {
    throw new AppError("VALIDATION", `Cannot read folder: ${path}`, { reason: (error as NodeJS.ErrnoException).code });
  }
  const entries = dirents
    .filter((d) => !d.name.startsWith(".") && isDirectory(path, d))
    .map((d) => ({ name: d.name, fullPath: join(path, d.name) }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  const parent = dirname(path);
  const parentPath = parent !== path ? parent : platform === "win32" ? DRIVES_PATH : null;
  return { path, parentPath, entries };
}
