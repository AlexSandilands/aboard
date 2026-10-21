import { describe, expect, it } from "vitest";
import { moveAmongVisible } from "./projectsOrder.logic";

describe("moveAmongVisible", () => {
  const all = ["a", "b", "c", "d", "e"];

  it("moves within the whole list when every project is listed", () => {
    expect(moveAmongVisible(all, all, "a", "c")).toEqual(["b", "c", "a", "d", "e"]);
    expect(moveAmongVisible(all, all, "e", "b")).toEqual(["a", "e", "b", "c", "d"]);
  });

  it("keeps hidden projects in their places around the listed ones", () => {
    // a, c and e are listed; b and d stay at positions 1 and 3.
    expect(moveAmongVisible(all, ["a", "c", "e"], "a", "e")).toEqual(["c", "b", "e", "d", "a"]);
    expect(moveAmongVisible(all, ["a", "c", "e"], "e", "a")).toEqual(["e", "b", "a", "d", "c"]);
  });

  it("is null when a project isn't listed", () => {
    expect(moveAmongVisible(all, ["a", "c"], "a", "b")).toBeNull();
    expect(moveAmongVisible(all, ["a", "c"], "x", "a")).toBeNull();
  });
});
