import { z } from "zod";
import { PriceSource } from "./modelPricing.ts";

// Tokens agents spent on a task's sessions, threads and board runs, with an API-equivalent cost worked out from
// modelPricing.ts when read. See docs/features/token-usage.md.

const Count = z.number().int().nonnegative();

/**
 * Tokens in the board's normalised form. `input` is uncached input only; `output` includes reasoning. Claude prices
 * 1-hour cache writes higher than 5-minute ones, so they are kept apart; other providers' writes count as 5-minute.
 * `requests` is a provider's own billing unit (Copilot premium requests), shown as reported and never priced.
 */
export const TokenUsage = z.object({
  input: Count,
  output: Count,
  cacheRead: Count,
  cacheWrite5m: Count,
  cacheWrite1h: Count,
  requests: z.number().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const EMPTY_TOKEN_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

/** Every token, of every kind (requests are not tokens). */
export const totalTokens = (u: TokenUsage): number =>
  u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;

/** Input tokens of every kind: uncached, cache reads and cache writes. */
export const inputTokens = (u: TokenUsage): number => u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;

/** The share of input tokens served from cache, 0..1; null when there was no input. */
export function cacheReadShare(u: TokenUsage): number | null {
  const all = inputTokens(u);
  return all > 0 ? u.cacheRead / all : null;
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const requests =
    a.requests === undefined && b.requests === undefined ? undefined : (a.requests ?? 0) + (b.requests ?? 0);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    ...(requests === undefined ? {} : { requests }),
  };
}

/**
 * Where a stored usage row was read from. One source per session, in this order of preference: the harness's own
 * transcript, a T3 thread's per-turn usage when there is no transcript to read, then a headless run's JSON output.
 */
export const UsageSource = z.enum(["transcript", "t3_turn", "run_output"]);
export type UsageSource = z.infer<typeof UsageSource>;

/**
 * What ran: a CLI harness (agentSessions.ts), or `t3` for a T3 Code thread counted from its own turns because the
 * provider session behind it has no transcript the board can read.
 */
export const UsageHarness = z.enum(["claude-code", "codex", "copilot-cli", "t3"]);
export type UsageHarness = z.infer<typeof UsageHarness>;

/**
 * Why a board run spent tokens, for run_output rows: an Autopilot automation's id (review_prs, fix_prs, improve,
 * ...), or one of the board's own runs (review, import, ask, digest). Free text so a new automation needs no change.
 */
export const UsagePurpose = z.string().min(1);
export type UsagePurpose = z.infer<typeof UsagePurpose>;

/** reported: the harness said what it cost. estimated: tokens × the price table. unknown: no price for the model. */
export const CostSource = z.enum(["reported", "estimated", "unknown"]);
export type CostSource = z.infer<typeof CostSource>;

/** One model's share of a row. `model` is null when the source didn't say. */
export const UsageModelLine = z.object({
  model: z.string().nullable(),
  tokens: TokenUsage,
  /** Dollars for this model's tokens; null when it has no price. */
  costUsd: z.number().nonnegative().nullable(),
});
export type UsageModelLine = z.infer<typeof UsageModelLine>;

/** One line of a task's usage: a linked session or T3 thread, or a board run with no session to read. */
export const TaskUsageRow = z.object({
  /** `<harness>:<sessionId>`, stable across reads. */
  key: z.string(),
  kind: z.enum(["session", "thread", "run"]),
  harness: UsageHarness,
  sessionId: z.string(),
  /** The task link the row comes from, so the panel can open it; null for board runs. */
  linkId: z.string().nullable(),
  /** The link's label or the session's title; null when there is none. */
  label: z.string().nullable(),
  source: UsageSource,
  /** For board runs: what the run was for. */
  purpose: UsagePurpose.nullable(),
  models: z.array(UsageModelLine),
  tokens: TokenUsage,
  /** Priced dollars: the reported cost, or the estimate over the models that have a price. Null when none do. */
  costUsd: z.number().nonnegative().nullable(),
  costSource: CostSource,
  /** Tokens of models with no price, left out of costUsd. */
  unpricedTokens: Count,
  /** Other tasks that link the same session or thread, by number. */
  sharedWith: z.array(z.number().int()),
  /**
   * The board has no reader for the session's harness yet (Copilot CLI), so nothing is counted for it. The panel says
   * "not tracked" instead of showing zeros.
   */
  untracked: z.boolean(),
  /** When the row last saw usage (a day, YYYY-MM-DD, local). */
  lastDay: z.string().nullable(),
});
export type TaskUsageRow = z.infer<typeof TaskUsageRow>;

/** A task's usage: every linked session and thread in full (shared ones too), plus its board runs. */
export const TaskUsage = z.object({
  rows: z.array(TaskUsageRow),
  tokens: TokenUsage,
  costUsd: z.number().nonnegative().nullable(),
  /** reported only when every priced row was; estimated when any was estimated; unknown when nothing had a price. */
  costSource: CostSource,
  unpricedTokens: Count,
  /** Where the prices came from and as of when, for the "API-equivalent" footnote. */
  prices: PriceSource,
});
export type TaskUsage = z.infer<typeof TaskUsage>;
