import { describe, expect, it } from "vitest";
import {
  filterScopeOptions,
  isScopedGroup,
  rowIsInert,
  scopeProject,
  scopeProjects,
  scopeSearch,
  usesScopeSearch,
} from "./settingsScope.logic";

const project = (id: string, position: string, archivedAt: string | null = null) => ({ id, position, archivedAt });

describe("isScopedGroup", () => {
  it("is the pages with per-project settings", () => {
    expect(["tasks", "agents", "autopilot", "project"].every((g) => isScopedGroup(g as never))).toBe(true);
    expect(isScopedGroup("board")).toBe(false);
    expect(isScopedGroup("keybindings")).toBe(false);
    expect(isScopedGroup("integrations")).toBe(false);
    expect(isScopedGroup(null)).toBe(false);
  });
});

describe("scopeProject", () => {
  const projects = [project("a", "1"), project("b", "2", "2026-01-01T00:00:00.000Z")];

  it("finds the project asked for", () => {
    expect(scopeProject(projects, "a")?.id).toBe("a");
  });

  it("reads a missing, unknown or archived id as All projects", () => {
    expect(scopeProject(projects, undefined)).toBeNull();
    expect(scopeProject(projects, "gone")).toBeNull();
    expect(scopeProject(projects, "b")).toBeNull();
    expect(scopeProject(undefined, "a")).toBeNull();
  });
});

describe("scopeProjects", () => {
  it("lists live projects in sidebar order", () => {
    const list = scopeProjects([project("c", "3"), project("a", "1"), project("x", "2", "2026-01-01T00:00:00.000Z")]);
    expect(list.map((p) => p.id)).toEqual(["a", "c"]);
  });
});

describe("usesScopeSearch", () => {
  it("switches to a search box past six projects", () => {
    expect(usesScopeSearch(6)).toBe(false);
    expect(usesScopeSearch(7)).toBe(true);
  });
});

describe("filterScopeOptions", () => {
  const options = [{ label: "All projects" }, { label: "Storefront" }, { label: "Billing" }];

  it("matches titles ignoring case and spaces", () => {
    expect(filterScopeOptions(options, "  STORE ").map((o) => o.label)).toEqual(["Storefront"]);
  });

  it("keeps everything for an empty query", () => {
    expect(filterScopeOptions(options, " ")).toHaveLength(3);
  });
});

describe("scopeSearch", () => {
  it("carries a project and drops none", () => {
    expect(scopeSearch("a")).toEqual({ project: "a" });
    expect(scopeSearch(null)).toEqual({});
    expect(scopeSearch(undefined)).toEqual({});
  });
});

describe("rowIsInert", () => {
  it("dims only board-wide rows, and only in project scope", () => {
    expect(rowIsInert("board", true)).toBe(true);
    expect(rowIsInert("project", true)).toBe(false);
    expect(rowIsInert("any", true)).toBe(false);
    expect(rowIsInert("board", false)).toBe(false);
  });
});
