import { describe, expect, it } from "vitest";
import { menuActions, normalizePins, pinnedButtons, togglePin } from "./taskActions.logic";

const open = { resolution: null, archivedAt: null, status: "in_progress" } as const;

describe("normalizePins", () => {
  it("keeps menu order and drops duplicates and unknown ids", () => {
    expect(normalizePins(["copy-link", "plan", "plan", "delete", 3, null])).toEqual(["plan", "copy-link"]);
  });
});

describe("togglePin", () => {
  it("adds in menu order, whatever order pins were made", () => {
    expect(togglePin(["copy-reference"], "plan")).toEqual(["plan", "copy-reference"]);
    expect(togglePin(["plan", "copy-reference"], "archive")).toEqual(["plan", "archive", "copy-reference"]);
  });
  it("removes a pinned action", () => {
    expect(togglePin(["plan", "copy-link"], "plan")).toEqual(["copy-link"]);
  });
});

describe("menuActions", () => {
  it("offers reopen only on closed tasks", () => {
    expect(menuActions(open)).not.toContain("reopen");
    expect(menuActions({ ...open, resolution: "wont_do", status: "done" })).toContain("reopen");
  });
});

describe("pinnedButtons", () => {
  it("shows pins that apply to the task, in menu order", () => {
    expect(pinnedButtons(["copy-link", "reopen", "plan"], open)).toEqual(["plan", "copy-link"]);
  });
  it("leaves archive to the top bar on unarchived done tasks", () => {
    expect(pinnedButtons(["archive"], { ...open, status: "done" })).toEqual([]);
    expect(pinnedButtons(["archive"], { ...open, status: "done", archivedAt: "2026-10-14T00:00:00Z" })).toEqual([
      "archive",
    ]);
    expect(pinnedButtons(["archive"], open)).toEqual(["archive"]);
  });
});
