import type { IconCandidate } from "@repo/contracts";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { defaultRunGit, type RunGit } from "./integrations/backup.ts";

// Images already in a project's folder, offered by the icon picker. The scan only lists; the picker fetches a file
// and resizes it in the browser like an upload, so nothing is stored here.

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATES = 60;
const WALK_MAX_DEPTH = 4;
const WALK_MAX_ENTRIES = 5000;
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
/** Names that read as an icon, best first; the first pattern a file name matches sets its rank. */
const NAME_RANKS = [/favicon/, /logo/, /icon/, /brand/, /(^|[^a-z])mark([^a-z]|$)/];

const imageType = (path: string): string | undefined => IMAGE_TYPES[extname(path).toLowerCase()];

/** Lower is better: icon-like names, then shallower paths, then the rest alphabetically. */
function rankOf(path: string): [number, number, string] {
  const stem = basename(path, extname(path)).toLowerCase();
  const name = NAME_RANKS.findIndex((pattern) => pattern.test(stem));
  return [name === -1 ? NAME_RANKS.length : name, path.split("/").length, path];
}

function compareRanks(a: string, b: string): number {
  const [nameA, depthA, pathA] = rankOf(a);
  const [nameB, depthB, pathB] = rankOf(b);
  return nameA - nameB || depthA - depthB || (pathA < pathB ? -1 : pathA > pathB ? 1 : 0);
}

async function listWithGit(root: string, runGit: RunGit): Promise<string[] | null> {
  try {
    // Tracked plus untracked files that aren't ignored, relative to `root` even when it is a sub-folder of the repo.
    const result = await runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root);
    if (result.code !== 0) return null;
    return result.stdout.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/** Breadth-first so the shallow files, which rank first, are seen before the entry budget runs out. */
function listWithWalk(root: string): string[] {
  const files: string[] = [];
  let entries = 0;
  let level: string[] = [""];
  for (let depth = 0; depth <= WALK_MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let children;
      try {
        children = readdirSync(join(root, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (++entries > WALK_MAX_ENTRIES) return files;
        const path = dir ? `${dir}/${child.name}` : child.name;
        if (child.isDirectory()) {
          if (!SKIPPED_DIRS.has(child.name)) next.push(path);
        } else if (child.isFile()) {
          files.push(path);
        }
      }
    }
    level = next;
  }
  return files;
}

/**
 * The images in `root` the picker offers: png, jpeg, webp, gif, svg and ico files under 2 MB, icon-like names first,
 * at most 60. A git folder is listed by git, so ignored files are left out; any other folder is walked a few levels.
 */
export async function findIconCandidates(root: string, runGit: RunGit = defaultRunGit): Promise<IconCandidate[]> {
  const listed = (await listWithGit(root, runGit)) ?? listWithWalk(root);
  const found: IconCandidate[] = [];
  // Ranked before any stat, so a repo with thousands of images only touches the best few dozen.
  for (const path of listed.filter((p) => imageType(p)).sort(compareRanks)) {
    if (found.length >= MAX_CANDIDATES) break;
    try {
      // lstat, so a symlink (to a file outside the folder, say) is never a candidate.
      const stats = lstatSync(join(root, path));
      if (stats.isFile() && stats.size > 0 && stats.size <= MAX_BYTES) {
        found.push({ path, name: basename(path), bytes: stats.size });
      }
    } catch {
      // Listed by git but deleted since.
    }
  }
  return found;
}

// A picker shows up to 60 thumbnails, each of which asks for its file; a short cache keeps that from being 60 scans.
const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; found: Promise<IconCandidate[]> }>();

/** `findIconCandidates`, reused for a few seconds per folder. */
export function findIconCandidatesCached(root: string, runGit?: RunGit): Promise<IconCandidate[]> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.found;
  const found = findIconCandidates(root, runGit);
  cache.set(root, { at: Date.now(), found });
  // A failed scan shouldn't be remembered.
  found.catch(() => cache.delete(root));
  return found;
}

export interface IconFile {
  absolutePath: string;
  contentType: string;
}

/**
 * The file behind a candidate path, or null. Only a path the scan lists is served, and its real path must still be
 * inside `root` (a folder in the path could be a link out), so a request can't read anything else on the machine.
 */
export async function resolveIconFile(root: string, path: string): Promise<IconFile | null> {
  const contentType = imageType(path);
  if (!contentType) return null;
  const found = await findIconCandidatesCached(root);
  if (!found.some((candidate) => candidate.path === path)) return null;
  try {
    const realRoot = realpathSync(root);
    const absolutePath = realpathSync(join(root, path));
    const within = relative(realRoot, absolutePath);
    if (within === "" || isAbsolute(within) || within.split(sep)[0] === "..") return null;
    return { absolutePath, contentType };
  } catch {
    return null;
  }
}
