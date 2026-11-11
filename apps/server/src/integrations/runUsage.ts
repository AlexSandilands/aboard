import type { TokenUsage } from "@repo/contracts";
import { codexTokens } from "./codexUsage.ts";
import { count, objectAt, parseLine, tokens } from "./usageFiles.ts";

// What a headless run's own JSON output says it used, for runs that keep no transcript (the board reviewer, issue
// import) or none the board reads (docs/features/token-usage.md, run_output).

/** One model's tokens in a run. `model` is null when the output doesn't name it (Codex): the run's own model then. */
export interface RunModelUsage {
  model: string | null;
  tokens: TokenUsage;
}

/**
 * Claude Code's `--output-format json` result: `modelUsage` per model (a run can use a second model for subagents
 * or tools). Its cache writes aren't split by lifetime there; the top-level `usage` has the split, so a one-model run
 * takes it from there.
 */
export function claudeRunUsage(result: unknown): RunModelUsage[] {
  const json = objectAt(result);
  const byModel = objectAt(json?.modelUsage);
  const top = objectAt(json?.usage);
  const split = objectAt(top?.cache_creation);
  const models = byModel ? Object.entries(byModel) : [];
  const usage = models.flatMap(([model, raw]): RunModelUsage[] => {
    const m = objectAt(raw);
    if (!m) return [];
    const writes = count(m.cacheCreationInputTokens);
    const oneHour = models.length === 1 && split ? Math.min(writes, count(split.ephemeral_1h_input_tokens)) : 0;
    return [
      {
        model,
        tokens: tokens({
          input: count(m.inputTokens),
          output: count(m.outputTokens),
          cacheRead: count(m.cacheReadInputTokens),
          cacheWrite5m: writes - oneHour,
          cacheWrite1h: oneHour,
        }),
      },
    ];
  });
  if (usage.length > 0 || !top) return usage;
  // Older CLIs: only the top-level usage, with no model.
  return [
    {
      model: null,
      tokens: tokens({
        input: count(top.input_tokens),
        output: count(top.output_tokens),
        cacheRead: count(top.cache_read_input_tokens),
        cacheWrite5m: split ? count(split.ephemeral_5m_input_tokens) : count(top.cache_creation_input_tokens),
        cacheWrite1h: split ? count(split.ephemeral_1h_input_tokens) : 0,
      }),
    },
  ];
}

/** `codex exec --json`: each `turn.completed` carries that turn's usage; Codex doesn't name the model there. */
export function codexRunUsage(stdout: string): RunModelUsage[] {
  let total: TokenUsage | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes("turn.completed")) continue;
    const event = parseLine(line);
    const usage = objectAt(event?.usage);
    if (event?.type !== "turn.completed" || !usage) continue;
    const t = codexTokens(usage);
    total = total
      ? tokens({
          input: total.input + t.input,
          output: total.output + t.output,
          cacheRead: total.cacheRead + t.cacheRead,
          cacheWrite5m: total.cacheWrite5m + t.cacheWrite5m,
        })
      : t;
  }
  return total ? [{ model: null, tokens: total }] : [];
}
