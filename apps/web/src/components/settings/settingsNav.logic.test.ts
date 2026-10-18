import { describe, expect, it } from "vitest";
import {
  activeSectionId,
  editorListSection,
  isSettingsGroup,
  parseSettingsTarget,
  resolveSettingsProject,
  sectionOf,
  SETTINGS_GROUPS,
  settingsCrumbs,
  settingsPaletteEntries,
} from "./settingsNav.logic";

describe("SETTINGS_GROUPS", () => {
  it("gives every section a unique id under its group", () => {
    const ids = SETTINGS_GROUPS.flatMap((group) => group.sections.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of SETTINGS_GROUPS) {
      for (const section of group.sections) expect(section.id.startsWith(`${group.id}.`)).toBe(true);
    }
  });

  it("gives Keybindings a section per keybinding group, which rows of that group sit under", () => {
    const keybindings = SETTINGS_GROUPS.find((group) => group.id === "keybindings")!;
    expect(keybindings.sections.map((entry) => entry.label)).toEqual(["General", "Navigation"]);
    expect(sectionOf("keybindings.general.palette.open")?.id).toBe("keybindings.general");
    expect(parseSettingsTarget("keybindings.navigation")).toEqual({
      group: "keybindings",
      anchor: "keybindings.navigation",
    });
  });
});

describe("parseSettingsTarget", () => {
  it("splits a target into its group and the anchor to scroll to", () => {
    expect(parseSettingsTarget("tasks")).toEqual({ group: "tasks", anchor: null });
    expect(parseSettingsTarget("tasks.review")).toEqual({ group: "tasks", anchor: "tasks.review" });
    expect(parseSettingsTarget("integrations.claude-code.cli-path")).toEqual({
      group: "integrations",
      anchor: "integrations.claude-code.cli-path",
    });
  });

  it("rejects a target outside the groups", () => {
    expect(parseSettingsTarget("nope.thing")).toBeNull();
    expect(isSettingsGroup("nope")).toBe(false);
    expect(isSettingsGroup("project")).toBe(true);
  });
});

describe("sectionOf", () => {
  it("maps a section or a row inside it to the section", () => {
    expect(sectionOf("autopilot.engine")?.label).toBe("Autopilot");
    expect(sectionOf("autopilot.engine.quiet-hours")?.id).toBe("autopilot.engine");
    expect(sectionOf("integrations.claude-code.cli-path")?.id).toBe("integrations.claude-code");
  });

  it("doesn't match a section whose id is only a prefix of another word", () => {
    expect(sectionOf("tasks.reviewer")).toBeNull();
    expect(sectionOf("unknown")).toBeNull();
  });
});

describe("editorListSection", () => {
  it("returns each editor to the section listing what it edits", () => {
    expect(editorListSection("tasks")).toBe("tasks.new-tasks");
    expect(editorListSection("autopilot")).toBe("autopilot.custom");
    expect(editorListSection("project")).toBe("project.recurring");
    expect(editorListSection("board")).toBe("board");
  });

  it("names sections that exist", () => {
    for (const group of ["tasks", "autopilot", "project"] as const) {
      expect(sectionOf(editorListSection(group))?.id).toBe(editorListSection(group));
    }
  });
});

describe("activeSectionId", () => {
  const sections = [
    { id: "a", top: 0 },
    { id: "b", top: 400 },
    { id: "c", top: 900 },
  ];

  it("picks the last section whose top has reached the threshold", () => {
    expect(activeSectionId(sections, { atBottom: false, threshold: 96 })).toBe("a");
    const scrolled = sections.map((s) => ({ ...s, top: s.top - 350 }));
    expect(activeSectionId(scrolled, { atBottom: false, threshold: 96 })).toBe("b");
  });

  it("falls back to the first before any has reached it", () => {
    const below = sections.map((s) => ({ ...s, top: s.top + 200 }));
    expect(activeSectionId(below, { atBottom: false })).toBe("a");
  });

  it("picks the last at the bottom, even when it is too short to reach the threshold", () => {
    expect(activeSectionId(sections, { atBottom: true })).toBe("c");
  });

  it("is null without sections", () => {
    expect(activeSectionId([], { atBottom: false })).toBeNull();
  });
});

describe("resolveSettingsProject", () => {
  const projects = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];

  it("prefers the requested project, then the board's, then the first", () => {
    expect(resolveSettingsProject(projects, "p3", "p2")?.id).toBe("p3");
    expect(resolveSettingsProject(projects, undefined, "p2")?.id).toBe("p2");
    expect(resolveSettingsProject(projects, "gone", "p2")?.id).toBe("p2");
    expect(resolveSettingsProject(projects, "gone", "gone too")?.id).toBe("p1");
    expect(resolveSettingsProject([], "p1", null)).toBeNull();
  });
});

describe("settingsCrumbs", () => {
  it("lists Settings, the group and the open editor", () => {
    expect(settingsCrumbs("tasks", null)).toEqual(["Settings", "Tasks"]);
    expect(settingsCrumbs("tasks", "Template: Bug")).toEqual(["Settings", "Tasks", "Template: Bug"]);
  });
});

describe("settingsPaletteEntries", () => {
  it("has an entry per group and per section, groups marked", () => {
    const entries = settingsPaletteEntries();
    expect(entries.filter((e) => e.isGroup).map((e) => e.title)).toEqual([
      "Settings: Board",
      "Settings: Keybindings",
      "Settings: Tasks",
      "Settings: Autopilot",
      "Settings: Integrations",
      "Settings: Project",
    ]);
    const review = entries.find((e) => e.target === "tasks.review");
    expect(review).toMatchObject({ title: "Settings: Review", isGroup: false });
    expect(review?.searchTerms).toContain("Tasks");
    // No second "Settings: Autopilot" for the Autopilot page's own section.
    expect(entries.filter((e) => e.title === "Settings: Autopilot")).toHaveLength(1);
  });
});
