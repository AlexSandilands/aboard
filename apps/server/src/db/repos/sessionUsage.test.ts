import { EMPTY_TOKEN_USAGE, type TokenUsage } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../../test/harness.ts";
import { createRepos } from "./index.ts";
import type { UsageRow } from "./sessionUsage.ts";

const SESSION = "709f26ed-ce2f-4449-b7eb-3bb01f89f268";
const OTHER = "809f26ed-ce2f-4449-b7eb-3bb01f89f268";

function setup() {
  const h = createTestHarness();
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const plan = { phases: [{ title: "Do", steps: [{ title: "it" }] }] };
  const task = s.tasks.create({ projectId: project.id, title: "One", plan });
  const repo = createRepos(h.db).sessionUsage;
  const row = (over: Partial<Omit<UsageRow, "tokens">> & { tokens?: Partial<TokenUsage> } = {}): UsageRow => ({
    harness: "claude-code",
    sessionId: SESSION,
    sourceFile: `${SESSION}.jsonl`,
    day: "2026-11-10",
    model: "claude-opus-5-5",
    source: "transcript",
    taskId: null,
    purpose: null,
    reportedCostUsd: null,
    ...over,
    tokens: { ...EMPTY_TOKEN_USAGE, ...over.tokens },
  });
  return { h, s, task, repo, row, plan, project };
}

describe("session usage repo", () => {
  it("adds tokens into the same day and model bucket", () => {
    const { repo, row } = setup();
    repo.add([row({ tokens: { input: 1, output: 2 } }), row({ tokens: { input: 3, cacheRead: 5 } })]);
    repo.add([row({ day: "2026-11-11", tokens: { output: 7 } })]);
    const rows = repo.rowsForSessions([{ harness: "claude-code", sessionId: SESSION }]);
    expect(rows.map((r) => [r.day, r.tokens])).toEqual([
      ["2026-11-10", { ...EMPTY_TOKEN_USAGE, input: 4, output: 2, cacheRead: 5 }],
      ["2026-11-11", { ...EMPTY_TOKEN_USAGE, output: 7 }],
    ]);
  });

  it("replaces one file's rows without touching the session's other files", () => {
    const { repo, row } = setup();
    const key = { harness: "claude-code" as const, sessionId: SESSION };
    repo.add([row({ tokens: { input: 10 } }), row({ sourceFile: "subagents/a.jsonl", tokens: { input: 20 } })]);
    repo.replaceFile(key, `${SESSION}.jsonl`, [row({ tokens: { input: 1 } })]);
    expect(repo.rowsForSessions([key]).map((r) => [r.sourceFile, r.tokens.input])).toEqual([
      [`${SESSION}.jsonl`, 1],
      ["subagents/a.jsonl", 20],
    ]);
  });

  it("keeps a cursor with the reader's state", () => {
    const { repo } = setup();
    const key = { harness: "codex" as const, sessionId: SESSION };
    expect(repo.cursor(key, "f")).toBeNull();
    repo.setCursor(key, "f", { offset: 10, size: 12, state: { model: "gpt-5.2" } });
    repo.setCursor(key, "f", { offset: 12, size: 12, state: { model: "gpt-5.2-codex" } });
    expect(repo.cursor(key, "f")).toEqual({ offset: 12, size: 12, state: { model: "gpt-5.2-codex" } });
    expect(repo.cursorFiles(key)).toEqual(["f"]);
  });

  it("drops a purged task's sessions no other task links, and keeps everything else", () => {
    const { s, repo, row, task, plan, project } = setup();
    s.links.add(task.id, { agentSession: { harness: "claude-code", sessionId: SESSION, cwd: "/w" } }, "test");
    s.links.add(task.id, { t3Thread: { environmentId: "env", threadId: "thread-1" } }, "test");
    repo.setThreadSessions("thread-1", [{ harness: "codex", sessionId: "codex-1" }]);
    repo.setThreadSessions("thread-gone", [{ harness: "codex", sessionId: "codex-2" }]);
    const doomed = s.tasks.create({ projectId: project.id, title: "Two", plan });
    // The doomed task shares SESSION with the live one, and alone links OTHER and thread-gone.
    s.links.add(doomed.id, { agentSession: { harness: "claude-code", sessionId: SESSION, cwd: "/w" } }, "test");
    s.links.add(doomed.id, { agentSession: { harness: "claude-code", sessionId: OTHER, cwd: "/w" } }, "test");
    s.links.add(doomed.id, { t3Thread: { environmentId: "env", threadId: "thread-gone" } }, "test");
    repo.add([
      row(),
      row({ sessionId: OTHER, sourceFile: `${OTHER}.jsonl` }),
      row({ harness: "codex", sessionId: "codex-1", sourceFile: "r.jsonl" }),
      row({ harness: "codex", sessionId: "codex-2", sourceFile: "r.jsonl" }),
      // Nobody links it (unlinked, or a task-less run's transcript): not the purge's business.
      row({ sessionId: "stray", sourceFile: "stray.jsonl" }),
      row({ sessionId: "run-1", sourceFile: "", source: "run_output", taskId: doomed.id, purpose: "review" }),
      row({ sessionId: "run-2", sourceFile: "", source: "run_output", purpose: "digest" }),
    ]);
    repo.setCursor({ harness: "claude-code", sessionId: OTHER }, `${OTHER}.jsonl`, { offset: 1, size: 1, state: null });

    s.tasks.delete([doomed.id], {}, "test");
    s.tasks.purge([doomed.id], "test");

    const all = repo.rowsBetween("2000-01-01", "3000-01-01").map((r) => `${r.harness}:${r.sessionId}`);
    expect(all.sort()).toEqual(["claude-code:" + SESSION, "claude-code:run-2", "claude-code:stray", "codex:codex-1"]);
    expect(repo.cursor({ harness: "claude-code", sessionId: OTHER }, `${OTHER}.jsonl`)).toBeNull();
    expect(repo.threadSessions("thread-gone")).toEqual([]);
    expect(repo.threadSessions("thread-1")).toEqual([{ harness: "codex", sessionId: "codex-1" }]);
  });
});
