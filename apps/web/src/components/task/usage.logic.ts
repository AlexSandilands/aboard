import {
  AGENT_HARNESSES,
  cacheReadShare,
  totalTokens,
  type CostSource,
  type PriceSource,
  type TaskUsage,
  type TaskUsageRow,
  type TokenUsage,
  type UsageHarness,
  type UsageModelLine,
} from "@repo/contracts";

// Formatting for the panel's Usage section (docs/features/token-usage.md). Estimates carry a "~" so they never read
// as a bill; a reported cost has none; a model with no price says so rather than showing $0.

/** 1234 → "1.2k", 2_790_000 → "2.79M". */
export function formatTokens(n: number): string {
  if (n >= 1e9) return `${trim(n / 1e9, n >= 1e10 ? 0 : 2)}B`;
  if (n >= 1e6) return `${trim(n / 1e6, n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${trim(n / 1e3, n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** Fixed digits without trailing zeros after the point: 2.50 → "2.5", 310 → "310". */
const trim = (n: number, digits: number) => {
  const fixed = n.toFixed(digits);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
};

/** "~$5.03" for an estimate, "$0.38" for a reported cost, null when nothing had a price. */
export function formatCost(costUsd: number | null, source: CostSource): string | null {
  if (costUsd === null) return null;
  const amount = costUsd > 0 && costUsd < 0.01 ? "<$0.01" : `$${costUsd.toFixed(2)}`;
  return source === "estimated" ? `~${amount}` : amount;
}

/** The share of each kind of token, for the mix bar. Shares are 0..1 and add up to 1 when there are tokens. */
export const TOKEN_KINDS = [
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cacheRead", label: "Cache read" },
  { key: "cacheWrite", label: "Cache write" },
] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number]["key"];

export function tokenMix(t: TokenUsage): Array<{ key: TokenKind; label: string; tokens: number; share: number }> {
  const all = totalTokens(t);
  const of: Record<TokenKind, number> = {
    input: t.input,
    output: t.output,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite5m + t.cacheWrite1h,
  };
  return TOKEN_KINDS.map(({ key, label }) => ({ key, label, tokens: of[key], share: all > 0 ? of[key] / all : 0 }));
}

/** Rounds shares to whole percents that add up to 100, for the legend. */
export function percents(shares: readonly number[]): number[] {
  const raw = shares.map((s) => s * 100);
  const floors = raw.map(Math.floor);
  let left = Math.round(raw.reduce((a, b) => a + b, 0)) - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floors[i]! += 1;
    left -= 1;
  }
  return floors;
}

/**
 * The collapsed header's parts: the headline (the cost, or the tokens when nothing had a price) goes in a pill, the
 * rest beside it: "~$5.03" + "2.79M tok · 72% of input cached". Null when there is nothing to show.
 */
export interface UsageSummaryParts {
  headline: string;
  rest: string[];
}

export function usageSummaryParts(usage: TaskUsage | null): UsageSummaryParts | null {
  if (!usage || usage.rows.length === 0) return null;
  const parts: string[] = [];
  const cost = formatCost(usage.costUsd, usage.costSource);
  if (cost) parts.push(cost);
  const tokens = totalTokens(usage.tokens);
  if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
  const share = cacheReadShare(usage.tokens);
  if (share !== null && share >= 0.01) parts.push(`${Math.round(share * 100)}% of input cached`);
  const [headline, ...rest] = parts;
  return headline ? { headline, rest } : null;
}

/** The collapsed header's line as text: "~$5.03 · 2.79M tok · 72% of input cached". */
export function usageSummary(usage: TaskUsage | null): string {
  const parts = usageSummaryParts(usage);
  if (parts) return [parts.headline, ...parts.rest].join(" · ");
  return usage?.rows.some((r) => r.untracked) ? "Not tracked" : "None";
}

/** The line under the total: tokens, premium requests and what has no price. */
export function usageTotalDetail(usage: TaskUsage): string {
  const parts = [`${formatTokens(totalTokens(usage.tokens))} tokens`];
  if (usage.tokens.requests) parts.push(`${formatRequests(usage.tokens.requests)} premium req`);
  if (usage.unpricedTokens > 0) parts.push(`${formatTokens(usage.unpricedTokens)} unpriced`);
  return parts.join(" · ");
}

/** A fetch time as the local day it fell on, `2026-11-11`, matching the built-in table's date. */
const localDay = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Where an estimate's prices came from, for the panel's and the stats page's footnotes: "LiteLLM's list prices
 * (fetched 2026-11-11)", or the built-in table's date and why it is used.
 */
export function priceSourceText(prices: PriceSource): string {
  // Non-breaking hyphens, so a footnote never wraps in the middle of the date.
  const day = (d: string) => d.replaceAll("-", "\u2011");
  if (prices.source === "litellm") return `LiteLLM's list prices (fetched ${day(localDay(prices.asOf))})`;
  const why = prices.status === "off" ? "fetching is off" : "LiteLLM's list unavailable";
  return `the board's built-in list prices (as of ${day(prices.asOf)}; ${why})`;
}

const formatRequests = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const PURPOSES: Record<string, string> = {
  review: "Board review",
  import: "Issue import",
  ask: "Settings question",
  digest: "Digest",
};

/** What runs or holds a row, for its second line: "Claude Code", "T3 Code", "Board review". */
export function rowSource(row: TaskUsageRow): string {
  if (row.kind === "run") return PURPOSES[row.purpose ?? ""] ?? "Autopilot run";
  return harnessLabel(row.harness);
}

export function harnessLabel(harness: UsageHarness): string {
  return harness === "t3" ? "T3 Code" : AGENT_HARNESSES[harness].label;
}

/**
 * The provider a thread row's model line ran on ("Claude Code", "Codex"), so an expanded T3 row says what was behind
 * it. Null for other rows, which name their harness already, and for tokens counted from T3's own turns, which don't
 * say which provider ran them.
 */
export function modelProvider(
  row: TaskUsageRow,
  line: UsageModelLine,
): { harness: Exclude<UsageHarness, "t3">; label: string } | null {
  if (row.kind !== "thread" || line.harness === "t3") return null;
  return { harness: line.harness, label: harnessLabel(line.harness) };
}

/** The row's name: its link's label, else something to tell it by. */
export function rowName(row: TaskUsageRow, automationTitle: (key: string) => string | null = () => null): string {
  if (row.label) return row.label;
  if (row.kind === "run") return PURPOSES[row.purpose ?? ""] ?? automationTitle(row.purpose ?? "") ?? rowSource(row);
  if (row.kind === "thread") return "T3 Code thread";
  return `${harnessLabel(row.harness)} session ${row.sessionId.slice(0, 8)}`;
}

/** The model column: one model, the first plus how many more, or a dash when the source didn't say. */
export function rowModel(row: TaskUsageRow): string {
  const named = row.models.map((m) => m.model).filter((m): m is string => !!m);
  if (named.length === 0) return "—";
  return named.length === 1 ? named[0]! : `${named[0]} +${named.length - 1}`;
}

/** The cost column: the cost, "no price" when no model had one, or nothing for a session that isn't tracked. */
export function rowCost(row: TaskUsageRow): string {
  if (row.untracked) return "—";
  return formatCost(row.costUsd, row.costSource) ?? "no price";
}
