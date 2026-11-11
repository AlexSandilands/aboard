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

/** OpenAI and Google bill cache writes as plain input; cached input has its own rate. */
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
 * match their family. Haiku 5.5's higher rate past 100K-token prompts isn't modelled: transcripts don't say a
 * request's prompt size apart from its cache reads.
 */
export const MODEL_PRICES: Readonly<Record<string, Required<ModelPrice>>> = {
  // Anthropic, from the Claude API pricing table.
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
  "claude-sonnet-5-5": claude(2, 10, 0.2),
  "claude-sonnet-5": claude(2, 10),
  "claude-sonnet-4-6": claude(3, 15),
  "claude-sonnet-4-5": claude(3, 15),
  "claude-sonnet-4": claude(3, 15),
  "claude-haiku-5-5": claude(0.1, 0.5),
  "claude-haiku-4-5": claude(1, 5),
  "claude-3-5-haiku": claude(0.8, 4),
  // OpenAI (Codex, Copilot), from OpenAI's API pricing page.
  "gpt-5.2": cachedInput(1.75, 14, 0.175),
  "gpt-5.1-codex-mini": cachedInput(0.25, 2, 0.025),
  "gpt-5.1": cachedInput(1.25, 10, 0.125),
  "gpt-5-codex": cachedInput(1.25, 10, 0.125),
  "gpt-5-mini": cachedInput(0.25, 2, 0.025),
  "gpt-5-nano": cachedInput(0.05, 0.4, 0.005),
  "gpt-5": cachedInput(1.25, 10, 0.125),
  "gpt-4.1-mini": cachedInput(0.4, 1.6, 0.1),
  "gpt-4.1": cachedInput(2, 8, 0.5),
  "gpt-4o-mini": cachedInput(0.15, 0.6, 0.075),
  "gpt-4o": cachedInput(2.5, 10, 1.25),
  "o4-mini": cachedInput(1.1, 4.4, 0.275),
  o3: cachedInput(2, 8, 0.5),
  // Google (Copilot), prompts up to 200K tokens.
  "gemini-2.5-pro": cachedInput(1.25, 10, 0.31),
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
