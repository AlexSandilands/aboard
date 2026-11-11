import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexUsageFile, codexUsageReader } from "./codexUsage.ts";
import { localDay, readUsageFile, tokens } from "./usageFiles.ts";

const ID = "01a1b444-07cd-71e2-bee0-fb39cfbeac34";
const T = "2026-11-07T04:28:45.273Z";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-"));
  roots.push(dir);
  return dir;
};
const jsonl = (...entries: object[]) => entries.map((e) => `${JSON.stringify({ timestamp: T, ...e })}\n`).join("");
const context = (model: string) => ({ type: "turn_context", payload: { model } });
const usage = (input: number, cached: number, output: number, write = 0) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: write,
  output_tokens: output,
  reasoning_output_tokens: 3,
  total_tokens: input + output,
});
const record = (id: string, u: object) => ({ type: "token_usage_record", payload: { response_id: id, usage: u } });
const count = (total: object) => ({
  type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: total } },
});

function read(body: string) {
  const path = join(tmp(), `rollout-x-${ID}.jsonl`);
  writeFileSync(path, body);
  return readUsageFile(path, null, codexUsageReader)!.buckets;
}

describe("codex usage", () => {
  it("counts each response's record once, splitting cached input out, with the turn's model", () => {
    const buckets = read(
      jsonl(
        context("gpt-5.2-codex"),
        record("r1", usage(100, 60, 10, 5)),
        count(usage(100, 60, 10, 5)),
        record("r1", usage(100, 60, 10, 5)),
        context("gpt-5.1"),
        record("r2", usage(50, 0, 2)),
        count(usage(150, 60, 12, 5)),
      ),
    );
    expect(buckets).toEqual([
      {
        day: localDay(T),
        model: "gpt-5.2-codex",
        tokens: tokens({ input: 35, output: 10, cacheRead: 60, cacheWrite5m: 5 }),
      },
      { day: localDay(T), model: "gpt-5.1", tokens: tokens({ input: 50, output: 2 }) },
    ]);
  });

  it("falls back to the growth of the running total on rollouts without records, ignoring repeats", () => {
    const buckets = read(
      jsonl(context("gpt-5"), count(usage(100, 40, 10)), count(usage(100, 40, 10)), count(usage(300, 140, 25))),
    );
    expect(buckets).toEqual([
      { day: localDay(T), model: "gpt-5", tokens: tokens({ input: 160, output: 25, cacheRead: 140 }) },
    ]);
  });

  it("treats a total that went down as a fresh start", () => {
    const buckets = read(jsonl(context("gpt-5"), count(usage(100, 0, 10)), count(usage(20, 0, 1))));
    expect(buckets[0]!.tokens).toEqual(tokens({ input: 120, output: 11 }));
  });

  it("finds the rollout in sessions or, once archived, in archived_sessions, under the same source name", () => {
    const home = tmp();
    const name = `rollout-2026-11-07T17-28-39-${ID}.jsonl`;
    mkdirSync(join(home, "sessions", "2026", "11", "07"), { recursive: true });
    writeFileSync(join(home, "sessions", "2026", "11", "07", name), "");
    expect(codexUsageFile(home, ID)).toEqual({
      path: join(home, "sessions", "2026", "11", "07", name),
      sourceFile: name,
    });
    rmSync(join(home, "sessions"), { recursive: true });
    mkdirSync(join(home, "archived_sessions"));
    writeFileSync(join(home, "archived_sessions", name), "");
    expect(codexUsageFile(home, ID)).toEqual({ path: join(home, "archived_sessions", name), sourceFile: name });
    expect(codexUsageFile(home, "nope")).toBeNull();
  });
});
