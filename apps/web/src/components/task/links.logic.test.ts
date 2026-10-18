import { classifyLink, type T3ThreadSnapshot, type TaskLink } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  checkedAgoLabel,
  describeLinkInput,
  groupLinks,
  orderLinks,
  previewRows,
  threadDetails,
  threadModelsDiffer,
  unrecognisedLinkHint,
} from "./links.logic";

const base = { taskId: "t", label: null, syncedAt: null, createdAt: "" };

const thread = (id: string, snapshot: Partial<T3ThreadSnapshot> | null, createdAt = ""): TaskLink => ({
  ...base,
  id,
  createdAt,
  kind: "t3_thread",
  url: `t3code://threads/env/${id}`,
  ref: { environmentId: "env", threadId: id },
  snapshot: snapshot ? { title: id, status: "done", ...snapshot } : null,
});

const url = (id: string): TaskLink => ({ ...base, id, kind: "url", url: `https://example.com/${id}` });

const pr = (id: string): TaskLink => ({
  ...base,
  id,
  kind: "pr",
  url: `https://github.com/o/r/pull/${id}`,
  ref: null,
  snapshot: null,
});
const issue = (id: string): TaskLink => ({
  ...base,
  id,
  kind: "issue",
  url: `https://github.com/o/r/issues/${id}`,
  ref: { host: "github.com", repo: "o/r", number: 1 },
  snapshot: null,
});
const jira = (id: string): TaskLink => ({ ...base, id, kind: "jira", url: id, ref: { key: id } });

const SESSION_ID = "b76a4a91-3196-48df-a421-9a32d5ac9978";
const session = (
  id: string,
  opts: { createdAt?: string; harness?: "claude-code" | "copilot-cli"; label?: string | null } = {},
): TaskLink => ({
  ...base,
  id,
  kind: "agent_session",
  url: `agent-session://${id}`,
  label: opts.label ?? null,
  createdAt: opts.createdAt ?? "",
  ref: { harness: opts.harness ?? "claude-code", sessionId: SESSION_ID, cwd: "/work/code" },
  snapshot: null,
});

const ids = (links: TaskLink[]) => links.map((link) => link.id);

describe("orderLinks", () => {
  it("leaves a single thread where it is", () => {
    const links = [url("a"), thread("t1", null), url("b")];
    expect(ids(orderLinks(links))).toEqual(["a", "t1", "b"]);
  });

  it("puts threads needing attention first and settled/archived last", () => {
    const links = [
      thread("archived", { status: "working", archived: true }),
      thread("settled", { status: "done", settled: true }),
      thread("done", { status: "done" }),
      thread("waiting", { status: "waiting" }),
      thread("working", { status: "working" }),
      thread("input", { status: "input" }),
    ];
    expect(ids(orderLinks(links))).toEqual(["input", "working", "waiting", "done", "settled", "archived"]);
  });

  it("breaks ties by most recent activity", () => {
    const links = [
      thread("old", { lastActivityAt: "2026-01-01T00:00:00Z" }),
      thread("none", {}),
      thread("new", { lastActivityAt: "2026-01-03T00:00:00Z" }),
    ];
    expect(ids(orderLinks(links))).toEqual(["new", "old", "none"]);
  });

  it("groups threads at the first thread's position and keeps other links in order", () => {
    const links = [
      url("a"),
      thread("t1", { lastActivityAt: "2026-01-01T00:00:00Z" }),
      url("b"),
      thread("t2", { lastActivityAt: "2026-01-02T00:00:00Z" }),
      url("c"),
    ];
    expect(ids(orderLinks(links))).toEqual(["a", "t2", "t1", "b", "c"]);
  });
});

describe("threadModelsDiffer", () => {
  it("is true only when threads use different models", () => {
    expect(threadModelsDiffer([thread("a", { model: "m1" }), thread("b", { model: "m1" })])).toBe(false);
    expect(threadModelsDiffer([thread("a", { model: "m1" }), thread("b", { model: null })])).toBe(false);
    expect(threadModelsDiffer([thread("a", { model: "m1" }), thread("b", { model: "m2" })])).toBe(true);
  });
});

describe("threadDetails", () => {
  const snapshot: T3ThreadSnapshot = { title: "x", status: "done", branch: "feat/x", model: "m1" };

  it("lists branch, and model when asked", () => {
    expect(threadDetails(snapshot, { showModel: false })).toEqual(["feat/x"]);
    expect(threadDetails(snapshot, { showModel: true })).toEqual(["feat/x", "m1"]);
  });

  it("leads with Archived over Settled", () => {
    expect(threadDetails({ ...snapshot, settled: true }, { showModel: false })).toEqual(["Settled", "feat/x"]);
    expect(threadDetails({ ...snapshot, settled: true, archived: true }, { showModel: false })).toEqual([
      "Archived",
      "feat/x",
    ]);
  });

  it("is empty without a snapshot", () => {
    expect(threadDetails(null, { showModel: true })).toEqual([]);
  });
});

describe("adding a pasted T3 thread id", () => {
  const id = "bca46358-2812-4417-93f7-e151c0f96292";
  const t3 = { environmentId: "env-1", origin: "http://127.0.0.1:3773" };

  it("previews a thread when T3 is detected", () => {
    expect(describeLinkInput(classifyLink(id, { t3 }))).toEqual({ kind: "t3_thread", label: "T3 Code thread" });
    expect(describeLinkInput(classifyLink(id, { t3: { environmentId: null, origin: null } }))).toBeNull();
  });

  it("says why an id isn't recognised only when T3 isn't detected", () => {
    expect(unrecognisedLinkHint(id, { detected: false })).toContain("T3 Code isn't running");
    expect(unrecognisedLinkHint(id, { detected: true })).toContain("Not recognised");
    expect(unrecognisedLinkHint("nonsense", { detected: false })).toContain("Not recognised");
  });
});

describe("groupLinks", () => {
  it("orders the Links group PRs, issues, Jira, then URLs, each in its own order", () => {
    const links = [url("u1"), jira("J-1"), issue("i1"), pr("p1"), url("u2"), pr("p2")];
    expect(ids(groupLinks(links).links)).toEqual(["p1", "p2", "i1", "J-1", "u1", "u2"]);
  });

  it("keeps threads and sessions out of the Links group", () => {
    const groups = groupLinks([pr("p"), thread("t", null), session("s", { harness: "copilot-cli" })]);
    expect(ids(groups.links)).toEqual(["p"]);
    expect(ids(groups.sessionRows)).toEqual(["t", "s"]);
  });

  it("puts threads first in attention order, then sessions newest first", () => {
    const groups = groupLinks([
      session("old", { createdAt: "2026-01-01T00:00:00Z", harness: "copilot-cli" }),
      thread("done", { status: "done" }),
      session("new", { createdAt: "2026-01-02T00:00:00Z", harness: "copilot-cli" }),
      thread("input", { status: "input" }),
    ]);
    expect(groups.sessionRows.map((row) => row.id)).toEqual(["input", "done", "new", "old"]);
  });

  it("shows Claude Code sessions as rows when the task has no thread", () => {
    const groups = groupLinks([session("a"), session("b")]);
    expect(ids(groups.sessionRows)).toEqual(["a", "b"]);
    expect(groups.folded.size).toBe(0);
  });

  it("folds Claude Code sessions into the one thread's menu, newest first", () => {
    const groups = groupLinks([
      session("old", { createdAt: "2026-01-02T00:00:00Z" }),
      thread("t", null, "2026-01-01T00:00:00Z"),
      session("new", { createdAt: "2026-01-03T00:00:00Z" }),
    ]);
    expect(ids(groups.sessionRows)).toEqual(["t"]);
    expect(ids(groups.folded.get("t") ?? [])).toEqual(["new", "old"]);
  });

  it("keeps Autopilot and Copilot CLI sessions as rows next to a thread", () => {
    const finished: TaskLink = {
      ...session("done"),
      snapshot: { status: "finished", inApp: false },
    } as TaskLink;
    const groups = groupLinks([
      thread("t", null),
      finished,
      session("named", { label: "Autopilot · Review" }),
      session("copilot", { harness: "copilot-cli" }),
      session("mine"),
    ]);
    expect(ids(groups.sessionRows).toSorted()).toEqual(["copilot", "done", "named", "t"]);
    expect(ids(groups.folded.get("t") ?? [])).toEqual(["mine"]);
  });

  it("folds each session into the newest thread linked before it when there are several", () => {
    const groups = groupLinks([
      thread("t1", null, "2026-01-01T00:00:00Z"),
      session("s1", { createdAt: "2026-01-01T00:00:01Z" }),
      thread("t2", null, "2026-01-02T00:00:00Z"),
      session("s2", { createdAt: "2026-01-02T00:00:01Z" }),
      session("s3", { createdAt: "2026-01-02T00:00:02Z" }),
    ]);
    expect(ids(groups.sessionRows)).toEqual(["t1", "t2"]);
    expect(ids(groups.folded.get("t1") ?? [])).toEqual(["s1"]);
    expect(ids(groups.folded.get("t2") ?? [])).toEqual(["s3", "s2"]);
  });

  it("files a session linked after a later thread under that thread, even if it belongs to an older one", () => {
    // Attribution is a heuristic on link time: nothing says which thread a session came from.
    const groups = groupLinks([
      thread("t1", null, "2026-01-01T00:00:00Z"),
      session("s1", { createdAt: "2026-01-01T00:00:01Z" }),
      thread("t2", null, "2026-01-02T00:00:00Z"),
      session("resumed-t1", { createdAt: "2026-01-03T00:00:00Z" }),
    ]);
    expect(ids(groups.folded.get("t1") ?? [])).toEqual(["s1"]);
    expect(ids(groups.folded.get("t2") ?? [])).toEqual(["resumed-t1"]);
  });

  it("folds a session linked at the same moment as its thread", () => {
    const at = "2026-01-01T00:00:00Z";
    const groups = groupLinks([thread("t", null, at), session("s", { createdAt: at })]);
    expect(ids(groups.sessionRows)).toEqual(["t"]);
    expect(ids(groups.folded.get("t") ?? [])).toEqual(["s"]);
  });

  it("folds a session linked before every thread into the oldest one", () => {
    const groups = groupLinks([
      session("early", { createdAt: "2026-01-01T00:00:00Z" }),
      thread("t1", null, "2026-01-02T00:00:00Z"),
      thread("t2", null, "2026-01-03T00:00:00Z"),
    ]);
    expect(ids(groups.sessionRows)).toEqual(["t1", "t2"]);
    expect(ids(groups.folded.get("t1") ?? [])).toEqual(["early"]);
  });

  it("folds a session linked just before the only thread", () => {
    const groups = groupLinks([
      session("s", { createdAt: "2026-01-01T00:00:00Z" }),
      thread("t", null, "2026-01-01T00:00:01Z"),
    ]);
    expect(ids(groups.sessionRows)).toEqual(["t"]);
    expect(ids(groups.folded.get("t") ?? [])).toEqual(["s"]);
  });

  it("keeps Autopilot and Copilot CLI sessions as rows when there are several threads", () => {
    const after = "2026-01-04T00:00:00Z";
    const groups = groupLinks([
      thread("t1", null, "2026-01-01T00:00:00Z"),
      thread("t2", null, "2026-01-02T00:00:00Z"),
      session("auto", { createdAt: after, label: "Autopilot · Review" }),
      session("copilot", { createdAt: after, harness: "copilot-cli" }),
    ]);
    expect(ids(groups.sessionRows).toSorted()).toEqual(["auto", "copilot", "t1", "t2"]);
    expect(groups.folded.size).toBe(0);
  });
});

describe("previewRows", () => {
  const rows = ["a", "b", "c", "d", "e"];

  it("shows everything up to three rows", () => {
    expect(previewRows(rows.slice(0, 3), false)).toEqual({ shown: ["a", "b", "c"], hidden: 0 });
  });

  it("shows the first three and counts the rest", () => {
    expect(previewRows(rows, false)).toEqual({ shown: ["a", "b", "c"], hidden: 2 });
  });

  it("shows everything once expanded", () => {
    expect(previewRows(rows, true)).toEqual({ shown: rows, hidden: 0 });
  });
});

describe("checkedAgoLabel", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("says how long ago a PR was last read", () => {
    expect(checkedAgoLabel(ago(2_000), now)).toBe("checked just now");
    expect(checkedAgoLabel(ago(23_000), now)).toBe("checked 23s ago");
    expect(checkedAgoLabel(ago(5 * 60_000), now)).toBe("checked 5m ago");
    expect(checkedAgoLabel(ago(3 * 3600_000), now)).toBe("checked 3h ago");
    expect(checkedAgoLabel(ago(2 * 86400_000), now)).toBe("checked 2d ago");
  });

  it("says nothing for a link never read, and never goes negative", () => {
    expect(checkedAgoLabel(null, now)).toBeNull();
    expect(checkedAgoLabel("not a date", now)).toBeNull();
    expect(checkedAgoLabel(ago(-10_000), now)).toBe("checked just now");
  });
});
