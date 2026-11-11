import { describe, expect, it } from "vitest";
import { fetchThreadUsage, parseThreadUsage, t3TurnTokens } from "./t3Usage.ts";
import { localDay, tokens } from "./usageFiles.ts";

const CLAUDE = "B76A4A91-3196-48DF-A421-9A32D5AC9978";
const DONE = "2026-11-10T12:00:00.000Z";

/** A thread handed off from Claude Code to Codex, then forked onto OpenCode, which the board has no reader for. */
const snapshot = {
  snapshotSequence: 9,
  projection: {
    providerThreads: [
      {
        id: "pt-1",
        driver: "claudeAgent",
        nativeThreadRef: { driver: "claudeAgent", nativeId: CLAUDE, strength: "strong" },
      },
      { id: "pt-2", driver: "codex", nativeThreadRef: { driver: "codex", nativeId: "codex-1", strength: "strong" } },
      { id: "pt-3", driver: "opencode", nativeThreadRef: null, futureField: true },
      { driver: "broken" },
    ],
    runs: [{ id: "run-1", modelSelection: { instanceId: "x", model: "glm-4.6" } }],
    attempts: [{ id: "att-1", runId: "run-1" }],
    providerTurns: [
      {
        providerThreadId: "pt-3",
        runAttemptId: "att-1",
        completedAt: DONE,
        turnTokenUsage: {
          usageStatus: "complete",
          inputTokens: 100,
          cachedInputTokens: 60,
          cacheCreationTokens: 10,
          outputTokens: 7,
          reasoningTokens: 3,
          hasSubagents: false,
        },
      },
      {
        providerThreadId: "pt-3",
        runAttemptId: "att-1",
        models: ["glm-4.7"],
        completedAt: DONE,
        turnTokenUsage: { usageStatus: "partial", inputTokens: 5 },
      },
      { providerThreadId: "pt-3", completedAt: DONE, turnTokenUsage: { usageStatus: "unavailable" } },
      {
        providerThreadId: "pt-1",
        completedAt: DONE,
        turnTokenUsage: { usageStatus: "complete", inputTokens: 1, outputTokens: 1 },
      },
    ],
  },
};

describe("t3 thread usage", () => {
  it("lists every provider thread behind it, with the harness whose transcript holds it", () => {
    expect(parseThreadUsage(snapshot).providerThreads).toEqual([
      { id: "pt-1", driver: "claudeAgent", harness: "claude-code", nativeId: CLAUDE.toLowerCase() },
      { id: "pt-2", driver: "codex", harness: "codex", nativeId: "codex-1" },
      { id: "pt-3", driver: "opencode", harness: null, nativeId: null },
    ]);
  });

  it("sums turn usage per provider thread, day and model, taking cache reads and writes out of input", () => {
    const { turns } = parseThreadUsage(snapshot);
    expect(turns.get("pt-3")).toEqual([
      {
        day: localDay(DONE),
        model: "glm-4.6",
        tokens: tokens({ input: 30, output: 7, cacheRead: 60, cacheWrite5m: 10 }),
      },
      { day: localDay(DONE), model: "glm-4.7", tokens: tokens({ input: 5 }) },
    ]);
    expect(turns.get("pt-1")).toHaveLength(1);
  });

  it("reads nothing from a turn without usage, and nothing from a shape it doesn't know", () => {
    expect(t3TurnTokens(undefined)).toBeNull();
    expect(t3TurnTokens({ usageStatus: "complete", inputTokens: 0, outputTokens: 0 })).toBeNull();
    expect(parseThreadUsage(null)).toEqual({ providerThreads: [], turns: new Map() });
    expect(parseThreadUsage({ projection: { providerThreads: "nope" } }).providerThreads).toEqual([]);
  });

  it("fetches the thread with the board's token", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const usage = await fetchThreadUsage("http://t3", "tok", "thread:1", (url, init) => {
      calls.push([url, init]);
      return Promise.resolve(new Response(JSON.stringify(snapshot)));
    });
    expect(calls[0]![0]).toBe("http://t3/api/orchestration/threads/thread%3A1");
    expect((calls[0]![1]!.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(usage.providerThreads).toHaveLength(3);
    await expect(
      fetchThreadUsage("http://t3", "tok", "t", () => Promise.resolve(new Response("", { status: 404 }))),
    ).rejects.toThrow(/404/);
  });
});
