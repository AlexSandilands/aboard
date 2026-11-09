import type { AutopilotMode } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  approveHeaderLoss,
  approveHeaderWrites,
  approveOn,
  approveRowWrite,
  peopleIn,
  peopleResetWrite,
  peopleRoster,
  peopleRowWrite,
  reviewNewProjects,
  reviewRowDiffers,
  sourceHeaderLoss,
  sourceHeaderWrites,
  sourceOn,
  sourceRowWrites,
  togglePerson,
  type ReviewPrsScopes,
} from "./reviewPrs.logic";

const scopes = (
  board: AutopilotMode,
  boardConfig: Record<string, unknown>,
  projects: Record<string, { mode?: AutopilotMode; config?: Record<string, unknown> }>,
  epics: ReviewPrsScopes["input"]["epics"] = [],
): ReviewPrsScopes => ({
  input: {
    board,
    projects: Object.entries(projects).map(([id, p]) => ({ id, title: id, mode: p.mode ?? "inherit" })),
    epics,
  },
  board: { ownPrs: true, otherPrs: false, otherAuthors: "", otherApprove: false, ...boardConfig },
  projects: Object.fromEntries(Object.entries(projects).map(([id, p]) => [id, p.config ?? {}])),
});

describe("sourceOn", () => {
  it("is off where the automation is off, and reads the project's key before the board's", () => {
    const t = scopes("on", { otherPrs: true }, { a: {}, b: { mode: "off" }, c: { config: { otherPrs: false } } });
    expect(sourceOn(t, "a", "otherPrs")).toBe(true);
    expect(sourceOn(t, "b", "otherPrs")).toBe(false);
    expect(sourceOn(t, "c", "otherPrs")).toBe(false);
  });

  it("keeps today's board-level settings as the All projects row", () => {
    const t = scopes("on", { otherPrs: true, otherAuthors: "alice", otherApprove: true }, { a: {} });
    expect(sourceOn(t, "a", "ownPrs")).toBe(true);
    expect(peopleIn(t, "a")).toEqual(["alice"]);
    expect(approveOn(t, "a")).toBe(true);
  });
});

describe("sourceRowWrites", () => {
  it("turns a project on for its source, with the mode and the source's key in one write", () => {
    expect(sourceRowWrites(scopes("inherit", {}, { a: {} }), "a", "otherPrs", true)).toEqual([
      { target: { kind: "project", id: "a" }, mode: "on", config: { ownPrs: false, otherPrs: true } },
    ]);
  });

  it("stores nothing when the board already gives the value, keeping the project on", () => {
    expect(sourceRowWrites(scopes("on", {}, { a: {} }), "a", "ownPrs", true)).toEqual([]);
    expect(sourceRowWrites(scopes("on", {}, { a: {} }), "a", "otherPrs", true)).toEqual([
      { target: { kind: "project", id: "a" }, config: { otherPrs: true } },
    ]);
  });

  it("keeps the project on while the other source is, and turns it off with the last one", () => {
    const both = scopes("on", {}, { a: { config: { otherPrs: true } } });
    expect(sourceRowWrites(both, "a", "ownPrs", false)).toEqual([
      { target: { kind: "project", id: "a" }, config: { ownPrs: false } },
    ]);
    const only = scopes("on", {}, { a: { config: { ownPrs: false, otherPrs: true } } });
    expect(sourceRowWrites(only, "a", "otherPrs", false)).toEqual([
      { target: { kind: "project", id: "a" }, mode: "off", config: { ownPrs: undefined, otherPrs: undefined } },
    ]);
  });

  it("doesn't bring back a stale source when a switched-off project comes on", () => {
    const off = scopes("inherit", { otherPrs: true }, { a: { mode: "off" } });
    expect(sourceRowWrites(off, "a", "ownPrs", true)).toEqual([
      { target: { kind: "project", id: "a" }, mode: "on", config: { ownPrs: undefined, otherPrs: false } },
    ]);
  });

  it("clears a project's own On when the board gives it again", () => {
    expect(sourceRowWrites(scopes("on", {}, { a: { mode: "on" } }), "a", "otherPrs", true)).toEqual([
      { target: { kind: "project", id: "a" }, mode: "inherit", config: { otherPrs: true } },
    ]);
  });
});

describe("sourceHeaderWrites", () => {
  it("first time on: the board runs in the given mode with only that source, the other staying off", () => {
    expect(sourceHeaderWrites(scopes("inherit", {}, { a: {} }), "otherPrs", true, "preview")).toEqual([
      { target: { kind: "board" }, mode: "preview", config: { ownPrs: false, otherPrs: true } },
    ]);
  });

  it("switching a source off keeps a project running on the other, and its own switch beats the new board", () => {
    const t = scopes("on", {}, { a: {}, b: { config: { otherPrs: true } } });
    expect(sourceHeaderWrites(t, "ownPrs", false, "on")).toEqual([
      { target: { kind: "board" }, mode: "inherit", config: { ownPrs: undefined, otherPrs: undefined } },
      { target: { kind: "project", id: "b" }, mode: "on", config: { ownPrs: false } },
    ]);
  });

  it("keeps Preview on a project still running when the board stops under it", () => {
    const t = scopes("preview", { ownPrs: false, otherPrs: true }, { a: { config: { ownPrs: true } }, b: {} });
    const writes = sourceHeaderWrites(t, "otherPrs", false, "on");
    expect(writes[0]).toEqual({
      target: { kind: "board" },
      mode: "inherit",
      config: { ownPrs: undefined, otherPrs: undefined },
    });
    expect(writes).toContainEqual({
      target: { kind: "project", id: "a" },
      mode: "preview",
      config: { ownPrs: undefined },
    });
  });

  it("clears the board's source keys when nothing is left running, so a later Mode On does something", () => {
    const writes = sourceHeaderWrites(scopes("on", {}, { a: {} }), "ownPrs", false, "on");
    expect(writes[0]).toEqual({
      target: { kind: "board" },
      mode: "inherit",
      config: { ownPrs: undefined, otherPrs: undefined },
    });
    expect(Object.keys(writes[0]!.config!)).toEqual(["ownPrs", "otherPrs"]);
    expect(writes[0]!.config!.ownPrs).toBeUndefined();
  });

  it("turning a source on clears the projects that opted out", () => {
    const t = scopes("on", {}, { a: { mode: "off", config: {} }, b: { config: { otherPrs: false } } });
    const writes = sourceHeaderWrites(t, "otherPrs", true, "on");
    expect(writes[0]).toEqual({ target: { kind: "board" }, config: { ownPrs: undefined, otherPrs: true } });
    expect(writes.slice(1)).toEqual([
      { target: { kind: "project", id: "a" }, mode: "inherit", config: { ownPrs: false } },
      { target: { kind: "project", id: "b" }, config: { otherPrs: undefined } },
    ]);
  });

  it("drops epics' own On when their project ends with no source", () => {
    const t = scopes("on", {}, { a: {} }, [{ id: "e", number: 5, projectId: "a", mode: "on" }]);
    expect(sourceHeaderWrites(t, "ownPrs", false, "on")).toContainEqual({
      target: { kind: "epic", id: "e", projectId: "a" },
      mode: "inherit",
    });
  });
});

describe("sourceHeaderLoss", () => {
  it("names projects with the source on when the board doesn't give it", () => {
    const t = scopes("inherit", {}, { a: { mode: "on", config: { otherPrs: true } }, b: {} });
    expect(sourceHeaderLoss(t, ["a", "b"], "otherPrs", false)).toEqual({ projects: ["a"], epics: 0 });
    expect(sourceHeaderLoss(scopes("on", {}, { a: {} }), ["a"], "ownPrs", false)).toBeNull();
  });

  it("names projects excluded on purpose when turning on", () => {
    const t = scopes("inherit", {}, { a: { mode: "off" }, b: { config: { otherPrs: false } }, c: {} });
    expect(sourceHeaderLoss(t, ["a", "b", "c"], "otherPrs", true)).toEqual({ projects: ["a", "b"], epics: 0 });
  });
});

describe("approve", () => {
  it("stores a row's value only where it differs from the board", () => {
    const t = scopes("on", { otherApprove: true }, { a: {} });
    expect(approveRowWrite(t, "a", true)).toEqual({
      target: { kind: "project", id: "a" },
      config: { otherApprove: undefined },
    });
    expect(approveRowWrite(t, "a", false)).toEqual({
      target: { kind: "project", id: "a" },
      config: { otherApprove: false },
    });
  });

  it("the header clears the own value of each row showing Approve, and leaves a hidden one's opt-out", () => {
    const t = scopes(
      "on",
      {},
      {
        a: { config: { otherPrs: true, otherApprove: true } },
        b: {},
        hidden: { config: { otherApprove: false } },
      },
    );
    expect(approveHeaderWrites(t, false)).toEqual([
      { target: { kind: "board" }, config: { otherApprove: undefined } },
      { target: { kind: "project", id: "a" }, config: { otherApprove: undefined } },
    ]);
  });

  it("asks only about rows that show it", () => {
    const t = scopes(
      "on",
      {},
      {
        a: { config: { otherPrs: true, otherApprove: false } },
        b: { config: { otherApprove: false } },
      },
    );
    expect(approveHeaderLoss(t, ["a", "b"], true)).toEqual({ projects: ["a"], epics: 0 });
  });
});

describe("people", () => {
  it("an own list replaces the default, matching the default drops it, and reset returns to it", () => {
    const t = scopes("on", { otherAuthors: "alice, bob" }, { a: { config: { otherAuthors: "carol" } }, b: {} });
    expect(peopleIn(t, "a")).toEqual(["carol"]);
    expect(peopleIn(t, "b")).toEqual(["alice", "bob"]);
    expect(peopleRowWrite(t, "a", ["bob", "alice"])).toEqual({
      target: { kind: "project", id: "a" },
      config: { otherAuthors: undefined },
    });
    expect(peopleRowWrite(t, "b", ["dan"])).toEqual({
      target: { kind: "project", id: "b" },
      config: { otherAuthors: "dan" },
    });
    expect(peopleResetWrite("a")).toEqual({
      target: { kind: "project", id: "a" },
      config: { otherAuthors: undefined },
    });
  });

  it("an empty own list is nobody, not the default", () => {
    const t = scopes("on", { otherAuthors: "alice" }, { a: { config: { otherAuthors: "" } } });
    expect(peopleIn(t, "a")).toEqual([]);
  });

  it("offers names already used on the board, without repeats", () => {
    const t = scopes("on", { otherAuthors: "alice" }, { a: { config: { otherAuthors: "carol, alice" } }, b: {} });
    expect(peopleRoster(t, ["Mara", null])).toEqual(["alice", "carol", "mara"]);
  });

  it("toggles a name in and out", () => {
    expect(togglePerson(["a"], "b")).toEqual(["a", "b"]);
    expect(togglePerson(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("reviewRowDiffers", () => {
  it("sees a differing source, Preview, Approve or an own list; hidden values don't count", () => {
    expect(reviewRowDiffers(scopes("on", {}, { a: {} }), "a")).toBe(false);
    expect(reviewRowDiffers(scopes("on", {}, { a: { config: { otherPrs: true } } }), "a")).toBe(true);
    expect(reviewRowDiffers(scopes("on", {}, { a: { mode: "preview" } }), "a")).toBe(true);
    expect(reviewRowDiffers(scopes("on", {}, { a: { config: { otherApprove: true } } }), "a")).toBe(false);
    expect(reviewRowDiffers(scopes("on", { otherPrs: true }, { a: { config: { otherAuthors: "x" } } }), "a")).toBe(
      true,
    );
  });
});

describe("reviewNewProjects", () => {
  it("says what the board gives new projects", () => {
    expect(reviewNewProjects(scopes("on", { otherPrs: true }, {}))).toBe("New projects: your PRs on, others' on.");
    expect(reviewNewProjects(scopes("inherit", {}, {}))).toBe("New projects: your PRs off, others' off.");
    expect(reviewNewProjects(scopes("preview", {}, {}))).toBe("New projects: your PRs in Preview, others' off.");
  });
});
