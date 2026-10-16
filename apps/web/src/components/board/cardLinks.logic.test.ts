import type { T3ThreadSnapshot, TaskLink } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { cardLinks } from "./cardLinks.logic";

const base = { taskId: "t", label: null, syncedAt: null, createdAt: "" };

const thread = (id: string, snapshot: Partial<T3ThreadSnapshot> | null): TaskLink => ({
  ...base,
  id,
  kind: "t3_thread",
  url: `t3code://threads/env/${id}`,
  ref: { environmentId: "env", threadId: id },
  snapshot: snapshot ? { title: id, status: "done", ...snapshot } : null,
});

const pr = (id: string): TaskLink => ({
  ...base,
  id,
  kind: "pr",
  url: `https://github.com/o/r/pull/${id}`,
  ref: null,
  snapshot: null,
});

const other = (id: string): TaskLink => ({ ...base, id, kind: "url", url: `https://example.com/${id}` });

const ids = (links: TaskLink[]) => links.map((link) => link.id);

describe("cardLinks", () => {
  it("hides settled and archived threads", () => {
    const links = [
      thread("settled", { settled: true }),
      thread("archived", { archived: true }),
      thread("active", { status: "working" }),
    ];
    expect(ids(cardLinks(links))).toEqual(["active"]);
  });

  it("keeps threads without a snapshot, since they may be active", () => {
    expect(ids(cardLinks([thread("unknown", null)]))).toEqual(["unknown"]);
  });

  it("keeps PRs and drops links the card doesn't show", () => {
    const links = [
      other("u"),
      pr("1"),
      thread("t", {}),
      { ...base, id: "j", kind: "jira", url: "J-1", ref: { key: "J-1" } } as TaskLink,
    ];
    expect(ids(cardLinks(links))).toEqual(["1", "t"]);
  });

  it("orders threads by attention, then recency", () => {
    const links = [
      thread("done", { status: "done", lastActivityAt: "2026-01-03T00:00:00Z" }),
      thread("old", { status: "working", lastActivityAt: "2026-01-01T00:00:00Z" }),
      thread("new", { status: "working", lastActivityAt: "2026-01-02T00:00:00Z" }),
      thread("input", { status: "input" }),
    ];
    expect(ids(cardLinks(links))).toEqual(["input", "new", "old", "done"]);
  });

  it("is empty when the only threads are inactive", () => {
    expect(cardLinks([thread("s", { settled: true }), thread("a", { archived: true }), other("u")])).toEqual([]);
  });
});

const session = (id: string): TaskLink => ({
  ...base,
  id,
  kind: "agent_session",
  url: `agent-session://claude-code/${id}`,
  ref: { harness: "claude-code", sessionId: id, cwd: "C:\\Code" },
  snapshot: null,
});

describe("cardLinks with agent sessions", () => {
  it("shows sessions on a task without a T3 thread", () => {
    expect(ids(cardLinks([pr("1"), session("s")]))).toEqual(["1", "s"]);
  });

  it("hides sessions once the task has a T3 thread, even a settled one", () => {
    expect(ids(cardLinks([session("s"), thread("t", { status: "working" })]))).toEqual(["t"]);
    expect(ids(cardLinks([session("s"), thread("t", { settled: true })]))).toEqual([]);
  });
});
