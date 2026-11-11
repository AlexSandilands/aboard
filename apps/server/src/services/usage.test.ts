import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_TOKEN_USAGE, type TokenUsage } from "@repo/contracts";
import { createRepos } from "../db/repos/index.ts";
import { claudeProjectSlug } from "../integrations/claudeSessionTitle.ts";
import type { T3ThreadUsage } from "../integrations/t3Usage.ts";
import { localDay } from "../integrations/usageFiles.ts";
import { createTestHarness } from "../test/harness.ts";
import { createCore } from "./core.ts";
import { createUsageService } from "./usage.ts";

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

function setup(threads: Record<string, T3ThreadUsage> = {}) {
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
  });
  const linkSession = (taskId: string, sessionId: string) =>
    s.links.add(taskId, { agentSession: { harness: "claude-code", sessionId, cwd: CWD } }, "test");
  const linkThread = (taskId: string, threadId: string) =>
    s.links.add(taskId, { t3Thread: { environmentId: "env", threadId } }, "test");
  const stored = () => repos.sessionUsage.rowsBetween("2000-01-01", "3000-01-01");
  return { h, s, task, transcript, usage, linkSession, linkThread, stored, folder, repos };
}

const sum = (rows: Array<{ tokens: TokenUsage }>) =>
  rows.reduce((n, r) => n + r.tokens.input + r.tokens.output + r.tokens.cacheRead, 0);

describe("usage service", () => {
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
    const rows = usage.taskUsage(a.id)!.rows;
    expect(rows.map((r) => r.kind)).toEqual(["session", "thread"]);
    expect(rows[1]!.models.map((m) => [m.model, m.costUsd === null])).toEqual([
      ["glm-4.6", true],
      ["gpt-5.2-codex", false],
    ]);
    expect(rows[1]!.unpricedTokens).toBe(40);
    usage.stop();
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
});
