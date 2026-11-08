import type { TaskLink } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import type { RunGit } from "./backup.ts";
import { parseWorktrees, taskBranches } from "./taskBranches.ts";

const PORCELAIN = [
  "worktree /repo",
  "HEAD 1111",
  "branch refs/heads/main",
  "",
  "worktree /wt/feature",
  "HEAD 2222",
  "branch refs/heads/feature",
  "",
  "worktree /wt/detached",
  "HEAD 3333",
  "detached",
  "",
  "worktree /wt/gone",
  "HEAD 4444",
  "branch refs/heads/gone",
  "prunable gitdir file points to non-existent location",
  "",
].join("\n");

describe("parseWorktrees", () => {
  it("reads each worktree's folder and branch, main checkout first, without prunable ones", () => {
    expect(parseWorktrees(PORCELAIN)).toEqual([
      { path: "/repo", branch: "main" },
      { path: "/wt/feature", branch: "feature" },
      { path: "/wt/detached", branch: null },
    ]);
  });

  it("reads Windows line endings", () => {
    expect(parseWorktrees(PORCELAIN.replaceAll("\n", "\r\n"))[1]).toEqual({ path: "/wt/feature", branch: "feature" });
  });
});

const link = (kind: TaskLink["kind"], extra: Record<string, unknown> & { n?: number }): TaskLink =>
  ({
    id: `${kind}-${extra.n ?? 0}`,
    taskId: "t",
    url: "x",
    label: null,
    syncedAt: null,
    createdAt: "2026-11-01T00:00:00Z",
    kind,
    ...extra,
  }) as TaskLink;

const thread = (branch: string, n = 0) =>
  link("t3_thread", {
    n,
    ref: { environmentId: "e", threadId: `t${n}` },
    snapshot: { title: "", status: "idle", branch },
  });
const session = (cwd: string) =>
  link("agent_session", { ref: { harness: "copilot-cli", sessionId: "s", cwd }, snapshot: null });

describe("taskBranches", () => {
  const calls: string[][] = [];
  const runGit: RunGit = (args) => {
    calls.push(args);
    return Promise.resolve({ code: 0, stdout: PORCELAIN, stderr: "" });
  };

  it("runs no git for a task without branch links", async () => {
    calls.length = 0;
    const result = await taskBranches({
      task: { links: [link("url", {})], integrationBranch: null },
      root: "/repo",
      defaultBranch: "main",
      runGit,
    });
    expect(result).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("adds each branch's worktree, leaves out the default and integration branches and the checkout's sessions", async () => {
    const result = await taskBranches({
      task: {
        links: [
          thread("feature", 1),
          thread("main", 2),
          thread("epic/7", 3),
          session("/repo"),
          session("/wt/detached"),
        ],
        integrationBranch: "epic/7",
      },
      root: "/repo",
      defaultBranch: "main",
      runGit,
    });
    expect(result).toEqual([
      {
        name: "feature",
        sources: [{ kind: "t3_thread", label: "T3 thread", inactive: false }],
        worktreePath: "/wt/feature",
        inactive: false,
      },
    ]);
  });

  it("finds a session's branch from any folder inside its worktree", async () => {
    const result = await taskBranches({
      task: { links: [session("/wt/feature/apps/web")], integrationBranch: null },
      root: "/repo",
      defaultBranch: "main",
      runGit,
    });
    expect(result.map((b) => [b.name, b.sources[0]!.label, b.worktreePath])).toEqual([
      ["feature", "Copilot CLI session", "/wt/feature"],
    ]);
  });

  it("treats a project living in a linked worktree as the checkout, and the main checkout as a worktree", async () => {
    const result = await taskBranches({
      task: { links: [session("/wt/feature"), thread("main")], integrationBranch: null },
      root: "/wt/feature",
      defaultBranch: null,
      runGit,
    });
    // The session in the project's folder says nothing; main is checked out in /repo, another worktree.
    expect(result.map((b) => [b.name, b.worktreePath])).toEqual([["main", "/repo"]]);
  });

  it("keeps the links' branches when git fails", async () => {
    const result = await taskBranches({
      task: { links: [thread("feature")], integrationBranch: null },
      root: "/repo",
      defaultBranch: null,
      runGit: () => Promise.reject(new Error("git was not found on PATH")),
    });
    expect(result).toMatchObject([{ name: "feature", worktreePath: null }]);
  });
});
