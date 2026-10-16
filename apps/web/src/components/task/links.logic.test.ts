import { classifyLink, type T3ThreadSnapshot, type TaskLink } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { describeLinkInput, orderLinks, threadDetails, threadModelsDiffer, unrecognisedLinkHint } from "./links.logic";

const base = { taskId: "t", label: null, syncedAt: null, createdAt: "" };

const thread = (id: string, snapshot: Partial<T3ThreadSnapshot> | null): TaskLink => ({
  ...base,
  id,
  kind: "t3_thread",
  url: `t3code://threads/env/${id}`,
  ref: { environmentId: "env", threadId: id },
  snapshot: snapshot ? { title: id, status: "done", ...snapshot } : null,
});

const url = (id: string): TaskLink => ({ ...base, id, kind: "url", url: `https://example.com/${id}` });

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
