import type { BoardSnapshot, WhereInput } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  columnState,
  draftHeader,
  draftRowOn,
  draftRowToggle,
  filterProjects,
  headerLoss,
  headerTurnsOn,
  ownSettingsLabel,
  PROJECT_CHIPS_MAX,
  scopeIsOn,
  scopeToggle,
  tableProjects,
  turnsOn,
  usesProjectSearch,
  whereScopes,
} from "./where.logic";

const project = (id: string, title: string, position: string, archivedAt: string | null = null) => ({
  id,
  title,
  position,
  archivedAt,
});
const task = (id: string, number: number, projectId: string, kind: string, archivedAt: string | null = null) => ({
  id,
  number,
  projectId,
  kind,
  archivedAt,
  title: `Task ${number}`,
});

const board = {
  projects: [project("p2", "docs", "b"), project("p1", "storefront", "a"), project("p3", "old", "c", "2026-01-01")],
  tasks: [
    task("e7", 7, "p2", "epic"),
    task("e5", 5, "p1", "epic"),
    task("e9", 9, "p1", "epic", "2026-02-01"),
    task("e11", 11, "p3", "epic"),
    task("t1", 1, "p1", "task"),
  ],
  generalProjectId: "p2",
} as unknown as BoardSnapshot;

describe("whereScopes", () => {
  it("lists the projects in lane order and the epics still in use, by number", () => {
    expect(whereScopes(board, true)).toEqual({
      projects: [
        { id: "p1", title: "storefront" },
        { id: "p2", title: "docs" },
      ],
      epics: [
        { id: "e5", number: 5, projectId: "p1", title: "Task 5" },
        { id: "e7", number: 7, projectId: "p2", title: "Task 7" },
      ],
      generalId: "p2",
    });
  });

  it("has no epics for an automation an epic can't switch", () => {
    expect(whereScopes(board, false)?.epics).toEqual([]);
  });

  it("waits for the board", () => {
    expect(whereScopes(undefined, true)).toBeNull();
  });
});

const input = (
  boardMode: WhereInput["board"],
  p1: WhereInput["board"] = "inherit",
  e5: WhereInput["board"] = "inherit",
): WhereInput => ({
  board: boardMode,
  projects: [
    { id: "p1", title: "storefront", mode: p1 },
    { id: "p2", title: "docs", mode: "inherit" },
  ],
  epics: [{ id: "e5", number: 5, projectId: "p1", mode: e5 }],
});

describe("scopeIsOn", () => {
  it("says what the engine would do at a project", () => {
    expect(scopeIsOn(input("on"), { kind: "project", id: "p1" })).toBe(true);
    expect(scopeIsOn(input("on", "off"), { kind: "project", id: "p1" })).toBe(false);
    expect(scopeIsOn(input("inherit", "on"), { kind: "project", id: "p1" })).toBe(true);
    expect(scopeIsOn(input("inherit"), { kind: "project", id: "p2" })).toBe(false);
  });

  it("follows the epic's project unless the epic sets itself", () => {
    expect(scopeIsOn(input("on"), { kind: "epic", id: "e5" })).toBe(true);
    expect(scopeIsOn(input("on", "off"), { kind: "epic", id: "e5" })).toBe(false);
    expect(scopeIsOn(input("on", "off", "on"), { kind: "epic", id: "e5" })).toBe(true);
    expect(scopeIsOn(input("on", "inherit", "off"), { kind: "epic", id: "e5" })).toBe(false);
  });

  it("is null for a scope that isn't there, so a row waits instead of showing a made-up state", () => {
    expect(scopeIsOn(input("on"), { kind: "project", id: "gone" })).toBeNull();
    expect(scopeIsOn(input("on"), { kind: "epic", id: "gone" })).toBeNull();
  });
});

describe("scopeToggle", () => {
  it("switches a project off with an override, and back on by following the board", () => {
    expect(scopeToggle(input("on"), { kind: "project", id: "p1" }, false)).toEqual([
      { target: { kind: "project", id: "p1" }, mode: "off" },
    ]);
    expect(scopeToggle(input("on", "off"), { kind: "project", id: "p1" }, true)).toEqual([
      { target: { kind: "project", id: "p1" }, mode: "inherit" },
    ]);
  });

  it("switches a project on under Only in… and off again without leaving a row", () => {
    expect(scopeToggle(input("inherit"), { kind: "project", id: "p1" }, true)).toEqual([
      { target: { kind: "project", id: "p1" }, mode: "on" },
    ]);
    expect(scopeToggle(input("inherit", "on"), { kind: "project", id: "p1" }, false)).toEqual([
      { target: { kind: "project", id: "p1" }, mode: "inherit" },
    ]);
  });

  it("switches an epic against its project, saved through the project", () => {
    expect(scopeToggle(input("on"), { kind: "epic", id: "e5" }, false)).toEqual([
      { target: { kind: "epic", id: "e5", projectId: "p1" }, mode: "off" },
    ]);
  });

  it("does nothing when the scope already is as asked", () => {
    expect(scopeToggle(input("on"), { kind: "project", id: "p2" }, true)).toEqual([]);
  });
});

describe("turnsOn", () => {
  it("is true when a write switches something on, which a blocked automation refuses", () => {
    expect(turnsOn([{ target: { kind: "board" }, mode: "on" }])).toBe(true);
    expect(turnsOn([{ target: { kind: "project", id: "p1" }, mode: "off" }])).toBe(false);
    expect(turnsOn([{ target: { kind: "project", id: "p1" }, mode: "inherit" }])).toBe(false);
    expect(turnsOn([])).toBe(false);
  });
});

describe("ownSettingsLabel", () => {
  const automation = {
    fields: [
      { key: "skill", label: "Skill", kind: "text" },
      { key: "days", label: "After", kind: "number" },
    ],
  } as never;

  it("names the settings a project sets for itself by their labels", () => {
    expect(ownSettingsLabel(automation, { days: 3, skill: "x" })).toBe("After, Skill");
  });

  it("lists a key the automation no longer has by its name, and says nothing when there is none", () => {
    expect(ownSettingsLabel(automation, { nudge: true })).toBe("nudge");
    expect(ownSettingsLabel(automation, {})).toBeNull();
  });
});

describe("tableProjects", () => {
  const scopes = {
    projects: [
      { id: "p1", title: "storefront" },
      { id: "g", title: "General" },
    ],
    epics: [],
    generalId: "g",
  };

  it("leaves General out only for an automation that needs a repository", () => {
    expect(tableProjects(scopes, true).map((p) => p.id)).toEqual(["p1"]);
    expect(tableProjects(scopes, false).map((p) => p.id)).toEqual(["p1", "g"]);
  });

  it("keeps every project when there is no General", () => {
    expect(tableProjects({ ...scopes, generalId: null }, true).map((p) => p.id)).toEqual(["p1", "g"]);
  });
});

describe("the table's header", () => {
  it("reads on, off or mixed from its rows", () => {
    expect(columnState([true, true])).toBe("on");
    expect(columnState([false, false])).toBe("off");
    expect(columnState([true, false])).toBe("mixed");
  });

  it("turns on only from all off: mixed counts as on somewhere", () => {
    expect(headerTurnsOn("off")).toBe(true);
    expect(headerTurnsOn("mixed")).toBe(false);
    expect(headerTurnsOn("on")).toBe(false);
  });

  const where = (
    boardMode: WhereInput["board"],
    modes: Array<WhereInput["board"]>,
    epics: Array<WhereInput["board"]> = [],
  ) =>
    ({
      board: boardMode,
      projects: modes.map((mode, i) => ({ id: `p${i}`, title: `project ${i}`, mode })),
      epics: epics.map((mode, i) => ({ id: `e${i}`, number: i, projectId: "p0", mode })),
    }) satisfies WhereInput;
  const shown = ["p0", "p1", "p2"];

  it("warns before switching off the projects and epics that set their own On or Preview", () => {
    expect(headerLoss(where("off", ["on", "preview", "off"], ["on", "off"]), shown, false)).toEqual({
      projects: ["project 0", "project 1"],
      epics: 1,
    });
    // A project set Off stays Off, so it isn't lost.
    expect(headerLoss(where("on", ["off", "inherit", "inherit"]), shown, false)).toBeNull();
  });

  it("warns before turning on over projects set Off, under a board that is off too", () => {
    expect(headerLoss(where("on", ["off", "off", "off"]), shown, true)).toEqual({
      projects: ["project 0", "project 1", "project 2"],
      epics: 0,
    });
    // The click would start it in a project someone excluded, though the row shows nothing yet.
    expect(headerLoss(where("off", ["off", "inherit", "inherit"]), shown, true)).toEqual({
      projects: ["project 0"],
      epics: 0,
    });
    expect(headerLoss(where("off", ["inherit", "inherit", "inherit"]), shown, true)).toBeNull();
  });

  it("doesn't warn about a project the table doesn't list", () => {
    expect(headerLoss(where("off", ["on", "inherit"]), ["p1"], false)).toBeNull();
    expect(headerLoss(where("on", ["off", "inherit"]), ["p1"], true)).toBeNull();
  });
});

describe("a draft's table", () => {
  const all = ["a", "b", "c"];

  it("reads a row as on under Everywhere or when picked", () => {
    expect(draftRowOn({ everywhere: true, projectIds: [] }, "a")).toBe(true);
    expect(draftRowOn({ everywhere: false, projectIds: ["b"] }, "a")).toBe(false);
    expect(draftRowOn({ everywhere: false, projectIds: ["b"] }, "b")).toBe(true);
  });

  it("switching a row off under Everywhere picks all the others", () => {
    expect(draftRowToggle({ everywhere: true, projectIds: [] }, all, "b", false)).toEqual({
      everywhere: false,
      projectIds: ["a", "c"],
    });
  });

  it("adds and removes picked projects, dropping ones no longer listed", () => {
    expect(draftRowToggle({ everywhere: false, projectIds: ["a", "gone"] }, all, "c", true)).toEqual({
      everywhere: false,
      projectIds: ["a", "c"],
    });
    expect(draftRowToggle({ everywhere: false, projectIds: ["a", "c"] }, all, "a", false)).toEqual({
      everywhere: false,
      projectIds: ["c"],
    });
  });

  it("a header click leaves no project picked on its own", () => {
    expect(draftHeader(true)).toEqual({ everywhere: true, projectIds: [] });
    expect(draftHeader(false)).toEqual({ everywhere: false, projectIds: [] });
  });
});

describe("the project search", () => {
  it("shows past 8 projects", () => {
    expect(usesProjectSearch(0)).toBe(false);
    expect(usesProjectSearch(PROJECT_CHIPS_MAX)).toBe(false);
    expect(usesProjectSearch(PROJECT_CHIPS_MAX + 1)).toBe(true);
    expect(PROJECT_CHIPS_MAX).toBe(8);
  });

  it("finds projects by any part of their title, ignoring case", () => {
    const projects = [{ title: "storefront" }, { title: "payments-api" }, { title: "Store admin" }];
    expect(filterProjects(projects, " STORE ").map((p) => p.title)).toEqual(["storefront", "Store admin"]);
    expect(filterProjects(projects, "")).toHaveLength(3);
    expect(filterProjects(projects, "nothing")).toEqual([]);
  });
});
