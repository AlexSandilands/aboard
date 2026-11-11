import { z } from "zod";
import type { TokenUsage } from "./usage.ts";

// List prices per million tokens, for an API-equivalent estimate of what a session would cost at pay-as-you-go rates.
// Keyed by model only, never by harness: Copilot or T3 Code running a known model is priced the same way. Nothing is
// fetched; the user adds or corrects a model with the modelPriceOverrides setting. See docs/features/token-usage.md.

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

function longestPrefix<T>(table: Readonly<Record<string, T>>, key: string): T | null {
  let best: { name: string; length: number } | null = null;
  for (const name of Object.keys(table)) {
    const candidate = normalizeModelName(name);
    if (isVariantOf(key, candidate) && (best === null || candidate.length > best.length)) {
      best = { name, length: candidate.length };
    }
  }
  return best === null ? null : table[best.name]!;
}

/** The prices for a model, the user's override first; null when neither knows it. */
export function resolveModelPrice(
  model: string | null,
  overrides: ModelPriceOverrides = {},
): Required<ModelPrice> | null {
  if (!model) return null;
  const key = normalizeModelName(model);
  if (!key || UNPRICEABLE.has(key)) return null;
  const override = longestPrefix(overrides, key);
  if (override) {
    return {
      input: override.input,
      output: override.output,
      cacheRead: override.cacheRead ?? override.input,
      cacheWrite5m: override.cacheWrite5m ?? override.input,
      cacheWrite1h: override.cacheWrite1h ?? override.cacheWrite5m ?? override.input,
    };
  }
  return longestPrefix(MODEL_PRICES, key);
}

/** Dollars at list prices, or null when the model has no price. Premium requests are never priced. */
export function estimateCostUsd(
  model: string | null,
  tokens: TokenUsage,
  overrides: ModelPriceOverrides = {},
): number | null {
  const price = resolveModelPrice(model, overrides);
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
