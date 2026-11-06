import { describe, expect, it } from "vitest";
import { restoredProjectScope } from "./projectScope.logic";

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
