import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { TokenUsage } from "@repo/contracts";
import { count, localDay, objectAt, parseLine, tokens, type UsageReader } from "./usageFiles.ts";

// Token usage from a Codex rollout (docs/features/token-usage.md). Newer rollouts write a token_usage_record per model
// response, with its response id; older ones only a running total on each token_count event, which can repeat, so
// those are counted as the growth of the total. Codex's input_tokens include the cached ones.

/** Response ids remembered across reads, so a record written twice isn't counted twice. */
const RECENT_RESPONSES = 256;

export interface CodexUsageState {
  /** The model of the latest turn_context; a session can switch model between turns. */
  model: string;
  /** Once a token_usage_record is seen, token_count totals are ignored: they'd count the same responses again. */
  records: boolean;
  seen: string[];
  /** The last token_count total, for the growth since it. */
  total: TokenUsage | null;
}

/**
 * The rollout file of a Codex session, in `sessions/YYYY/MM/DD/` or, once archived, `archived_sessions/`. Its name
 * (the same in both) is the source file, so archiving doesn't read it as a new file.
 */
export function codexUsageFile(codexHome: string, sessionId: string): { path: string; sourceFile: string } | null {
  const suffix = `-${sessionId.toLowerCase()}.jsonl`;
  const match = (name: string) => name.startsWith("rollout-") && name.toLowerCase().endsWith(suffix);
  const search = (dir: string, depth: number): string | null => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    // Newest folders first: a live session is usually in today's.
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      if (entry.isFile() && match(entry.name)) return join(dir, entry.name);
      if (entry.isDirectory() && depth > 0) {
        const found = search(join(dir, entry.name), depth - 1);
        if (found) return found;
      }
    }
    return null;
  };
  const path = search(join(codexHome, "sessions"), 3) ?? search(join(codexHome, "archived_sessions"), 0);
  return path ? { path, sourceFile: basename(path) } : null;
}

/** Codex usage in the board's form: uncached input is what's left after cache reads and writes. */
export function codexTokens(raw: Record<string, unknown>): TokenUsage {
  const cacheRead = count(raw.cached_input_tokens);
  const cacheWrite = count(raw.cache_write_input_tokens);
  return tokens({
    input: Math.max(0, count(raw.input_tokens) - cacheRead - cacheWrite),
    // Reasoning is part of output_tokens.
    output: count(raw.output_tokens),
    cacheRead,
    cacheWrite5m: cacheWrite,
  });
}

const growth = (now: TokenUsage, before: TokenUsage | null): TokenUsage => {
  if (!before) return now;
  const d = (k: keyof Omit<TokenUsage, "requests">) => now[k] - before[k];
  // A total that went down was reset (a new process): what it says now is all new.
  if ((["input", "output", "cacheRead", "cacheWrite5m"] as const).some((k) => d(k) < 0)) return now;
  return tokens({ input: d("input"), output: d("output"), cacheRead: d("cacheRead"), cacheWrite5m: d("cacheWrite5m") });
};

const isEmpty = (t: TokenUsage) => t.input + t.output + t.cacheRead + t.cacheWrite5m === 0;

export const codexUsageReader: UsageReader<CodexUsageState> = {
  initial: () => ({ model: "", records: false, seen: [], total: null }),
  line(state, line, add) {
    if (!line.includes('"turn_context"') && !line.includes("token_")) return state;
    const entry = parseLine(line);
    const payload = objectAt(entry?.payload);
    if (!entry || !payload) return state;
    if (entry.type === "turn_context") {
      return typeof payload.model === "string" ? { ...state, model: payload.model } : state;
    }
    const day = localDay(entry.timestamp);
    if (!day) return state;
    if (entry.type === "token_usage_record") {
      const usage = objectAt(payload.usage);
      const id = typeof payload.response_id === "string" ? payload.response_id : null;
      if (!usage || (id && state.seen.includes(id))) return { ...state, records: true };
      add(day, state.model, codexTokens(usage));
      return { ...state, records: true, seen: id ? [...state.seen, id].slice(-RECENT_RESPONSES) : state.seen };
    }
    if (entry.type === "event_msg" && payload.type === "token_count") {
      const total = objectAt(objectAt(payload.info)?.total_token_usage);
      if (!total) return state;
      const now = codexTokens(total);
      if (!state.records) {
        const delta = growth(now, state.total);
        if (!isEmpty(delta)) add(day, state.model, delta);
      }
      return { ...state, total: now };
    }
    return state;
  },
};
