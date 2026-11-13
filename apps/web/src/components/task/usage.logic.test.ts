import { EMPTY_TOKEN_USAGE, type TaskUsage, type TaskUsageRow } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  formatCost,
  formatTokens,
  modelProvider,
  percents,
  rowCost,
  rowModel,
  rowName,
  rowSource,
  tokenMix,
  usageSummary,
  usageSummaryParts,
  usageTotalDetail,
  priceSourceText,
} from "./usage.logic";

const row = (over: Partial<TaskUsageRow> = {}): TaskUsageRow => ({
  key: "claude-code:s",
  kind: "session",
  harness: "claude-code",
  sessionId: "709f26ed-ce2f-4449-b7eb-3bb01f89f268",
  linkId: "l1",
  label: null,
  threadTitle: null,
  source: "transcript",
  purpose: null,
  models: [
    { harness: "claude-code", model: "claude-opus-5-5", tokens: { ...EMPTY_TOKEN_USAGE, input: 10 }, costUsd: 1 },
  ],
  tokens: { ...EMPTY_TOKEN_USAGE, input: 10 },
  costUsd: 1,
  costSource: "estimated",
  unpricedTokens: 0,
  sharedWith: [],
  untracked: false,
  lastDay: "2026-11-10",
  ...over,
});

const usage = (over: Partial<TaskUsage> = {}): TaskUsage => ({
  rows: [row()],
  tokens: { ...EMPTY_TOKEN_USAGE, input: 280_000, cacheRead: 720_000, output: 1_790_000 },
  costUsd: 5.031,
  costSource: "estimated",
  unpricedTokens: 0,
  prices: { source: "litellm", asOf: "2026-11-11T09:00:00.000Z", status: "fresh" },
  ...over,
});

describe("price source", () => {
  it("names LiteLLM with its fetch day, or the built-in table with its date and why", () => {
    const at = new Date(2026, 10, 11, 9).toISOString();
    expect(priceSourceText({ source: "litellm", asOf: at, status: "cached" })).toBe(
      "LiteLLM's list prices (fetched 2026\u201111\u201111)",
    );
    expect(priceSourceText({ source: "built_in", asOf: "2026-11-11", status: "unavailable" })).toBe(
      "the board's built-in list prices (as of 2026\u201111\u201111; LiteLLM's list unavailable)",
    );
    expect(priceSourceText({ source: "built_in", asOf: "2026-11-11", status: "off" })).toBe(
      "the board's built-in list prices (as of 2026\u201111\u201111; fetching is off)",
    );
  });
});

describe("usage formatting", () => {
  it("shortens token counts", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_234)).toBe("1.2k");
    expect(formatTokens(54_000)).toBe("54k");
    expect(formatTokens(310_000)).toBe("310k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatTokens(2_790_000)).toBe("2.79M");
    expect(formatTokens(23_000_000)).toBe("23M");
  });

  it("marks estimates with ~ and never shows an unpriced cost as $0", () => {
    expect(formatCost(5.031, "estimated")).toBe("~$5.03");
    expect(formatCost(0.38, "reported")).toBe("$0.38");
    expect(formatCost(0.001, "estimated")).toBe("~<$0.01");
    expect(formatCost(null, "unknown")).toBeNull();
    expect(rowCost(row({ costUsd: null, costSource: "unknown" }))).toBe("no price");
    expect(rowCost(row({ untracked: true }))).toBe("—");
  });

  it("summarises a collapsed section as cost, tokens and the cache-read share", () => {
    expect(usageSummary(usage())).toBe("~$5.03 · 2.79M tok · 72% of input cached");
    expect(usageSummary(null)).toBe("None");
    expect(usageSummary(usage({ rows: [row({ untracked: true })], tokens: EMPTY_TOKEN_USAGE, costUsd: null }))).toBe(
      "Not tracked",
    );
  });

  it("puts the cost in the collapsed header's pill, or the tokens when nothing had a price", () => {
    expect(usageSummaryParts(usage())).toEqual({ headline: "~$5.03", rest: ["2.79M tok", "72% of input cached"] });
    expect(usageSummaryParts(usage({ costUsd: null, costSource: "unknown" }))?.headline).toBe("2.79M tok");
    expect(
      usageSummaryParts(usage({ rows: [row({ untracked: true })], tokens: EMPTY_TOKEN_USAGE, costUsd: null })),
    ).toBeNull();
  });

  it("says what the total leaves out", () => {
    expect(usageTotalDetail(usage({ unpricedTokens: 54_000, tokens: { ...usage().tokens, requests: 4 } }))).toBe(
      "2.79M tokens · 4 premium req · 54k unpriced",
    );
  });

  it("splits the token mix into shares and whole percents that add up to 100", () => {
    const mix = tokenMix({ ...EMPTY_TOKEN_USAGE, input: 1, output: 1, cacheRead: 1 });
    expect(mix.map((m) => m.share.toFixed(3))).toEqual(["0.333", "0.333", "0.333", "0.000"]);
    expect(percents(mix.map((m) => m.share))).toEqual([34, 33, 33, 0]);
    expect(tokenMix(EMPTY_TOKEN_USAGE).every((m) => m.share === 0)).toBe(true);
  });

  it("names rows by their link, else by what ran them", () => {
    expect(rowName(row({ label: "Implementing #152" }))).toBe("Implementing #152");
    expect(rowName(row())).toBe("Claude Code session 709f26ed");
    expect(rowName(row({ kind: "thread", harness: "t3" }))).toBe("T3 Code thread");
    const review = row({ kind: "run", purpose: "review", linkId: null });
    expect(rowName(review)).toBe("Board review");
    expect(rowSource(review)).toBe("Board review");
    expect(rowName(row({ kind: "run", purpose: "review_prs" }), () => "Review PRs")).toBe("Review PRs");
  });

  it("names a thread row by the label of the agent's session behind it, and still says it ran in T3 Code", () => {
    const thread = row({ kind: "thread", harness: "t3", label: "Planning #169", threadTitle: "Plan the usage fix" });
    expect(rowName(thread)).toBe("Planning #169");
    expect(rowSource(thread)).toBe("T3 Code");
  });

  it("names the provider behind a thread on each model line, only where it is known", () => {
    const line = (harness: "claude-code" | "codex" | "t3") => ({
      harness,
      model: "m",
      tokens: EMPTY_TOKEN_USAGE,
      costUsd: null,
    });
    const thread = row({ kind: "thread", harness: "t3" });
    expect(modelProvider(thread, line("claude-code"))).toEqual({ harness: "claude-code", label: "Claude Code" });
    expect(modelProvider(thread, line("codex"))?.label).toBe("Codex");
    expect(modelProvider(thread, line("t3"))).toBeNull();
    expect(modelProvider(row(), line("claude-code"))).toBeNull();
  });

  it("shows one model, or the first and how many more", () => {
    expect(rowModel(row())).toBe("claude-opus-5-5");
    const two = row({
      models: [
        { harness: "claude-code", model: "a", tokens: EMPTY_TOKEN_USAGE, costUsd: null },
        { harness: "claude-code", model: "b", tokens: EMPTY_TOKEN_USAGE, costUsd: null },
      ],
    });
    expect(rowModel(two)).toBe("a +1");
    expect(rowModel(row({ models: [] }))).toBe("—");
  });
});
