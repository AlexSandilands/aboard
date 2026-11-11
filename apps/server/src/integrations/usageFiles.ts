import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { addTokenUsage, EMPTY_TOKEN_USAGE, type TokenUsage } from "@repo/contracts";

// Incremental reading of an append-only JSONL file for token usage (docs/features/token-usage.md): each read starts
// where the last one ended, takes only complete lines, and starts over when the file shrank or its bytes before the
// cursor changed (a rewrite), so nothing is counted twice.

/** Bytes before the cursor whose hash must still match for a read to carry on from it. */
const GUARD_BYTES = 64;
/** At most this much is read per call; the rest waits for the next scan. */
const MAX_READ_BYTES = 32 * 1024 * 1024;

/** Where a file was read up to, and the reader's own state at that point. */
export interface FileCursor<S> {
  offset: number;
  size: number;
  /** Hash of the GUARD_BYTES before `offset`. */
  guard: string;
  state: S;
}

/** Tokens for one local day and model. */
export interface UsageBucket {
  day: string;
  model: string;
  tokens: TokenUsage;
}

export interface UsageReader<S> {
  initial(): S;
  /** Reads one complete line, adding what it counts to `add`. Unexpected lines are skipped, never guessed at. */
  line(state: S, line: string, add: (day: string, model: string, tokens: TokenUsage) => void): S;
}

export interface FileRead<S> {
  buckets: UsageBucket[];
  cursor: FileCursor<S>;
  /** The file was read from the start because it shrank or was rewritten: replace what was stored from it. */
  restarted: boolean;
}

/** The local calendar day of an instant, YYYY-MM-DD; null for something that isn't a date. */
export function localDay(at: unknown): string | null {
  const date = typeof at === "string" || typeof at === "number" ? new Date(at) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A finite, non-negative whole number from untrusted JSON, else 0. */
export const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

export const tokens = (patch: Partial<TokenUsage>): TokenUsage => ({ ...EMPTY_TOKEN_USAGE, ...patch });

const hashOf = (bytes: Buffer): string => createHash("sha1").update(bytes).digest("hex");

function readRange(fd: number, start: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buffer, read, length - read, start + read);
    if (n === 0) break;
    read += n;
  }
  return buffer.subarray(0, read);
}

/** The file's size, or null when it isn't there. */
export function fileSize(path: string): number | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/**
 * Reads what was appended to `path` since `cursor`, through `reader`. Returns null when the file can't be read. A
 * file that is unchanged returns no buckets and the same cursor.
 */
export function readUsageFile<S>(
  path: string,
  cursor: FileCursor<S> | null,
  reader: UsageReader<S>,
): FileRead<S> | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = statSync(path).size;
    let start = 0;
    let state = reader.initial();
    let restarted = cursor !== null;
    if (cursor && cursor.offset <= size) {
      const guardStart = Math.max(0, cursor.offset - GUARD_BYTES);
      const guard = hashOf(readRange(fd, guardStart, cursor.offset - guardStart));
      if (guard === cursor.guard) {
        start = cursor.offset;
        state = cursor.state;
        restarted = false;
      }
    }
    const chunk = readRange(fd, start, Math.min(size - start, MAX_READ_BYTES));
    // Only up to the last newline: a line still being written is read whole next time.
    const end = chunk.lastIndexOf(0x0a) + 1;
    const totals = new Map<string, UsageBucket>();
    const add = (day: string, model: string, t: TokenUsage) => {
      const key = `${day}\u0000${model}`;
      const bucket = totals.get(key);
      if (bucket) bucket.tokens = addTokenUsage(bucket.tokens, t);
      else totals.set(key, { day, model, tokens: t });
    };
    if (end > 0) {
      for (const raw of chunk.subarray(0, end).toString("utf8").split("\n")) {
        const line = raw.trim();
        if (line) state = reader.line(state, line, add);
      }
    }
    const offset = start + end;
    const guardStart = Math.max(0, offset - GUARD_BYTES);
    return {
      buckets: [...totals.values()],
      cursor: { offset, size, guard: hashOf(readRange(fd, guardStart, offset - guardStart)), state },
      restarted,
    };
  } finally {
    closeSync(fd);
  }
}

/** Parses a JSON line to an object, or null. */
export function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const objectAt = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
