import { describe, expect, it } from "vitest";
import { claudeRunUsage, codexRunUsage } from "./runUsage.ts";
import { tokens } from "./usageFiles.ts";

describe("run usage", () => {
  it("reads Claude Code's tokens per model, splitting cache writes by lifetime for a one-model run", () => {
    const result = {
      usage: { cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 30 } },
      modelUsage: {
        "claude-sonnet-5-5": {
          inputTokens: 5,
          outputTokens: 7,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 40,
          costUSD: 0.01,
        },
      },
    };
    expect(claudeRunUsage(result)).toEqual([
      {
        model: "claude-sonnet-5-5",
        tokens: tokens({ input: 5, output: 7, cacheRead: 100, cacheWrite5m: 10, cacheWrite1h: 30 }),
      },
    ]);
  });

  it("keeps several models apart, their writes as 5-minute ones, and falls back to the top-level usage", () => {
    const two = claudeRunUsage({
      modelUsage: { a: { inputTokens: 1, cacheCreationInputTokens: 4 }, b: { outputTokens: 2 } },
    });
    expect(two.map((u) => [u.model, u.tokens.cacheWrite5m, u.tokens.output])).toEqual([
      ["a", 4, 0],
      ["b", 0, 2],
    ]);
    expect(claudeRunUsage({ usage: { input_tokens: 3, cache_creation_input_tokens: 2 } })).toEqual([
      { model: null, tokens: tokens({ input: 3, cacheWrite5m: 2 }) },
    ]);
    expect(claudeRunUsage({ result: "x" })).toEqual([]);
  });

  it("sums Codex's turns", () => {
    const turn = (input: number) =>
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: input, cached_input_tokens: 10, output_tokens: 1 },
      });
    expect(codexRunUsage(`${turn(30)}\nnoise\n${turn(20)}\n`)).toEqual([
      { model: null, tokens: tokens({ input: 30, output: 2, cacheRead: 20 }) },
    ]);
    expect(codexRunUsage("")).toEqual([]);
  });
});
