import { describe, expect, it } from "vitest";
import { ALL_PROJECTS_VALUE as ALL, nextProjectScope } from "./projectScope.logic";

describe("nextProjectScope", () => {
  it("ticks just that project when one is picked while All projects is shown", () => {
    expect(nextProjectScope([ALL], [ALL, "b"])).toEqual(["b"]);
  });

  it("clears the scope when All projects is picked while projects are ticked", () => {
    expect(nextProjectScope(["a", "b"], ["a", "b", ALL])).toEqual([]);
  });

  it("stays on the whole board when All projects is picked while it is shown", () => {
    expect(nextProjectScope([ALL], [])).toEqual([]);
  });

  it("adds to and removes from a subset", () => {
    expect(nextProjectScope(["a"], ["a", "c"])).toEqual(["a", "c"]);
    expect(nextProjectScope(["a", "c"], ["a"])).toEqual(["a"]);
  });

  it("is the whole board when the last project is unticked", () => {
    expect(nextProjectScope(["a"], [])).toEqual([]);
  });
});
