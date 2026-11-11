import { z } from "zod";
import type { TokenUsage } from "./usage.ts";

// List prices per million tokens, for an API-equivalent estimate of what a session would cost at pay-as-you-go rates.
// Keyed by model only, never by harness: Copilot or T3 Code running a known model is priced the same way. The server
// fetches LiteLLM's price list (parseLiteLlmPrices); the table below is the offline fallback, and the user adds or
// corrects a model with the modelPriceOverrides setting. See docs/features/token-usage.md.

/** USD per million tokens. A cache rate left out of an override falls back to the input rate. */
export const ModelPrice = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite5m: z.number().nonnegative().optional(),
  cacheWrite1h: z.number().nonnegative().optional(),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

/** The user's prices by model name, which win over the table and match the same way. */
export const ModelPriceOverrides = z.record(z.string().trim().min(1), ModelPrice);
export type ModelPriceOverrides = z.infer<typeof ModelPriceOverrides>;

/** Where the prices in an estimate came from: LiteLLM's fetched list, or the built-in table below. */
export const PriceSourceKind = z.enum(["litellm", "built_in"]);
export type PriceSourceKind = z.infer<typeof PriceSourceKind>;

/**
 * The fetched list's state. fresh: fetched by this server run. cached: read from the copy on disk, or the last fetch
 * failed and that copy is still used. unavailable: no list was ever fetched, so the built-in table is used. off: the
 * user switched fetching off (modelPriceFetch).
 */
export const PriceFetchStatus = z.enum(["fresh", "cached", "unavailable", "off"]);
export type PriceFetchStatus = z.infer<typeof PriceFetchStatus>;

export const PriceSource = z.object({
  source: PriceSourceKind,
  /** The fetch time (ISO) for LiteLLM's list, the date MODEL_PRICES was checked (YYYY-MM-DD) for the built-in one. */
  asOf: z.string(),
  status: PriceFetchStatus,
});
export type PriceSource = z.infer<typeof PriceSource>;

/** GET /api/model-prices: the source estimates use now, and how the last fetch went. */
export const ModelPricesStatus = PriceSource.extend({
  /** How many model names the fetched list prices; null when there is none. */
  models: z.number().int().nonnegative().nullable(),
  /** When the last fetch failed (ISO), if it did after the last success. */
  lastFailedAt: z.string().nullable(),
});
export type ModelPricesStatus = z.infer<typeof ModelPricesStatus>;

/** When the table below was last checked against the providers' pricing pages. */
export const MODEL_PRICES_AS_OF = "2026-11-11";

/** Anthropic's cache multipliers: writes are 1.25× input for 5 minutes and 2× for an hour, reads 0.1× unless noted. */
const claude = (input: number, output: number, cacheRead = input * 0.1): Required<ModelPrice> => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
});

/**
 * OpenAI's GPT-6 and GPT-5.6 families charge cache writes: 1.25× input for 30 minutes and 2.5× for 12 hours. Codex
 * reports them as one count, which goes to cacheWrite5m, so the shorter write's rate prices it.
 */
const openai = (input: number, output: number, cacheRead: number): Required<ModelPrice> => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2.5,
});

/** Older OpenAI models and Google bill cache writes as plain input; cached input has its own rate. */
const cachedInput = (input: number, output: number, cacheRead: number): Required<ModelPrice> => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input,
  cacheWrite1h: input,
});

/**
 * Matched by the longest key the model name starts with, after lowercasing and dropping a bracketed suffix
 * (`claude-opus-5-5[1m]`) and a provider prefix (`anthropic/`, `openai.`). Dated ids (`claude-haiku-4-5-20251001`)
 * match their family, and so do word variants (`gpt-6-astra-law`), so a `-pro` model needs its own key. Long-context
 * rates (Haiku 5.5 past 100K-token prompts, OpenAI past 272K, Gemini 3.1 Pro past 200K) aren't modelled: transcripts
 * don't say a request's prompt size apart from its cache reads. Each entry is the standard tier's list price on the
 * providers' pricing pages as of MODEL_PRICES_AS_OF; a promotional price is used while it runs.
 */
export const MODEL_PRICES: Readonly<Record<string, Required<ModelPrice>>> = {
  // Anthropic (platform.claude.com/docs/en/about-claude/pricing). Fable and Mythos 5.1+ read cache at 0.025× input,
  // Opus and Sonnet 5.5 at 0.05×, the rest at 0.1×.
  "claude-fable-5-2": claude(8, 40, 0.2),
  "claude-mythos-5-2": claude(8, 40, 0.2),
  "claude-fable-5-1": claude(10, 50, 0.25),
  "claude-mythos-5-1": claude(10, 50, 0.25),
  "claude-fable-5": claude(10, 50, 1),
  "claude-mythos-5": claude(10, 50, 1),
  "claude-opus-5-5": claude(4, 20, 0.2),
  "claude-opus-5": claude(5, 25),
  "claude-opus-4-8": claude(5, 25),
  "claude-opus-4-7": claude(5, 25),
  "claude-opus-4-6": claude(5, 25),
  "claude-opus-4-5": claude(5, 25),
  "claude-opus-4-1": claude(15, 75),
  "claude-opus-4": claude(15, 75),
  "claude-sonnet-5-5": claude(2, 10, 0.1),
  "claude-sonnet-5": claude(2, 10),
  "claude-sonnet-4-6": claude(3, 15),
  "claude-sonnet-4-5": claude(3, 15),
  "claude-sonnet-4": claude(3, 15),
  "claude-haiku-5-5": claude(0.1, 0.5),
  "claude-haiku-4-5": claude(1, 5),
  "claude-3-5-haiku": claude(0.8, 4),
  // OpenAI (developers.openai.com/api/docs/pricing), used by Codex and Copilot. gpt-5.6-sol's is a promotional price
  // until 2026-11-30.
  "gpt-6-astra": openai(10, 50, 1),
  "gpt-6.1-sol": openai(2, 10, 0.1),
  "gpt-6.1-terra": openai(1, 5, 0.05),
  "gpt-6-sol": openai(2, 10, 0.2),
  "gpt-6-luna": openai(0.1, 0.5, 0.01),
  "gpt-5.6-sol": openai(4, 20, 0.4),
  "gpt-5.6-terra": openai(2, 12, 0.2),
  "gpt-5.6-luna": openai(0.2, 1.2, 0.02),
  "gpt-5.5-pro": cachedInput(30, 180, 30),
  "gpt-5.5": cachedInput(5, 30, 0.5),
  "gpt-5.4-pro": cachedInput(30, 180, 30),
  "gpt-5.4-mini": cachedInput(0.75, 4.5, 0.075),
  "gpt-5.4-nano": cachedInput(0.2, 1.25, 0.02),
  "gpt-5.4": cachedInput(2.5, 15, 0.25),
  "gpt-5.3-codex": cachedInput(1.75, 14, 0.175),
  "gpt-5.2-pro": cachedInput(21, 168, 21),
  "gpt-5.2": cachedInput(1.75, 14, 0.175),
  "gpt-5.1-codex-mini": cachedInput(0.25, 2, 0.025),
  "gpt-5.1": cachedInput(1.25, 10, 0.125),
  "gpt-5-codex": cachedInput(1.25, 10, 0.125),
  "gpt-5-pro": cachedInput(15, 120, 15),
  "gpt-5-mini": cachedInput(0.25, 2, 0.025),
  "gpt-5-nano": cachedInput(0.05, 0.4, 0.005),
  "gpt-5": cachedInput(1.25, 10, 0.125),
  "gpt-4.1-mini": cachedInput(0.4, 1.6, 0.1),
  "gpt-4.1": cachedInput(2, 8, 0.5),
  "gpt-4o-mini": cachedInput(0.15, 0.6, 0.075),
  "gpt-4o": cachedInput(2.5, 10, 1.25),
  "o4-mini": cachedInput(1.1, 4.4, 0.275),
  "o3-pro": cachedInput(20, 80, 20),
  o3: cachedInput(2, 8, 0.5),
  // Google (aistudio.google.com/docs/pricing), used by Copilot; prompts up to 200K tokens. Gemini 4 doubles on
  // 2026-12-01 and Gemini 3.6/3.8 Flash on 2027-01-01.
  "gemini-4-carbon": cachedInput(2, 10, 0.1),
  "gemini-4-argon": cachedInput(2, 10, 0.1),
  "gemini-3.8-flash": cachedInput(0.75, 3.75, 0.075),
  "gemini-3.6-flash": cachedInput(0.75, 3.75, 0.075),
  "gemini-3.5-flash-lite": cachedInput(0.3, 2.5, 0.03),
  "gemini-3.1-pro": cachedInput(2, 12, 0.2),
  "gemini-3.1-flash-lite": cachedInput(0.25, 1.5, 0.025),
  "gemini-3-flash": cachedInput(0.5, 3, 0.05),
  "gemini-2.5-pro": cachedInput(1.25, 10, 0.31),
  "gemini-2.5-flash-lite": cachedInput(0.1, 0.4, 0.01),
  "gemini-2.5-flash": cachedInput(0.3, 2.5, 0.075),
};

/** Models that are never billed, or whose bare family name doesn't say which generation's price applies. */
const UNPRICEABLE = new Set(["<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable"]);

/** `Anthropic/Claude-Opus-5-5[1m]` → `claude-opus-5-5`. */
export function normalizeModelName(model: string): string {
  let key = model.trim().toLowerCase();
  const bracket = key.indexOf("[");
  if (bracket !== -1) key = key.slice(0, bracket);
  const slash = key.lastIndexOf("/");
  if (slash !== -1) key = key.slice(slash + 1);
  // Bedrock-style vendor prefixes: anthropic.claude-…, openai.gpt-…
  return key.replace(/^(anthropic|openai|google)\./, "").trim();
}

/**
 * Whether `key` is `name` or a variant of it: a date (`-20251001`) or a word (`-codex`, `-latest`) may follow, but not
 * another version number, so `claude-opus-4` doesn't price `claude-opus-4-9` and `gpt-5` doesn't price `gpt-5.5`.
 */
function isVariantOf(key: string, name: string): boolean {
  if (!key.startsWith(name)) return false;
  const rest = key.slice(name.length);
  return rest === "" || /^[-@:](\d{8}(?!\d)|[a-z])/.test(rest);
}

/** Prices by normalised model name, normalised once when the table is built rather than on every lookup. */
export interface PriceTable {
  readonly entries: ReadonlyArray<{ readonly key: string; readonly price: Required<ModelPrice> }>;
}

function toPriceTable(prices: Readonly<Record<string, Required<ModelPrice>>>): PriceTable {
  return { entries: Object.entries(prices).map(([name, price]) => ({ key: normalizeModelName(name), price })) };
}

const BUILT_IN = toPriceTable(MODEL_PRICES);

/** The entry with the longest name `key` is a variant of. */
function longestMatch(table: PriceTable, key: string): { length: number; price: Required<ModelPrice> } | null {
  let best: { length: number; price: Required<ModelPrice> } | null = null;
  for (const entry of table.entries) {
    if (isVariantOf(key, entry.key) && (best === null || entry.key.length > best.length)) {
      best = { length: entry.key.length, price: entry.price };
    }
  }
  return best;
}

/** The providers whose LiteLLM entries are their own list prices; Azure, Bedrock and resellers list other prices. */
const FIRST_PARTY = new Set(["anthropic", "openai", "gemini"]);

// Rounded to 12 significant digits, so 2e-7 reads back as 0.2 and not 0.19999999999999998.
const perToken = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Number((value * 1_000_000).toPrecision(12))
    : null;

const samePrice = (a: Required<ModelPrice>, b: Required<ModelPrice>) =>
  a.input === b.input &&
  a.output === b.output &&
  a.cacheRead === b.cacheRead &&
  a.cacheWrite5m === b.cacheWrite5m &&
  a.cacheWrite1h === b.cacheWrite1h;

/**
 * LiteLLM's `model_prices_and_context_window.json` as a price table: first-party entries only, USD per token turned
 * into per million. An entry without an input or output rate is dropped, so cost is never understated; a missing cache
 * rate falls back to input. The 1-hour write takes Claude's `…_above_1hr` rate, else OpenAI's 12-hour one (Codex reports
 * one write count, which goes to cacheWrite5m, so that one is rarely used). Two entries that name the same model at
 * different prices drop it, and the built-in table prices it instead.
 */
export function parseLiteLlmPrices(document: unknown): PriceTable {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return { entries: [] };
  const byKey = new Map<string, Required<ModelPrice> | null>();
  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.litellm_provider !== "string" || !FIRST_PARTY.has(entry.litellm_provider)) continue;
    const input = perToken(entry.input_cost_per_token);
    const output = perToken(entry.output_cost_per_token);
    if (input === null || output === null) continue;
    const key = normalizeModelName(name);
    if (!key) continue;
    const cacheWrite5m = perToken(entry.cache_creation_input_token_cost) ?? input;
    const price: Required<ModelPrice> = {
      input,
      output,
      cacheRead: perToken(entry.cache_read_input_token_cost) ?? input,
      cacheWrite5m,
      cacheWrite1h:
        perToken(entry.cache_creation_input_token_cost_above_1hr) ??
        perToken(entry.cache_creation_input_token_cost_above_12hr) ??
        cacheWrite5m,
    };
    if (!byKey.has(key)) byKey.set(key, price);
    else {
      const held = byKey.get(key);
      if (held && !samePrice(held, price)) byKey.set(key, null);
    }
  }
  const entries: Array<PriceTable["entries"][number]> = [];
  for (const [key, price] of byKey) if (price) entries.push({ key, price });
  return { entries };
}

/**
 * The prices for a model; null when nothing knows it. The user's override wins outright. Otherwise the fetched list and
 * the built-in table are both searched and the longer match wins, the fetched one on a tie, so a `-pro` model the
 * fetched list lacks keeps its own built-in price instead of taking its base model's.
 */
export function resolveModelPrice(
  model: string | null,
  overrides: ModelPriceOverrides = {},
  fetched: PriceTable | null = null,
): Required<ModelPrice> | null {
  if (!model) return null;
  const key = normalizeModelName(model);
  if (!key || UNPRICEABLE.has(key)) return null;
  let override: ModelPrice | null = null;
  let overrideLength = -1;
  for (const [name, price] of Object.entries(overrides)) {
    const candidate = normalizeModelName(name);
    if (isVariantOf(key, candidate) && candidate.length > overrideLength) {
      override = price;
      overrideLength = candidate.length;
    }
  }
  if (override) {
    return {
      input: override.input,
      output: override.output,
      cacheRead: override.cacheRead ?? override.input,
      cacheWrite5m: override.cacheWrite5m ?? override.input,
      cacheWrite1h: override.cacheWrite1h ?? override.cacheWrite5m ?? override.input,
    };
  }
  const fromFetched = fetched ? longestMatch(fetched, key) : null;
  const fromBuiltIn = longestMatch(BUILT_IN, key);
  if (fromFetched && (!fromBuiltIn || fromFetched.length >= fromBuiltIn.length)) return fromFetched.price;
  return fromBuiltIn?.price ?? null;
}

/** Dollars at list prices, or null when the model has no price. Premium requests are never priced. */
export function estimateCostUsd(
  model: string | null,
  tokens: TokenUsage,
  overrides: ModelPriceOverrides = {},
  fetched: PriceTable | null = null,
): number | null {
  const price = resolveModelPrice(model, overrides, fetched);
  if (!price) return null;
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite5m * price.cacheWrite5m +
      tokens.cacheWrite1h * price.cacheWrite1h) /
    1_000_000
  );
}
