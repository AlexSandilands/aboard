import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

// The title Claude Code keeps for a session, read from its own files, never generated: a name the user (or `--name`)
// gave it, else the one Claude wrote after the first exchange. Neither format is documented, so anything unexpected
// reads as no title.

/** How much of the transcript's start and end is searched. Claude appends its title lines again as the session grows. */
const CHUNK_BYTES = 128 * 1024;
const MAX_TITLE_LENGTH = 120;

/** The folder a session's transcripts are kept in: its working directory with every non-alphanumeric made a dash. */
export const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** `<claudeDir>/projects/<folder>/<sessionId>.jsonl`, found by the working directory or else by looking in each folder. */
function transcriptPath(claudeDir: string, sessionId: string, cwd: string | undefined): string | null {
  const root = join(claudeDir, "projects");
  const file = `${sessionId}.jsonl`;
  const exists = (path: string) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  };
  if (cwd) {
    const direct = join(root, claudeProjectSlug(cwd), file);
    if (exists(direct)) return direct;
  }
  // A long path gets a hash in its folder name, and a session may have moved: look everywhere.
  let folders: string[];
  try {
    folders = readdirSync(root);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const path = join(root, folder, file);
    if (exists(path)) return path;
  }
  return null;
}

function readChunk(path: string, start: number, length: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const tidy = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim();
  if (!title) return null;
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
};

/** The last title lines in a chunk of transcript: a name given to the session, and the one Claude wrote. */
function titlesIn(chunk: string): { custom: string | null; ai: string | null } {
  let custom: string | null = null;
  let ai: string | null = null;
  for (const line of chunk.split("\n")) {
    const isCustom = line.includes('"custom-title"');
    if (!isCustom && !line.includes('"ai-title"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; customTitle?: unknown; aiTitle?: unknown };
      if (entry.type === "custom-title") custom = tidy(entry.customTitle) ?? custom;
      else if (entry.type === "ai-title") ai = tidy(entry.aiTitle) ?? ai;
    } catch {
      // A line cut by the chunk's edge, or being written right now.
    }
  }
  return { custom, ai };
}

/** The title in a transcript file: a name the session was given wins over the one Claude generated. */
export function readTranscriptTitle(path: string): string | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  try {
    const tail = titlesIn(readChunk(path, Math.max(0, size - CHUNK_BYTES), Math.min(size, CHUNK_BYTES)));
    let { custom, ai } = tail;
    // A short session, or a name given early in a long one, can be only at the start.
    if (!custom && size > CHUNK_BYTES) {
      const head = titlesIn(readChunk(path, 0, CHUNK_BYTES));
      custom = head.custom;
      ai ??= head.ai;
    }
    return custom ?? ai;
  } catch {
    return null;
  }
}

export interface TitleReader {
  /** The session's title from its transcript, or null. Unchanged transcripts aren't read again. */
  read(sessionId: string, cwd: string | undefined): string | null;
}

/** How long a session with no transcript is left alone before its folders are searched again. */
export const MISSING_RETRY_MS = 5 * 60_000;

export function createTitleReader(claudeDir: string, now: () => number = Date.now): TitleReader {
  // Keyed by transcript path: what was read, and the file's size and time then.
  const cache = new Map<string, { size: number; mtimeMs: number; title: string | null }>();
  // Session ids whose transcript wasn't found, and when: searching every project folder each poll is wasteful.
  const missing = new Map<string, number>();
  return {
    read(sessionId, cwd) {
      const missedAt = missing.get(sessionId);
      if (missedAt !== undefined && now() - missedAt < MISSING_RETRY_MS) return null;
      const path = transcriptPath(claudeDir, sessionId, cwd);
      if (!path) {
        missing.set(sessionId, now());
        return null;
      }
      missing.delete(sessionId);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        return null;
      }
      const hit = cache.get(path);
      if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.title;
      const title = readTranscriptTitle(path);
      cache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, title });
      return title;
    },
  };
}
