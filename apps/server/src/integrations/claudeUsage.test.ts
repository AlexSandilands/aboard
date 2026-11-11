import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeProjectSlug } from "./claudeSessionTitle.ts";
import { claudeUsageFiles, claudeUsageReader } from "./claudeUsage.ts";
import { localDay, readUsageFile, tokens } from "./usageFiles.ts";

const ID = "b76a4a91-3196-48df-a421-9a32d5ac9978";
const PARENT = "c76a4a91-3196-48df-a421-9a32d5ac9978";
const CWD = "/work/alpha";
const T = "2026-11-10T12:00:00.000Z";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One content-block line of an assistant message; Claude Code repeats the usage on each. */
const block = (msg: string, usage: object, over: object = {}) =>
  `${JSON.stringify({
    type: "assistant",
    sessionId: ID,
    requestId: `req-${msg}`,
    timestamp: T,
    message: { id: msg, model: "claude-opus-5-5", usage },
    ...over,
  })}\n`;
const usage = (output: number) => ({
  input_tokens: 2,
  output_tokens: output,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 30,
  cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
});

function setup() {
  const claudeDir = mkdtempSync(join(tmpdir(), "usage-"));
  roots.push(claudeDir);
  const folder = join(claudeDir, "projects", claudeProjectSlug(CWD));
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${ID}.jsonl`);
  writeFileSync(path, "");
  return { claudeDir, folder, path };
}

const read = (path: string, cursor: Parameters<typeof readUsageFile>[1] = null) =>
  readUsageFile(path, cursor as never, claudeUsageReader(ID))!;

describe("claude usage", () => {
  it("counts a message once although each content block repeats its usage, split by cache write lifetime", () => {
    const { path } = setup();
    appendFileSync(path, block("m1", usage(5)) + block("m1", usage(5)) + block("m1", usage(5)) + block("m2", usage(7)));
    const { buckets } = read(path);
    expect(buckets).toEqual([
      {
        day: localDay(T),
        model: "claude-opus-5-5",
        tokens: tokens({ input: 4, output: 12, cacheRead: 200, cacheWrite5m: 20, cacheWrite1h: 40 }),
      },
    ]);
  });

  it("carries on from the cursor, counting only the growth of a message split across reads", () => {
    const { path } = setup();
    appendFileSync(path, block("m1", usage(5)));
    const first = read(path);
    appendFileSync(path, block("m1", usage(9)) + block("m2", usage(1)));
    const second = read(path, first.cursor);
    expect(second.restarted).toBe(false);
    expect(second.buckets[0]!.tokens).toEqual(
      tokens({ input: 2, output: 5, cacheRead: 100, cacheWrite5m: 10, cacheWrite1h: 20 }),
    );
    // Nothing new: nothing counted.
    expect(read(path, second.cursor).buckets).toEqual([]);
  });

  it("reads only complete lines, leaving a half-written one for the next read", () => {
    const { path } = setup();
    const whole = block("m1", usage(5));
    appendFileSync(path, whole + block("m2", usage(7)).slice(0, 40));
    const first = read(path);
    expect(first.cursor.offset).toBe(Buffer.byteLength(whole));
    expect(first.buckets[0]!.tokens.output).toBe(5);
  });

  it("starts over when the file was rewritten or shrank", () => {
    const { path } = setup();
    appendFileSync(path, block("m1", usage(5)) + block("m2", usage(5)));
    const first = read(path);
    writeFileSync(path, block("m3", usage(3)));
    const second = read(path, first.cursor);
    expect(second.restarted).toBe(true);
    expect(second.buckets[0]!.tokens.output).toBe(3);
  });

  it("skips synthetic messages, other lines, and history a fork copied from another session", () => {
    const { path } = setup();
    appendFileSync(
      path,
      block("copied", usage(50), { sessionId: PARENT }) +
        block("s", usage(9), { message: { id: "s", model: "<synthetic>", usage: usage(9) } }) +
        `${JSON.stringify({ type: "user", sessionId: ID, message: { content: "usage" } })}\n` +
        "not json {\n" +
        block("m1", usage(1)),
    );
    expect(read(path).buckets.map((b) => b.tokens.output)).toEqual([1]);
  });

  it("buckets by local day and model", () => {
    const { path } = setup();
    appendFileSync(
      path,
      block("m1", usage(1)) +
        block("m2", usage(2), { timestamp: "2026-11-12T12:00:00.000Z" }) +
        block("m3", usage(3), { message: { id: "m3", model: "claude-haiku-5-5", usage: usage(3) } }),
    );
    expect(read(path).buckets.map((b) => [b.day, b.model, b.tokens.output])).toEqual([
      [localDay(T), "claude-opus-5-5", 1],
      [localDay("2026-11-12T12:00:00.000Z"), "claude-opus-5-5", 2],
      [localDay(T), "claude-haiku-5-5", 3],
    ]);
  });

  it("finds the transcript and its subagents' files, named relative to the session", () => {
    const { claudeDir, folder, path } = setup();
    mkdirSync(join(folder, ID, "subagents"), { recursive: true });
    writeFileSync(join(folder, ID, "subagents", "agent-a.jsonl"), "");
    writeFileSync(join(folder, ID, "subagents", "agent-a.meta.json"), "{}");
    expect(claudeUsageFiles(claudeDir, ID, CWD)).toEqual([
      { path, sourceFile: `${ID}.jsonl` },
      { path: join(folder, ID, "subagents", "agent-a.jsonl"), sourceFile: "subagents/agent-a.jsonl" },
    ]);
    expect(claudeUsageFiles(claudeDir, PARENT, CWD)).toEqual([]);
  });
});
