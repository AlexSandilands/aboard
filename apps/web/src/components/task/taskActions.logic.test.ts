import { describe, expect, it } from "vitest";
import {
  DEFAULT_PINS,
  menuActions,
  migrateTaskPanelPrefs,
  normalizePins,
  pinnedButtons,
  togglePin,
} from "./taskActions.logic";

const open = { resolution: null, archivedAt: null, status: "in_progress", kind: "task" } as const;

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
  it("offers jump first, archived tasks included: Show archived can put their card on the board", () => {
    expect(menuActions(open)[0]).toBe("jump");
    const archived = { ...open, archivedAt: "2026-10-14T00:00:00Z" };
    expect(menuActions(archived)[0]).toBe("jump");
    expect(menuActions({ ...archived, kind: "epic" })[0]).toBe("jump");
  });
  it("offers an epic no plan or reopen", () => {
    const epic = { ...open, kind: "epic" } as const;
    expect(menuActions(epic)).toEqual(["jump", "archive", "copy-link", "copy-reference"]);
    expect(pinnedButtons(["archive"], { ...epic, status: "done" })).toEqual(["archive"]);
  });
});

describe("pinnedButtons", () => {
  it("shows pins that apply to the task, in menu order", () => {
    expect(pinnedButtons(["copy-link", "reopen", "plan"], open)).toEqual(["plan", "copy-link"]);
  });
  it("shows jump leftmost", () => {
    expect(pinnedButtons(["plan", "jump"], open)).toEqual(["jump", "plan"]);
  });
  it("leaves archive to the top bar on unarchived done tasks", () => {
    expect(pinnedButtons(["archive"], { ...open, status: "done" })).toEqual([]);
    expect(pinnedButtons(["archive"], { ...open, status: "done", archivedAt: "2026-10-14T00:00:00Z" })).toEqual([
      "archive",
    ]);
    expect(pinnedButtons(["archive"], open)).toEqual(["archive"]);
  });
});

describe("migrateTaskPanelPrefs", () => {
  it("pins jump on top of the pins saved before it existed, in menu order", () => {
    expect(migrateTaskPanelPrefs({ pinnedActions: ["copy-link", "plan"], sections: { hidden: ["plan"] } }, 0)).toEqual({
      pinnedActions: ["jump", "plan", "copy-link"],
      sections: { hidden: ["plan"] },
    });
    expect(migrateTaskPanelPrefs({ pinnedActions: [] }, 0)).toEqual({ pinnedActions: ["jump"] });
  });
  it("copes with a save that has no pins or isn't an object", () => {
    expect(migrateTaskPanelPrefs({ sections: {} }, 0)).toEqual({ sections: {}, pinnedActions: ["jump"] });
    expect(migrateTaskPanelPrefs(null, 0)).toEqual({ pinnedActions: ["jump"] });
  });
  it("leaves a current save alone, so an unpinned jump stays unpinned", () => {
    const saved = { pinnedActions: ["plan"], sections: {} };
    expect(migrateTaskPanelPrefs(saved, 1)).toBe(saved);
  });
  it("starts new browsers with jump pinned", () => {
    expect(DEFAULT_PINS).toEqual(["jump"]);
  });
});
