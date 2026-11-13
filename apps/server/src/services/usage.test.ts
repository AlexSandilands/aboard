import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_TOKEN_USAGE, type PriceTable, type TokenUsage } from "@repo/contracts";
import { openDatabase } from "../db/database.ts";
import { createRepos } from "../db/repos/index.ts";
import { claudeProjectSlug } from "../integrations/claudeSessionTitle.ts";
import type { T3ThreadUsage } from "../integrations/t3Usage.ts";
import { localDay } from "../integrations/usageFiles.ts";
import { createTestHarness } from "../test/harness.ts";
import { restoreBoard } from "./backup/restore.ts";
import { createCore } from "./core.ts";
import { createUsageService, type ModelPrices } from "./usage.ts";

const S1 = "709f26ed-ce2f-4449-b7eb-3bb01f89f268";
const S2 = "809f26ed-ce2f-4449-b7eb-3bb01f89f268";
const CWD = "/work/alpha";
const AT = "2026-11-10T12:00:00.000Z";
const DAY = localDay(AT)!;

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const message = (session: string, id: string, output: number, model = "claude-sonnet-5-5") =>
  `${JSON.stringify({
    type: "assistant",
    sessionId: session,
    requestId: `r-${id}`,
    timestamp: AT,
    message: { id, model, usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 100 } },
  })}\n`;

function setup(threads: Record<string, T3ThreadUsage> = {}, modelPrices?: ModelPrices) {
  const claudeDir = mkdtempSync(join(tmpdir(), "usage-svc-"));
  roots.push(claudeDir);
  const h = createTestHarness();
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: CWD });
  const plan = { phases: [{ title: "Do", steps: [{ title: "it" }] }] };
  const task = (title: string) => s.tasks.create({ projectId: project.id, title, plan });
  const folder = join(claudeDir, "projects", claudeProjectSlug(CWD));
  mkdirSync(folder, { recursive: true });
  const transcript = (session: string, body: string) => {
    const path = join(folder, `${session}.jsonl`);
    appendFileSync(path, body);
    return path;
  };
  const repos = createRepos(h.db);
  const core = createCore({ db: h.db, repos, bus: h.bus, t3Status: () => h.integrations.t3Status() });
  const usage = createUsageService(core, {
    dirs: { claudeDir, codexHome: join(claudeDir, "codex") },
    fetchThread: (id) => Promise.resolve(threads[id] ?? null),
    ...(modelPrices ? { modelPrices } : {}),
  });
  const linkSession = (taskId: string, sessionId: string, label?: string) =>
    s.links.add(
      taskId,
      { agentSession: { harness: "claude-code", sessionId, cwd: CWD }, ...(label ? { label } : {}) },
      "test",
    );
  const linkThread = (taskId: string, threadId: string, label?: string) =>
    s.links.add(taskId, { t3Thread: { environmentId: "env", threadId }, ...(label ? { label } : {}) }, "test");
  const stored = () => repos.sessionUsage.rowsBetween("2000-01-01", "3000-01-01");
  return { h, s, task, transcript, usage, linkSession, linkThread, stored, folder, repos };
}

const sum = (rows: Array<{ tokens: TokenUsage }>) =>
  rows.reduce((n, r) => n + r.tokens.input + r.tokens.output + r.tokens.cacheRead, 0);

describe("usage service", () => {
  it("prices rows from the fetched LiteLLM table and says so, overrides still first", () => {
    const fetched: PriceTable = {
      entries: [
        { key: "claude-sonnet-5-5", price: { input: 1, output: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1 } },
      ],
    };
    const source = { source: "litellm", asOf: AT, status: "cached" } as const;
    const { s, task, transcript, usage, linkSession } = setup({}, () => ({ table: fetched, source }));
    const a = task("A");
    transcript(S1, message(S1, "m1", 5));
    linkSession(a.id, S1);
    usage.scanSession({ harness: "claude-code", sessionId: S1, cwd: CWD });
    // 10 input + 5 output + 100 cache read, all at $1 per million.
    expect(usage.taskUsage(a.id)).toMatchObject({ costUsd: 115 / 1e6, prices: source });
    expect(usage.attributed("2000-01-01", "3000-01-01")[0]!.costUsd).toBeCloseTo(115 / 1e6);
    expect(usage.prices()).toEqual(source);
    s.settings.update({ modelPriceOverrides: { "claude-sonnet-5-5": { input: 2, output: 2, cacheRead: 2 } } });
    expect(usage.taskUsage(a.id)!.costUsd).toBeCloseTo(230 / 1e6);
    usage.stop();
  });

  it("stores a session shared by two tasks once, and shows it in full on both, marked shared", () => {
    const { s, task, transcript, usage, linkSession, stored } = setup();
    const a = task("A");
    const b = task("B");
    transcript(S1, message(S1, "m1", 5));
    linkSession(a.id, S1);
    linkSession(b.id, S1);
    usage.scanSession({ harness: "claude-code", sessionId: S1, cwd: CWD });
    expect(stored()).toHaveLength(1);
    const forA = usage.taskUsage(a.id)!;
    expect(forA.rows[0]).toMatchObject({ kind: "session", sharedWith: [b.number], costSource: "estimated" });
    expect(forA.tokens).toEqual({ ...EMPTY_TOKEN_USAGE, input: 10, output: 5, cacheRead: 100 });
    expect(usage.taskUsage(b.id)!.rows[0]!.sharedWith).toEqual([a.number]);
    usage.stop();
    void s;
  });

  it("adds nothing on a reread, only what was appended after", () => {
    const { task, transcript, usage, linkSession, stored } = setup();
    const a = task("A");
    linkSession(a.id, S1);
    transcript(S1, message(S1, "m1", 5));
    usage.scanSession({ harness: "claude-code", sessionId: S1 });
    expect(usage.scanSession({ harness: "claude-code", sessionId: S1 })).toBe(false);
    transcript(S1, message(S1, "m2", 7));
    usage.scanSession({ harness: "claude-code", sessionId: S1 });
    expect(sum(stored())).toBe(2 * 110 + 12);
    usage.stop();
  });

  it("replaces a truncated file's rows without touching its subagents'", () => {
    const { task, transcript, usage, linkSession, stored, folder } = setup();
    const a = task("A");
    linkSession(a.id, S1);
    const main = transcript(S1, message(S1, "m1", 5) + message(S1, "m2", 5));
    mkdirSync(join(folder, S1, "subagents"), { recursive: true });
    writeFileSync(join(folder, S1, "subagents", "agent-1.jsonl"), message(S1, "sub", 1));
    usage.scanSession({ harness: "claude-code", sessionId: S1 });
    writeFileSync(main, message(S1, "m3", 2));
    usage.scanSession({ harness: "claude-code", sessionId: S1 });
    const bySource = Object.fromEntries(stored().map((r) => [r.sourceFile, r.tokens.output]));
    expect(bySource).toEqual({ [`${S1}.jsonl`]: 2, "subagents/agent-1.jsonl": 1 });
    usage.stop();
  });

  it("stores a T3 thread and its self-linked session once, and falls back to T3's turns where there is no transcript", async () => {
    const thread: T3ThreadUsage = {
      providerThreads: [
        { id: "pt-1", driver: "claudeAgent", harness: "claude-code", nativeId: S1 },
        { id: "pt-2", driver: "opencode", harness: null, nativeId: null },
        { id: "pt-3", driver: "codex", harness: "codex", nativeId: "gone" },
      ],
      turns: new Map([
        ["pt-1", [{ day: DAY, model: "claude-sonnet-5-5", tokens: { ...EMPTY_TOKEN_USAGE, input: 999 } }]],
        ["pt-2", [{ day: DAY, model: "glm-4.6", tokens: { ...EMPTY_TOKEN_USAGE, input: 40 } }]],
        ["pt-3", [{ day: DAY, model: "gpt-5.2-codex", tokens: { ...EMPTY_TOKEN_USAGE, output: 3 } }]],
      ]),
    };
    const { task, transcript, usage, linkSession, linkThread, stored } = setup({ "thread-1": thread });
    const a = task("A");
    transcript(S1, message(S1, "m1", 5));
    linkThread(a.id, "thread-1");
    linkSession(a.id, S1);
    usage.scanSession({ harness: "claude-code", sessionId: S1 });
    await usage.scanThread("thread-1");
    await usage.scanThread("thread-1");
    // The Claude session from its transcript once (not T3's 999); the others from T3's turns.
    expect(
      stored()
        .map((r) => [r.harness, r.source, r.sourceFile])
        .sort((x, y) => x.join().localeCompare(y.join())),
    ).toEqual([
      ["claude-code", "transcript", `${S1}.jsonl`],
      ["t3", "t3_turn", "pt-2"],
      ["t3", "t3_turn", "pt-3"],
    ]);
    // One T3 row: the self-linked session is folded into its thread's.
    const rows = usage.taskUsage(a.id)!.rows;
    expect(rows.map((r) => [r.kind, r.harness])).toEqual([["thread", "t3"]]);
    // Each model line says what ran it: the Claude session from its transcript, the rest from T3's turns.
    expect(rows[0]!.models.map((m) => [m.harness, m.model, m.costUsd === null])).toEqual([
      ["claude-code", "claude-sonnet-5-5", false],
      ["t3", "glm-4.6", true],
      ["t3", "gpt-5.2-codex", false],
    ]);
    expect(rows[0]!.unpricedTokens).toBe(40);
    usage.stop();
  });

  describe("a T3 thread with the agent's own session linked behind it", () => {
    const behind = (...ids: string[]): T3ThreadUsage => ({
      providerThreads: ids.map((id, i) => ({
        id: `pt-${i}`,
        driver: "claudeAgent",
        harness: "claude-code" as const,
        nativeId: id,
      })),
      turns: new Map(),
    });

    it("shows one T3 row named by the session's label, with the thread's title kept and the totals unchanged", async () => {
      const { task, transcript, usage, linkSession, linkThread } = setup({ "thread-1": behind(S1) });
      const a = task("A");
      transcript(S1, message(S1, "m1", 5));
      linkSession(a.id, S1, "Planning #1");
      usage.scanSession({ harness: "claude-code", sessionId: S1 });
      const before = usage.taskUsage(a.id)!;
      expect(before.rows.map((r) => r.kind)).toEqual(["session"]);
      const thread = linkThread(a.id, "thread-1", "A long thread title");
      await usage.scanThread("thread-1");
      const after = usage.taskUsage(a.id)!;
      // Linked before its thread, the session is still folded into the thread's row.
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]).toMatchObject({
        kind: "thread",
        harness: "t3",
        key: "t3:thread-1",
        linkId: thread.id,
        label: "Planning #1",
        threadTitle: "A long thread title",
      });
      expect(after.tokens).toEqual(before.tokens);
      expect(after.costUsd).toBe(before.costUsd);
      usage.stop();
    });

    it("keeps a session no linked thread covers as a Claude Code row, and a thread not scanned yet leaves it in place", async () => {
      const { task, transcript, usage, linkSession, linkThread } = setup({ "thread-1": behind(S1) });
      const a = task("A");
      transcript(S1, message(S1, "m1", 5));
      transcript(S2, message(S2, "m2", 5));
      linkThread(a.id, "thread-1", "Thread");
      linkSession(a.id, S1, "Implementing #1");
      linkSession(a.id, S2, "Review");
      usage.scanSession({ harness: "claude-code", sessionId: S1 });
      usage.scanSession({ harness: "claude-code", sessionId: S2 });
      expect(usage.taskUsage(a.id)!.rows.map((r) => [r.harness, r.label])).toEqual([
        ["claude-code", "Implementing #1"],
        ["claude-code", "Review"],
      ]);
      await usage.scanThread("thread-1");
      expect(usage.taskUsage(a.id)!.rows.map((r) => [r.harness, r.label])).toEqual([
        ["t3", "Implementing #1"],
        ["claude-code", "Review"],
      ]);
      usage.stop();
    });

    it("names the row by the thread's title when the sessions behind it have different labels or none", async () => {
      const { task, transcript, usage, linkSession, linkThread } = setup({
        "thread-1": behind(S1, S2),
        "thread-2": behind("a09f26ed-ce2f-4449-b7eb-3bb01f89f268"),
      });
      const a = task("A");
      transcript(S1, message(S1, "m1", 5));
      transcript(S2, message(S2, "m2", 5));
      linkThread(a.id, "thread-1", "First thread");
      linkSession(a.id, S1, "Planning #1");
      linkSession(a.id, S2, "Implementing #1");
      linkThread(a.id, "thread-2", "Second thread");
      linkSession(a.id, "a09f26ed-ce2f-4449-b7eb-3bb01f89f268");
      transcript("a09f26ed-ce2f-4449-b7eb-3bb01f89f268", message("a09f26ed-ce2f-4449-b7eb-3bb01f89f268", "m3", 5));
      await usage.scanThread("thread-1");
      await usage.scanThread("thread-2");
      expect(usage.taskUsage(a.id)!.rows.map((r) => [r.kind, r.label, r.threadTitle])).toEqual([
        ["thread", "First thread", null],
        ["thread", "Second thread", null],
      ]);
      usage.stop();
    });

    it("marks the thread row shared with a task that links only the session behind it", async () => {
      const { task, transcript, usage, linkSession, linkThread } = setup({ "thread-1": behind(S1) });
      const a = task("A");
      const b = task("B");
      transcript(S1, message(S1, "m1", 5));
      linkThread(a.id, "thread-1");
      linkSession(a.id, S1);
      linkSession(b.id, S1);
      await usage.scanThread("thread-1");
      expect(usage.taskUsage(a.id)!.rows.map((r) => [r.kind, r.sharedWith])).toEqual([["thread", [b.number]]]);
      usage.stop();
    });
  });

  it("stores a run that keeps no transcript with its reported cost, and reads a run's transcript instead when it has one", () => {
    const { task, transcript, usage, linkSession, stored } = setup();
    const a = task("A");
    usage.recordRun({
      harness: "claude-code",
      sessionId: null,
      runId: "review-1",
      taskId: a.id,
      purpose: "review",
      model: null,
      usage: [{ model: "claude-sonnet-5-5", tokens: { ...EMPTY_TOKEN_USAGE, input: 3 } }],
      costUsd: 0.12,
      at: AT,
    });
    const run = usage.taskUsage(a.id)!.rows[0]!;
    expect(run).toMatchObject({ kind: "run", purpose: "review", costUsd: 0.12, costSource: "reported" });

    linkSession(a.id, S2);
    transcript(S2, message(S2, "m1", 4));
    usage.recordRun({
      harness: "claude-code",
      sessionId: S2,
      runId: "run-2",
      taskId: a.id,
      purpose: "start_planned",
      model: null,
      usage: [{ model: "claude-sonnet-5-5", tokens: { ...EMPTY_TOKEN_USAGE, input: 1_000 } }],
      costUsd: 5,
      at: AT,
    });
    expect(
      stored()
        .filter((r) => r.sessionId === S2)
        .map((r) => r.source),
    ).toEqual(["transcript"]);
    usage.stop();
  });

  it("keeps a session's usage when it is unlinked, and drops it with the last task that linked it", () => {
    const { s, task, transcript, usage, linkSession, stored } = setup();
    const a = task("A");
    linkSession(a.id, S1);
    transcript(S1, message(S1, "m1", 5));
    usage.scanSession({ harness: "claude-code", sessionId: S1 });
    s.tasks.delete([a.id], {}, "test");
    expect(stored()).toHaveLength(1);
    s.tasks.purge([a.id], "test");
    expect(stored()).toHaveLength(0);
    usage.stop();
  });

  it("purges only the purged task's sessions: an unlinked session elsewhere and a task-less run keep their rows", () => {
    const S3 = "909f26ed-ce2f-4449-b7eb-3bb01f89f268";
    const { s, task, transcript, usage, linkSession, stored } = setup();
    const a = task("A");
    const b = task("B");
    const link = linkSession(a.id, S1);
    transcript(S1, message(S1, "m1", 5));
    usage.scanSession({ harness: "claude-code", sessionId: S1 });
    s.links.remove(link.id, "test");
    linkSession(b.id, S2);
    transcript(S2, message(S2, "m2", 5));
    usage.scanSession({ harness: "claude-code", sessionId: S2 });
    // A task-less Autopilot run that keeps a transcript.
    transcript(S3, message(S3, "m3", 5));
    usage.recordRun({
      harness: "claude-code",
      sessionId: S3,
      runId: "improve-1",
      taskId: null,
      purpose: "improve",
      model: null,
      usage: [],
      costUsd: 1,
      at: AT,
    });
    expect(
      stored()
        .map((r) => r.sessionId)
        .sort(),
    ).toEqual([S1, S2, S3]);
    s.tasks.delete([b.id], {}, "test");
    s.tasks.purge([b.id], "test");
    expect(
      stored()
        .map((r) => r.sessionId)
        .sort(),
    ).toEqual([S1, S3]);
    usage.stop();
  });

  it("keeps a thread's session on its transcript rows once the file is cleaned up, never adding T3's turns too", async () => {
    const thread: T3ThreadUsage = {
      providerThreads: [{ id: "pt-1", driver: "claudeAgent", harness: "claude-code", nativeId: S1 }],
      turns: new Map([
        ["pt-1", [{ day: DAY, model: "claude-sonnet-5-5", tokens: { ...EMPTY_TOKEN_USAGE, input: 999 } }]],
      ]),
    };
    const { task, transcript, usage, linkSession, linkThread, stored } = setup({ "thread-1": thread });
    const a = task("A");
    const path = transcript(S1, message(S1, "m1", 5));
    linkThread(a.id, "thread-1");
    linkSession(a.id, S1);
    await usage.scanThread("thread-1");
    const before = sum(stored());
    rmSync(path);
    await usage.scanThread("thread-1");
    expect(stored().map((r) => r.source)).toEqual(["transcript"]);
    expect(sum(stored())).toBe(before);
    usage.stop();
  });

  it("puts a session an Autopilot run kept under that run's automation", () => {
    const { s, task, transcript, usage, linkSession, repos } = setup();
    const a = task("A");
    linkSession(a.id, S1);
    transcript(S1, message(S1, "m1", 5));
    usage.scanSession({ harness: "claude-code", sessionId: S1 });
    const run = s.autopilot.record({
      automation: "start_planned",
      candidate: { dedupeKey: "k", summary: "start it", projectId: a.projectId, taskId: a.id },
      dryRun: false,
    })!;
    repos.autopilotRuns.update({ ...repos.autopilotRuns.get(run.id)!, sessionId: S1.toUpperCase() });
    const [row] = usage.attributed("2000-01-01", "3000-01-01");
    expect(row).toMatchObject({ taskId: a.id, harness: "claude-code", purpose: "start_planned", autopilot: true });
    expect(row!.costUsd).toBeGreaterThan(0);
    usage.stop();
  });

  it("counts a session behind a linked T3 thread as T3 threads in stats, under the task that linked it first", async () => {
    const thread: T3ThreadUsage = {
      providerThreads: [{ id: "pt-1", driver: "claudeAgent", harness: "claude-code", nativeId: S1 }],
      turns: new Map(),
    };
    const { task, transcript, usage, linkSession, linkThread } = setup({ "thread-1": thread });
    const a = task("A");
    const b = task("B");
    transcript(S1, message(S1, "m1", 5));
    transcript(S2, message(S2, "m2", 5));
    // The agent linked its session to A before anyone linked the thread (to B).
    linkSession(a.id, S1, "Implementing #1");
    linkSession(a.id, S2);
    linkThread(b.id, "thread-1");
    usage.scanSession({ harness: "claude-code", sessionId: S2 });
    await usage.scanThread("thread-1");
    const bySession = Object.fromEntries(
      usage.attributed("2000-01-01", "3000-01-01").map((r) => [r.row.sessionId, [r.taskId, r.harness]]),
    );
    expect(bySession).toEqual({ [S1]: [a.id, "t3_thread"], [S2]: [a.id, "claude-code"] });
    usage.stop();
  });

  it("adds nothing when a restored board reads the same transcript again", () => {
    const { h, s, task, transcript, usage, linkSession, stored, folder } = setup();
    const a = task("A");
    linkSession(a.id, S1);
    transcript(S1, message(S1, "m1", 5));
    usage.scanSession({ harness: "claude-code", sessionId: S1 });
    const dir = mkdtempSync(join(tmpdir(), "usage-restore-"));
    roots.push(dir);
    const dbPath = join(dir, "data.sqlite");
    restoreBoard(dbPath, s.backup.dump());
    const db = openDatabase(dbPath);
    try {
      const repos = createRepos(db);
      const core = createCore({ db, repos, bus: h.bus, t3Status: () => h.integrations.t3Status() });
      const restored = createUsageService(core, { dirs: { claudeDir: join(folder, "..", ".."), codexHome: dir } });
      expect(restored.scanSession({ harness: "claude-code", sessionId: S1 })).toBe(false);
      expect(repos.sessionUsage.rowsBetween("2000-01-01", "3000-01-01")).toEqual(stored());
      restored.stop();
    } finally {
      db.close();
    }
    usage.stop();
  });

  it("sweeps every linked session, archived tasks included", async () => {
    const { s, task, transcript, usage, linkSession, stored } = setup();
    const a = task("A");
    linkSession(a.id, S1);
    transcript(S1, message(S1, "m1", 5));
    s.tasks.update(a.id, { archived: true }, "test");
    await usage.sweep();
    expect(stored()).toHaveLength(1);
    usage.stop();
  });

  it("sweeps a linked thread again, so work done with no board open is counted", async () => {
    const turn = (input: number) => [{ day: DAY, model: "glm-4.6", tokens: { ...EMPTY_TOKEN_USAGE, input } }];
    const thread: T3ThreadUsage = {
      providerThreads: [
        { id: "pt-1", driver: "claudeAgent", harness: "claude-code", nativeId: S1 },
        { id: "pt-2", driver: "opencode", harness: null, nativeId: null },
      ],
      turns: new Map([["pt-2", turn(40)]]),
    };
    const { task, transcript, usage, linkThread, stored } = setup({ "thread-1": thread });
    const a = task("A");
    transcript(S1, message(S1, "m1", 5));
    linkThread(a.id, "thread-1");
    await usage.sweep();
    const first = sum(stored());

    // The thread worked again while no browser was connected: no live poll saw it.
    transcript(S1, message(S1, "m2", 7));
    thread.turns.set("pt-2", turn(100));
    await usage.sweep();
    // The provider's transcript grew by 10 + 7 + 100 and T3's turns by 60.
    expect(sum(stored())).toBe(first + 117 + 60);
    usage.stop();
  });
});

describe("get_task's usage line", () => {
  it("counts a thread with its agent's own session behind it as a T3 thread", async () => {
    const { usageLine } = await import("../mcp/format.ts");
    const id = (n: number) => `${n}09f26ed-ce2f-4449-b7eb-3bb01f89f268`;
    const behind = (sessionId: string): T3ThreadUsage => ({
      providerThreads: [{ id: "pt", driver: "claudeAgent", harness: "claude-code", nativeId: sessionId }],
      turns: new Map(),
    });
    // Shaped like #169: planning and implementing in T3 threads whose agents linked their sessions too, two
    // follow-up threads with nothing linked inside them, and two headless review sessions.
    const threads = { plan: behind(id(1)), impl: behind(id(2)), f1: behind(id(3)), f2: behind(id(4)) };
    const { task, transcript, usage, linkSession, linkThread } = setup(threads);
    const a = task("A");
    for (const n of [1, 2, 3, 4, 5, 6]) transcript(id(n), message(id(n), `m${n}`, 5));
    linkThread(a.id, "plan");
    linkSession(a.id, id(1), "Planning #1");
    linkThread(a.id, "impl");
    linkSession(a.id, id(2), "Implementing #1");
    linkSession(a.id, id(5));
    linkSession(a.id, id(6));
    linkThread(a.id, "f1");
    linkThread(a.id, "f2");
    for (const t of Object.keys(threads)) await usage.scanThread(t);
    for (const n of [5, 6]) usage.scanSession({ harness: "claude-code", sessionId: id(n) });
    const line = usageLine(usage.taskUsage(a.id));
    // Sources follow link order, so the planning thread comes first.
    expect(line).toContain("T3 threads 4, Claude Code 2");
    usage.stop();
  });

  it("says the cost, tokens, sources, sharing and what has no price", async () => {
    const { usageLine } = await import("../mcp/format.ts");
    expect(usageLine(null)).toBeNull();
    expect(
      usageLine({
        rows: [
          {
            key: "claude-code:s",
            kind: "session",
            harness: "claude-code",
            sessionId: "s",
            linkId: "l",
            label: null,
            threadTitle: null,
            source: "transcript",
            purpose: null,
            models: [],
            tokens: { ...EMPTY_TOKEN_USAGE, input: 100_000, cacheRead: 300_000 },
            costUsd: 1.5,
            costSource: "estimated",
            unpricedTokens: 0,
            sharedWith: [7],
            untracked: false,
            lastDay: null,
          },
        ],
        tokens: { ...EMPTY_TOKEN_USAGE, input: 100_000, cacheRead: 300_000 },
        costUsd: 1.5,
        costSource: "estimated",
        unpricedTokens: 54_000,
        prices: { source: "built_in", asOf: "2026-11-11", status: "unavailable" },
      }),
    ).toBe(
      "Usage: ~$1.50 API-equivalent · 400k tokens (75% of input from cache) · Claude Code 1 · sessions shared with #7 · 54k tokens on models with no price",
    );
  });
});
