import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TokenUsage } from "@repo/contracts";
import { transcriptPath } from "./claudeSessionTitle.ts";
import { count, localDay, objectAt, parseLine, tokens, type UsageReader } from "./usageFiles.ts";

// Token usage from a Claude Code session's transcript and its subagents' (docs/features/token-usage.md). Claude Code
// writes one line per content block of an assistant message and repeats the message's usage on each, so a message is
// counted once, by message id and request id, from the last copy seen.

/** How many recent messages a read remembers, so a message whose lines straddle two reads isn't counted twice. */
const RECENT_MESSAGES = 64;

export interface ClaudeUsageState {
  /** Recent messages and what was counted for each: [key, counted tokens, day, model]. */
  recent: Array<[string, TokenUsage, string, string]>;
}

/** A session's usage files: its transcript and its subagents', each with a name relative to the session. */
export function claudeUsageFiles(
  claudeDir: string,
  sessionId: string,
  cwd: string | undefined,
): Array<{ path: string; sourceFile: string }> {
  const main = transcriptPath(claudeDir, sessionId, cwd);
  if (!main) return [];
  const files = [{ path: main, sourceFile: basename(main) }];
  const subagents = join(dirname(main), sessionId, "subagents");
  try {
    for (const name of readdirSync(subagents).sort()) {
      if (name.endsWith(".jsonl")) files.push({ path: join(subagents, name), sourceFile: `subagents/${name}` });
    }
  } catch {
    // No subagents.
  }
  return files;
}

function usageOf(raw: Record<string, unknown>): TokenUsage {
  const creation = objectAt(raw.cache_creation);
  const write1h = count(creation?.ephemeral_1h_input_tokens);
  // Older transcripts have only the total; it is all 5-minute writes then.
  const write5m = creation ? count(creation.ephemeral_5m_input_tokens) : count(raw.cache_creation_input_tokens);
  return tokens({
    input: count(raw.input_tokens),
    output: count(raw.output_tokens),
    cacheRead: count(raw.cache_read_input_tokens),
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
  });
}

const minus = (a: TokenUsage, b: TokenUsage): TokenUsage =>
  tokens({
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cacheWrite5m: Math.max(0, a.cacheWrite5m - b.cacheWrite5m),
    cacheWrite1h: Math.max(0, a.cacheWrite1h - b.cacheWrite1h),
  });

const larger = (a: TokenUsage, b: TokenUsage): TokenUsage =>
  tokens({
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite5m: Math.max(a.cacheWrite5m, b.cacheWrite5m),
    cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
  });

/**
 * Reads assistant messages of `sessionId`. Lines of another session are skipped: a forked or resumed session can
 * start with history copied from the one it came from, which that session's own transcript already counts.
 */
export function claudeUsageReader(sessionId: string): UsageReader<ClaudeUsageState> {
  return {
    initial: () => ({ recent: [] }),
    line(state, line, add) {
      if (!line.includes('"usage"')) return state;
      const entry = parseLine(line);
      if (!entry || entry.type !== "assistant") return state;
      if (typeof entry.sessionId === "string" && entry.sessionId.toLowerCase() !== sessionId.toLowerCase()) {
        return state;
      }
      const message = objectAt(entry.message);
      const usage = objectAt(message?.usage);
      const model = typeof message?.model === "string" ? message.model : "";
      if (!message || !usage || model === "<synthetic>") return state;
      const day = localDay(entry.timestamp);
      if (!day) return state;
      const id = typeof message.id === "string" ? message.id : null;
      const request = typeof entry.requestId === "string" ? entry.requestId : "";
      const seen = usageOf(usage);
      if (!id) {
        add(day, model, seen);
        return state;
      }
      const key = `${id}:${request}`;
      const recent = state.recent.filter(([k]) => k !== key);
      const before = state.recent.find(([k]) => k === key);
      // A later copy can carry more output than an earlier one (a block still streaming): count only the growth.
      const counted = before ? larger(before[1], seen) : seen;
      const delta = before ? minus(counted, before[1]) : seen;
      add(before?.[2] ?? day, before?.[3] ?? model, delta);
      recent.push([key, counted, before?.[2] ?? day, before?.[3] ?? model]);
      return { recent: recent.slice(-RECENT_MESSAGES) };
    },
  };
}
