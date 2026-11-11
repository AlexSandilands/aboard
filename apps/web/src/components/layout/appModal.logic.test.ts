import { describe, expect, it } from "vitest";
import { boardSearchAt, isAppModalPath, showsBoard } from "./appModal.logic";

describe("isAppModalPath", () => {
  it("is true for Settings, its pages and editors, and Stats", () => {
    for (const path of ["/settings", "/settings/board", "/settings/tasks/templates/new", "/stats"])
      expect(isAppModalPath(path)).toBe(true);
  });

  it("is false for the board, the social feed and look-alike paths", () => {
    for (const path of ["/", "/social", "/settingsx", "/stats/more", "/__gallery"])
      expect(isAppModalPath(path)).toBe(false);
  });
});

describe("showsBoard", () => {
  it("is true on the board and behind a window, and false on a page of its own", () => {
    expect(showsBoard("/")).toBe(true);
    expect(showsBoard("/settings/agents")).toBe(true);
    expect(showsBoard("/stats")).toBe(true);
    expect(showsBoard("/social")).toBe(false);
  });
});

describe("boardSearchAt", () => {
  const url = { project: "settings-project" };
  const kept = { project: "a,b", task: "t1" };

  it("reads the URL on the board", () => {
    expect(boardSearchAt("/", url, kept)).toBe(url);
  });

  it("keeps the board as it was left behind a window, whatever the window's own search says", () => {
    expect(boardSearchAt("/settings/project", url, kept)).toBe(kept);
    expect(boardSearchAt("/stats", url, kept)).toBe(kept);
  });
});
