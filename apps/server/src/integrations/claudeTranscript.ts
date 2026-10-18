import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// A condensed view of a Claude Code transcript (`<claudeDir>/projects/<folder>/<id>.jsonl`), for an agent auditing how a
// task went: what was asked, what the agent concluded, which tools it ran and where it went wrong. The format isn't
// documented, so anything unexpected is skipped rather than guessed at.

/** The most characters one page of entries holds, so a long session is read in pages. */
export const PAGE_CHARS = 20_000;
const USER_CHARS = 1500;
const ASSISTANT_CHARS = 2000;
const TARGET_CHARS = 160;
const ERROR_CHARS = 300;

const REDACTED = "[redacted]";

/** Secrets by their shape. A transcript holds whatever the agent read, and a gateway may kill a session that echoes one. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // A PEM key block, to its end line or the end of the text. `[ ]` keeps the literal header out of this file.
  [/-{5}BEGIN [A-Z ]*PRIVATE[ ]KEY-{5}[\s\S]*?(?:-{5}END [A-Z ]*PRIVATE[ ]KEY-{5}|$)/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, REDACTED],
  // A name that says it holds a secret, then its value: `token=…`, `"apiKey": "…"`, `pair#token=…`.
  [
    /\b((?:[a-z]+[_-])*(?:token|secret|password|passwd|api[_-]?key|apikey|authorization|credentials?)["']?\s*[:=]\s*["']?)[^\s"',;&]{6,}/gi,
    `$1${REDACTED}`,
  ],
  // A pairing code or link is a credential: "pairing code: ABCD1234EFGH".
  [/\b(pair(?:ing)?[ _-]?(?:code|link|token)\W{0,4})[A-Za-z0-9#=_-]{8,}/gi, `$1${REDACTED}`],
  // Long runs of mixed-case letters and digits, such as base64 keys. Lower-case hex (a commit) is left alone.
  [/\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}\b/g, REDACTED],
];

/** The text with anything shaped like a secret replaced. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Redacted first, so a secret cut by the length limit can't leave its start behind; then on one line. */
function oneLine(text: string, max: number): string {
  const line = redact(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface TranscriptStats {
  /** Prompts the user (or the board, for a headless run) gave. */
  turns: number;
  toolCalls: number;
  errors: number;
  denials: number;
  /** A call repeated right after it failed, and API errors Claude Code retried. */
  retries: number;
  interruptions: number;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
}

export interface CondensedTranscript {
  /** One line per event, in order. */
  entries: string[];
  stats: TranscriptStats;
}

/** What a tool call was about, for its one line: the file, command, pattern or the like. */
const TARGET_KEYS = [
  "file_path",
  "path",
  "notebook_path",
  "command",
  "pattern",
  "url",
  "query",
  "skill",
  "task",
  "description",
  "to",
  "name",
];

function targetOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) return oneLine(value, TARGET_CHARS);
  }
  const first = Object.values(fields).find((v): v is string => typeof v === "string" && v.trim() !== "");
  return first ? oneLine(first, TARGET_CHARS) : "";
}

const DENIED_TEXT =
  /^(?:the user (?:doesn't|does not) want to proceed|permission (?:to use .+ )?(?:has been )?denied|the user rejected)/i;
const INTERRUPTED_TEXT = /^\[Request interrupted by user/;

interface Block {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

const blocksOf = (content: unknown): Block[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Block[]) : [];

function textOfResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join(" ");
}

interface Entry {
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  message?: { content?: unknown };
  permissionDecision?: { decision?: string };
}

/** Condenses a transcript's lines. Reads them one at a time, so a very large file isn't held in memory. */
export async function condenseTranscript(lines: AsyncIterable<string>): Promise<CondensedTranscript> {
  const entries: string[] = [];
  const stats: TranscriptStats = {
    turns: 0,
    toolCalls: 0,
    errors: 0,
    denials: 0,
    retries: 0,
    interruptions: 0,
    startedAt: null,
    endedAt: null,
    durationMs: null,
  };
  const calls = new Map<string, { name: string; target: string }>();
  // The assistant's last text since the user last spoke: the turn's final answer once the next prompt (or the end) comes.
  let pending = "";
  let lastFailed: string | null = null;

  const flush = () => {
    if (pending) entries.push(`[assistant] ${oneLine(pending, ASSISTANT_CHARS)}`);
    pending = "";
  };

  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      // A line being written right now.
      continue;
    }
    if (entry.isSidechain || (entry.type !== "user" && entry.type !== "assistant")) continue;
    if (entry.timestamp) {
      stats.startedAt ??= entry.timestamp;
      stats.endedAt = entry.timestamp;
    }

    if (entry.type === "assistant") {
      for (const block of blocksOf(entry.message?.content)) {
        if (block.type === "text" && block.text?.trim()) {
          if (entry.isApiErrorMessage) {
            stats.retries++;
            entries.push(`[retry] API error: ${oneLine(block.text, ERROR_CHARS)}`);
          } else pending = block.text;
        } else if (block.type === "tool_use" && block.name) {
          const target = targetOf(block.input);
          const key = `${block.name} ${target}`;
          const retry = key === lastFailed;
          if (retry) stats.retries++;
          lastFailed = null;
          stats.toolCalls++;
          if (block.id) calls.set(block.id, { name: block.name, target });
          entries.push(`[tool] ${key.trim()}${retry ? " (retry)" : ""}`);
        }
      }
      continue;
    }

    const content = blocksOf(entry.message?.content);
    let prompt = "";
    for (const block of content) {
      if (block.type === "tool_result") {
        if (!block.is_error) continue;
        const call = (block.tool_use_id && calls.get(block.tool_use_id)) || { name: "tool", target: "" };
        const message = textOfResult(block.content);
        const decision = entry.permissionDecision?.decision;
        const denied = (decision !== undefined && decision !== "accept") || DENIED_TEXT.test(message.trim());
        if (denied) stats.denials++;
        else stats.errors++;
        lastFailed = `${call.name} ${call.target}`;
        entries.push(
          denied
            ? `[denied] ${`${call.name} ${call.target}`.trim()}`
            : `[error] ${call.name}: ${oneLine(message, ERROR_CHARS)}`,
        );
      } else if (block.type === "text" && block.text && !block.text.startsWith("<system-reminder>")) {
        prompt += `${prompt ? "\n" : ""}${block.text}`;
      }
    }
    if (!prompt.trim() || entry.isMeta) continue;
    flush();
    if (INTERRUPTED_TEXT.test(prompt.trim())) {
      stats.interruptions++;
      entries.push(`[interrupted] ${oneLine(prompt, ERROR_CHARS)}`);
      continue;
    }
    stats.turns++;
    entries.push(`[user #${stats.turns}] ${oneLine(prompt, USER_CHARS)}`);
  }
  flush();

  if (stats.startedAt && stats.endedAt) {
    const ms = Date.parse(stats.endedAt) - Date.parse(stats.startedAt);
    stats.durationMs = Number.isFinite(ms) && ms >= 0 ? ms : null;
  }
  return { entries, stats };
}

/** Condenses a transcript file. */
export function condenseTranscriptFile(path: string): Promise<CondensedTranscript> {
  const stream = createReadStream(path, { encoding: "utf8" });
  return condenseTranscript(createInterface({ input: stream, crlfDelay: Infinity }));
}

export interface TranscriptPage {
  /** The page's entries, from `offset`. */
  lines: string[];
  offset: number;
  total: number;
  /** Where the next page starts, or null at the end. */
  next: number | null;
}

/** As many whole entries from `offset` as fit in `maxChars`, and always at least one. */
export function pageEntries(entries: string[], offset: number, maxChars: number = PAGE_CHARS): TranscriptPage {
  const start = Math.min(Math.max(0, Math.floor(offset)), entries.length);
  const lines: string[] = [];
  let size = 0;
  for (let i = start; i < entries.length; i++) {
    const line = entries[i] ?? "";
    if (lines.length > 0 && size + line.length + 1 > maxChars) break;
    lines.push(line);
    size += line.length + 1;
  }
  const end = start + lines.length;
  return { lines, offset: start, total: entries.length, next: end < entries.length ? end : null };
}
