import { describe, expect, it } from "vitest";
import { LITELLM_PRICES_FIXTURE } from "./fixtures/litellmPrices.ts";
import {
  estimateCostUsd,
  MODEL_PRICES,
  normalizeModelName,
  parseLiteLlmPrices,
  resolveModelPrice,
  type PriceTable,
} from "./modelPricing.ts";
import { addTokenUsage, cacheReadShare, EMPTY_TOKEN_USAGE, totalTokens, type TokenUsage } from "./usage.ts";

const tokens = (patch: Partial<TokenUsage>): TokenUsage => ({ ...EMPTY_TOKEN_USAGE, ...patch });
const M = 1_000_000;

describe("model prices", () => {
  it("normalises case, bracketed suffixes and provider prefixes", () => {
    expect(normalizeModelName("Claude-Opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(normalizeModelName("anthropic/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(normalizeModelName("anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("claude-haiku-4-5-20251001-v1:0");
  });

  it("matches the longest known name, including dated ids", () => {
    expect(resolveModelPrice("claude-opus-4-5-20251101")?.input).toBe(5);
    expect(resolveModelPrice("claude-opus-4-20250514")?.input).toBe(15);
    expect(resolveModelPrice("claude-haiku-4-5-20251001")?.input).toBe(1);
    expect(resolveModelPrice("claude-opus-5-5[1m]")?.cacheRead).toBe(0.2);
    expect(resolveModelPrice("gpt-5.1-codex")?.input).toBe(1.25);
    expect(resolveModelPrice("gpt-5.1-codex-mini")?.input).toBe(0.25);
    expect(resolveModelPrice("gpt-5.2-codex")?.output).toBe(14);
    expect(resolveModelPrice("gpt-6-astra-law")?.input).toBe(10);
    // A -pro model has its own, higher price, not its base model's.
    expect(resolveModelPrice("gpt-5.5-pro")?.input).toBe(30);
    expect(resolveModelPrice("gemini-3.1-pro-preview-customtools")?.input).toBe(2);
  });

  it("knows the current models of each provider, at their own cache-read rates", () => {
    expect(resolveModelPrice("claude-fable-5-2")).toMatchObject({ input: 8, output: 40, cacheRead: 0.2 });
    expect(resolveModelPrice("claude-sonnet-5-5")?.cacheRead).toBeCloseTo(0.1);
    expect(resolveModelPrice("gpt-6.1-sol")).toMatchObject({ input: 2, output: 10, cacheRead: 0.1 });
    expect(resolveModelPrice("gpt-6-astra")?.output).toBe(50);
    expect(resolveModelPrice("gpt-5.6-terra")?.output).toBe(12);
  });

  it("prices OpenAI's cache writes at the 30-minute rate", () => {
    expect(resolveModelPrice("gpt-6.1-sol")?.cacheWrite5m).toBeCloseTo(2.5);
    expect(resolveModelPrice("gpt-5.2")?.cacheWrite5m).toBeCloseTo(1.75);
  });

  it("never prices a newer version as an older one", () => {
    expect(resolveModelPrice("claude-opus-4-9")).toBeNull();
    expect(resolveModelPrice("gpt-5.7")).toBeNull();
    expect(resolveModelPrice("gpt-6.2-sol")).toBeNull();
    expect(resolveModelPrice("gpt-50")).toBeNull();
  });

  it("leaves unknown, synthetic and bare family names unpriced", () => {
    expect(resolveModelPrice("glm-4.6")).toBeNull();
    expect(resolveModelPrice("<synthetic>")).toBeNull();
    expect(resolveModelPrice("opus")).toBeNull();
    expect(resolveModelPrice(null)).toBeNull();
    expect(estimateCostUsd("glm-4.6", tokens({ input: M }))).toBeNull();
  });

  it("prices 1-hour cache writes above 5-minute ones for Claude", () => {
    const price = resolveModelPrice("claude-sonnet-4-6")!;
    expect(price.cacheWrite5m).toBeCloseTo(3.75);
    expect(price.cacheWrite1h).toBeCloseTo(6);
    expect(price.cacheRead).toBeCloseTo(0.3);
    expect(estimateCostUsd("claude-sonnet-4-6", tokens({ cacheWrite1h: M }))).toBeCloseTo(6);
  });

  it("adds up every kind of token", () => {
    const cost = estimateCostUsd(
      "claude-opus-5-5",
      tokens({ input: M, output: M, cacheRead: M, cacheWrite5m: M, cacheWrite1h: M, requests: 4 }),
    );
    expect(cost).toBeCloseTo(4 + 20 + 0.2 + 5 + 8);
  });

  it("lets an override add a model or correct one, defaulting cache rates to input", () => {
    const overrides = {
      "glm-4.6": { input: 0.6, output: 2.2 },
      "claude-opus-5-5": { input: 1, output: 2, cacheRead: 0.1 },
    };
    expect(resolveModelPrice("glm-4.6", overrides)).toEqual({
      input: 0.6,
      output: 2.2,
      cacheRead: 0.6,
      cacheWrite5m: 0.6,
      cacheWrite1h: 0.6,
    });
    expect(resolveModelPrice("claude-opus-5-5[1m]", overrides)?.input).toBe(1);
    expect(estimateCostUsd("glm-4.6", tokens({ input: M }), overrides)).toBeCloseTo(0.6);
  });

  it("never charges less for output, or more for a cache read, than for input", () => {
    const odd = Object.entries(MODEL_PRICES).filter(([, p]) => p.output < p.input || p.cacheRead > p.input);
    expect(odd).toEqual([]);
  });
});

const LITELLM = LITELLM_PRICES_FIXTURE;

describe("LiteLLM prices", () => {
  const table = parseLiteLlmPrices(LITELLM);
  const keys = table.entries.map((e) => e.key);
  const priceOf = (key: string) => table.entries.find((e) => e.key === key)?.price;

  it("reads first-party entries per million tokens, with their cache rates", () => {
    expect(priceOf("claude-opus-5-5")).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite5m: 5,
      cacheWrite1h: 8,
    });
    // Gemini lists no cache-write rate, so writes are billed as input.
    expect(priceOf("gemini-4-carbon")).toMatchObject({ input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2 });
  });

  it("maps Claude's 1-hour and OpenAI's 12-hour writes to cacheWrite1h", () => {
    expect(priceOf("claude-haiku-4-5")?.cacheWrite1h).toBeCloseTo(2);
    expect(priceOf("gpt-6.1-sol")).toMatchObject({ cacheWrite5m: 2.5, cacheWrite1h: 5 });
    // gpt-5.5 has neither: both writes fall back to input.
    expect(priceOf("gpt-5.5")).toMatchObject({ cacheWrite5m: 5, cacheWrite1h: 5 });
  });

  it("ignores resellers, cloud providers and the sample entry", () => {
    // replicate/google/gemini-4-carbon has no cache-read rate; it must not knock out or replace the first-party one.
    expect(priceOf("gemini-4-carbon")?.cacheRead).toBeCloseTo(0.1);
    expect(keys).not.toContain("sample_spec");
    expect(table.entries.filter((e) => e.key === "gpt-6.1-sol")).toHaveLength(1);
  });

  it("drops entries without an output rate, and names two entries price differently", () => {
    expect(keys).not.toContain("gpt-image-2");
    expect(keys).not.toContain("gemini-exp-1206");
  });

  it("reads nothing from a document that isn't an object of entries", () => {
    expect(parseLiteLlmPrices(null).entries).toEqual([]);
    expect(parseLiteLlmPrices([1, 2]).entries).toEqual([]);
    expect(parseLiteLlmPrices({ x: 1, y: { litellm_provider: "openai", input_cost_per_token: "1" } }).entries).toEqual(
      [],
    );
  });

  it("matches dated, bracketed and word-variant names, but never a newer version", () => {
    expect(resolveModelPrice("claude-opus-5-5[1m]", {}, table)?.cacheWrite1h).toBe(8);
    expect(resolveModelPrice("claude-haiku-4-5-20251001", {}, table)?.input).toBe(1);
    expect(resolveModelPrice("gpt-6-astra-law", {}, table)?.input).toBe(10);
    expect(resolveModelPrice("claude-opus-5-9", {}, table)).toBeNull();
    expect(resolveModelPrice("gpt-6.2-sol", {}, table)).toBeNull();
  });

  it("puts overrides first, then the fetched list, then the built-in table", () => {
    const fetched: PriceTable = {
      entries: [{ key: "gpt-5.4", price: { input: 9, output: 9, cacheRead: 9, cacheWrite5m: 9, cacheWrite1h: 9 } }],
    };
    expect(resolveModelPrice("gpt-5.4", {}, fetched)?.input).toBe(9);
    expect(resolveModelPrice("gpt-5.4", { "gpt-5.4": { input: 1, output: 1 } }, fetched)?.input).toBe(1);
    // A -pro model the fetched list lacks keeps its own built-in price instead of taking its base model's.
    expect(resolveModelPrice("gpt-5.4-pro", {}, fetched)?.input).toBe(30);
    // A model only the built-in table knows still has a price.
    expect(resolveModelPrice("o3", {}, fetched)?.input).toBe(2);
    expect(estimateCostUsd("gpt-5.4", tokens({ input: M }), {}, fetched)).toBeCloseTo(9);
  });
});

describe("token usage", () => {
  it("adds usage, keeping requests only where some were reported", () => {
    const a = tokens({ input: 1, cacheRead: 3 });
    expect(addTokenUsage(a, a)).toEqual(tokens({ input: 2, cacheRead: 6 }));
    expect(addTokenUsage(a, tokens({ requests: 2 })).requests).toBe(2);
    expect(totalTokens(tokens({ input: 1, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5 }))).toBe(15);
  });

  it("works out the cache-read share of input", () => {
    expect(cacheReadShare(tokens({ input: 10, cacheRead: 80, cacheWrite5m: 10 }))).toBeCloseTo(0.8);
    expect(cacheReadShare(tokens({ output: 5 }))).toBeNull();
  });
});
