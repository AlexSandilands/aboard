import { describe, expect, it } from "vitest";
import { implementingThread } from "./runThreads.ts";
import type { T3ThreadSnapshot, TaskLink } from "./schemas.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");

let n = 0;
function thread(
  id: string,
  extra: { role?: "followup"; snapshot?: Partial<T3ThreadSnapshot> | null; createdAt?: string } = {},
): TaskLink {
  n += 1;
  return {
    id: `link-${id}`,
    taskId: "task",
    kind: "t3_thread",
    url: `t3code://threads/env/${id}`,
    label: null,
    syncedAt: null,
    createdAt: extra.createdAt ?? "2026-11-03T08:00:00Z",
    ref: { environmentId: "env", threadId: id },
    snapshot: extra.snapshot === null ? null : { title: id, status: "idle", ...extra.snapshot },
    ...(extra.role ? { role: extra.role } : {}),
  };
}

function pr(headRef: string | null, state: "open" | "draft" | "merged" | "closed" = "open"): TaskLink {
  n += 1;
  return {
    id: `pr-${n}`,
    taskId: "task",
    kind: "pr",
    url: `https://github.com/o/r/pull/${n}`,
    label: null,
    syncedAt: null,
    createdAt: "2026-11-03T09:00:00Z",
    ref: null,
    snapshot: {
      state,
      title: "PR",
      checks: "none",
      reviewDecision: null,
      mergeable: "unknown",
      headRef,
      updatedAt: null,
    },
  };
}

const idOf = (links: TaskLink[]) => {
  const found = implementingThread({ links }, NOW);
  return found?.ref.threadId ?? null;
};

describe("implementingThread", () => {
  it("skips a newer busy follow-up for the thread that did the work", () => {
    const links = [
      thread("impl", { snapshot: { status: "done" } }),
      thread("ask", { role: "followup", snapshot: { status: "working" } }),
    ];
    expect(idOf(links)).toBe("impl");
  });

  it("returns null when every thread is a follow-up or archived", () => {
    expect(idOf([thread("ask", { role: "followup" }), thread("old", { snapshot: { archived: true } })])).toBeNull();
    expect(idOf([])).toBeNull();
  });

  it("prefers the thread on an open PR's branch over a newer idle one", () => {
    const links = [
      thread("impl", { snapshot: { branch: "feat/x", status: "done" } }),
      thread("later", { snapshot: { branch: "other", status: "idle" } }),
      pr("feat/x"),
    ];
    expect(idOf(links)).toBe("impl");
  });

  it("prefers a newer busy thread on another branch over an idle one on the PR's branch", () => {
    const links = [
      thread("old", { snapshot: { branch: "feat/x", status: "done" } }),
      thread("working", { snapshot: { branch: "other", status: "working" } }),
      pr("feat/x"),
    ];
    expect(idOf(links)).toBe("working");
  });

  it("ignores the branch of a merged PR", () => {
    const links = [thread("impl", { snapshot: { branch: "feat/x" } }), thread("later"), pr("feat/x", "merged")];
    expect(idOf(links)).toBe("later");
  });

  it("never picks a follow-up even on the PR's branch", () => {
    const links = [
      thread("impl", { snapshot: { branch: "other" } }),
      thread("ask", { role: "followup", snapshot: { branch: "feat/x" } }),
      pr("feat/x"),
    ];
    expect(idOf(links)).toBe("impl");
  });

  it("without a PR, takes the newest busy thread, else the newest", () => {
    const busy = [thread("a", { snapshot: { status: "working" } }), thread("b", { snapshot: { status: "done" } })];
    expect(idOf(busy)).toBe("a");
    const idle = [thread("a", { snapshot: { status: "done" } }), thread("b", { snapshot: { status: "idle" } })];
    expect(idOf(idle)).toBe("b");
  });

  it("counts a settled thread as not busy, and a just-linked one without a snapshot as busy", () => {
    expect(
      idOf([
        thread("a", { snapshot: { status: "working", settled: true } }),
        thread("b", { snapshot: { status: "done" } }),
      ]),
    ).toBe("b");
    const fresh = thread("fresh", { snapshot: null, createdAt: new Date(NOW - 30_000).toISOString() });
    expect(idOf([fresh, thread("b", { snapshot: { status: "done" } })])).toBe("fresh");
  });
});
