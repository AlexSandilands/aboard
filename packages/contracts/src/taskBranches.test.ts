import { describe, expect, it } from "vitest";
import type { TaskLink } from "./schemas.ts";
import { linkBranches } from "./taskBranches.ts";

const base = (id: string, createdAt: string) => ({ id, taskId: "task", label: null, syncedAt: null, createdAt });

function pr(
  number: number,
  headRef: string,
  state: "open" | "draft" | "merged" | "closed",
  createdAt: string,
  extra: { isCrossRepository?: boolean } = {},
): TaskLink {
  return {
    ...base(`pr-${number}`, createdAt),
    kind: "pr",
    url: `https://github.com/o/r/pull/${number}`,
    ref: { host: "github.com", repo: "o/r", number },
    snapshot: {
      state,
      title: "PR",
      checks: "none",
      reviewDecision: null,
      mergeable: "unknown",
      headRef,
      updatedAt: null,
      ...extra,
    },
  };
}

function thread(id: string, branch: string | null, createdAt: string, archived = false): TaskLink {
  return {
    ...base(`t-${id}`, createdAt),
    kind: "t3_thread",
    url: `t3code://threads/env/${id}`,
    ref: { environmentId: "env", threadId: id },
    snapshot: { title: id, status: "idle", branch, archived },
  };
}

function session(id: string, harness: "claude-code" | "codex", createdAt: string): TaskLink {
  return {
    ...base(`s-${id}`, createdAt),
    kind: "agent_session",
    url: `agent-session://${harness}/${id}`,
    ref: { harness, sessionId: id, cwd: `/wt/${id}` },
    snapshot: null,
  };
}

const names = (links: TaskLink[], opts?: Parameters<typeof linkBranches>[1]) =>
  linkBranches(links, opts).map((b) => b.name);

describe("linkBranches", () => {
  it("puts open PRs first, then other active branches newest first, then merged or closed ones", () => {
    const links = [
      pr(1, "old-merged", "merged", "2026-11-01T00:00:00Z"),
      thread("a", "thread-old", "2026-11-02T00:00:00Z"),
      thread("b", "thread-new", "2026-11-04T00:00:00Z"),
      pr(2, "feature", "open", "2026-11-03T00:00:00Z"),
    ];
    expect(names(links)).toEqual(["feature", "thread-new", "thread-old", "old-merged"]);
    expect(linkBranches(links).at(-1)).toMatchObject({ inactive: true, sources: [{ label: "PR #1 merged" }] });
  });

  it("lists a branch found several ways once, with each source: open PRs, then other active ones, then finished", () => {
    const links = [
      pr(3, "feat/x", "closed", "2026-11-01T00:00:00Z"),
      pr(4, "feat/x", "draft", "2026-11-02T00:00:00Z"),
      thread("a", "feat/x", "2026-11-03T00:00:00Z"),
    ];
    const [branch, ...rest] = linkBranches(links);
    expect(rest).toEqual([]);
    expect(branch).toEqual({
      name: "feat/x",
      sources: [
        { kind: "pr", label: "PR #4 draft", inactive: false },
        { kind: "t3_thread", label: "T3 thread", inactive: false },
        { kind: "pr", label: "PR #3 closed", inactive: true },
      ],
      worktreePath: null,
      inactive: false,
    });
  });

  it("leaves out the default and integration branches, with or without origin/", () => {
    const links = [
      thread("a", "main", "2026-11-01T00:00:00Z"),
      thread("b", "aboard/epic-7", "2026-11-02T00:00:00Z"),
      pr(5, "mine", "open", "2026-11-03T00:00:00Z"),
    ];
    expect(names(links, { exclude: ["origin/main", "aboard/epic-7", null] })).toEqual(["mine"]);
  });

  it("skips archived threads, threads with no branch and PRs from forks", () => {
    const links = [
      thread("a", "gone", "2026-11-01T00:00:00Z", true),
      thread("b", null, "2026-11-01T00:00:00Z"),
      pr(6, "fork-branch", "open", "2026-11-01T00:00:00Z", { isCrossRepository: true }),
    ];
    expect(names(links)).toEqual([]);
  });

  it("names each harness's session from the branch the caller read", () => {
    const links = [
      session("c1", "claude-code", "2026-11-01T00:00:00Z"),
      session("x1", "codex", "2026-11-02T00:00:00Z"),
    ];
    const branches = linkBranches(links, {
      sessionBranch: (link) =>
        link.ref.sessionId === "c1" ? "claude/work" : link.ref.sessionId === "x1" ? "codex/work" : null,
    });
    expect(branches.map((b) => [b.name, b.sources[0]!.label])).toEqual([
      ["codex/work", "Codex session"],
      ["claude/work", "Claude Code session"],
    ]);
    expect(names(links)).toEqual([]);
  });
});
