import { describe, expect, it } from "vitest";
import { createBoardRestorer, restoredProjectScope, scopeToRemember } from "./projectScope.logic";

describe("restoredProjectScope", () => {
  it("scopes a bare board to the remembered projects", () => {
    expect(restoredProjectScope("/", {}, ["a", "b"])).toBe("a,b");
  });

  it("leaves the board alone when nothing is remembered", () => {
    expect(restoredProjectScope("/", {}, [])).toBeUndefined();
  });

  it("keeps an explicit ?project=", () => {
    expect(restoredProjectScope("/", { project: "c" }, ["a", "b"])).toBeUndefined();
  });

  it("keeps the in-progress filter, which looks across every project", () => {
    expect(restoredProjectScope("/", { inprogress: true }, ["a"])).toBeUndefined();
  });

  it("only restores on the board, not on another page", () => {
    expect(restoredProjectScope("/settings/board", {}, ["a"])).toBeUndefined();
  });

  it("writes the ids as the URL would, without blanks or repeats", () => {
    expect(restoredProjectScope("/", {}, ["a", "", "a", "b"])).toBe("a,b");
  });
});

describe("scopeToRemember", () => {
  it("remembers the scope the board shows, All projects included", () => {
    expect(scopeToRemember("/", { project: "a,b" })).toEqual(["a", "b"]);
    expect(scopeToRemember("/", {})).toEqual([]);
  });

  it("drops ids of projects that no longer exist once the board is known", () => {
    expect(scopeToRemember("/", { project: "gone,b,a" }, ["a", "b", "c"])).toEqual(["a", "b"]);
    expect(scopeToRemember("/", { project: "gone" }, ["a"])).toEqual([]);
  });

  it("leaves what is remembered alone off the board and under the in-progress filter", () => {
    expect(scopeToRemember("/settings/project", { project: "a" })).toBeNull();
    expect(scopeToRemember("/", { inprogress: true })).toBeNull();
  });
});

describe("createBoardRestorer", () => {
  it("restores the first bare board, even when the app started on another page", () => {
    const restore = createBoardRestorer(() => ["a"]);
    expect(restore("/settings/board", {})).toBeUndefined();
    expect(restore("/", {})).toBe("a");
  });

  it("answers once, so a later bare board (All projects) is left alone", () => {
    const restore = createBoardRestorer(() => ["a"]);
    expect(restore("/", {})).toBe("a");
    expect(restore("/", {})).toBeUndefined();
  });

  it("counts a first board that already has its own scope as the first", () => {
    const restore = createBoardRestorer(() => ["a"]);
    expect(restore("/", { project: "b" })).toBeUndefined();
    expect(restore("/", {})).toBeUndefined();
  });
});
