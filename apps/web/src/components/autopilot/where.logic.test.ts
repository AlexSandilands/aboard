import type { BoardSnapshot, WhereInput } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { scopeIsOn, scopeToggle, turnsOn, whereScopes } from "./where.logic";

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
