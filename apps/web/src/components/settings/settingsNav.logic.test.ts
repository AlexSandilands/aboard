import { describe, expect, it } from "vitest";
import {
  activeSectionId,
  automationOfTarget,
  autopilotTabOf,
  editorListSection,
  isEditorPath,
  isSettingsGroup,
  parseSettingsTarget,
  providerOfTarget,
  redirectSettingsTarget,
  resolveSettingsProject,
  sectionOf,
  SETTINGS_GROUPS,
  settingsCrumbs,
  settingsGroup,
  settingsPaletteEntries,
  visibleSections,
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
    expect(keybindings.sections.map((entry) => entry.label)).toEqual(["General", "Navigation", "Layout", "Tasks"]);
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
    expect(parseSettingsTarget("agents.providers.claude-code.cli-path")).toEqual({
      group: "agents",
      anchor: "agents.providers.claude-code.cli-path",
    });
  });

  it("reads a target on the old Providers and Models pages as the one on Agents", () => {
    expect(redirectSettingsTarget("providers")).toBe("agents.providers");
    expect(redirectSettingsTarget("providers.codex.cli-path")).toBe("agents.providers.codex.cli-path");
    expect(redirectSettingsTarget("models")).toBe("agents.models");
    expect(redirectSettingsTarget("models.custom.list")).toBe("agents.models.custom.list");
    expect(redirectSettingsTarget("models.operations.reviewer")).toBe("agents.operations.reviewer");
    expect(redirectSettingsTarget("modelsx")).toBe("modelsx");
  });

  it("reads a target from before Providers had its own page as the one it moved to", () => {
    expect(parseSettingsTarget("integrations.claude-code.cli-path")).toEqual({
      group: "agents",
      anchor: "agents.providers.claude-code.cli-path",
    });
    expect(redirectSettingsTarget("integrations.copilot")).toBe("agents.providers.copilot-cli");
    expect(redirectSettingsTarget("integrations.copilot.cli")).toBe("agents.providers.copilot-cli.mcp");
    expect(redirectSettingsTarget("integrations.copilot.cli-path")).toBe("agents.providers.copilot-cli.cli-path");
    expect(redirectSettingsTarget("integrations.t3-code.connection")).toBe("agents.providers.t3-code.status");
    expect(redirectSettingsTarget("integrations.codex.status")).toBe("agents.providers.codex.status");
    // What stayed in Integrations stays put, and a lookalike prefix isn't moved.
    expect(redirectSettingsTarget("integrations.github.poll-prs")).toBe("integrations.github.poll-prs");
    expect(redirectSettingsTarget("integrations.codexes")).toBe("integrations.codexes");
  });

  it("rejects a target outside the groups", () => {
    expect(parseSettingsTarget("nope.thing")).toBeNull();
    expect(isSettingsGroup("nope")).toBe(false);
    expect(isSettingsGroup("project")).toBe(true);
  });
});

describe("sectionOf", () => {
  it("maps a section or a row inside it to the section", () => {
    expect(sectionOf("autopilot.automations")?.label).toBe("Automations");
    expect(sectionOf("autopilot.limits.quiet-hours")?.id).toBe("autopilot.limits");
    expect(sectionOf("agents.providers.claude-code.cli-path")?.id).toBe("agents.providers");
  });

  it("doesn't match a section whose id is only a prefix of another word", () => {
    expect(sectionOf("tasks.reviewer")).toBeNull();
    expect(sectionOf("unknown")).toBeNull();
  });
});

describe("providers in the list", () => {
  it("reads the provider a target is about", () => {
    expect(providerOfTarget("agents.providers.codex.cli-path")).toBe("codex");
    expect(providerOfTarget("agents.providers.copilot-cli")).toBe("copilot-cli");
    expect(providerOfTarget("agents.providers")).toBeNull();
    expect(providerOfTarget("agents.providers.gemini")).toBeNull();
    expect(providerOfTarget("agents.models.codex")).toBeNull();
    expect(providerOfTarget("tasks.codex")).toBeNull();
    expect(providerOfTarget(null)).toBeNull();
  });

  it("shows only Providers on Agents until one is added, and every other group's sections", () => {
    const agents = settingsGroup("agents");
    expect(visibleSections(agents, []).map((s) => s.id)).toEqual(["agents.providers"]);
    expect(visibleSections(agents, [{ id: "codex" }]).map((s) => s.id)).toEqual([
      "agents.providers",
      "agents.models",
      "agents.operations",
    ]);
    expect(visibleSections(settingsGroup("tasks"), undefined)).toBe(settingsGroup("tasks").sections);
  });
});

describe("editorListSection", () => {
  it("returns each editor to the section listing what it edits", () => {
    expect(editorListSection("tasks")).toBe("tasks.new-tasks");
    expect(editorListSection("autopilot")).toBe("autopilot.automations");
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
      "Settings: Agents",
      "Settings: Autopilot",
      "Settings: Integrations",
      "Settings: Project",
    ]);
    const review = entries.find((e) => e.target === "tasks.review");
    expect(review).toMatchObject({ title: "Settings: Review", isGroup: false });
    expect(review?.searchTerms).toContain("Tasks");
    // No second "Settings: Autopilot" for the Autopilot page's own section.
    expect(entries.filter((e) => e.title === "Settings: Autopilot")).toHaveLength(1);
    expect(entries.filter((e) => e.title === "Settings: Models")).toHaveLength(1);
  });

  it("sends the model settings that moved to where they are now", () => {
    expect(redirectSettingsTarget("models.tiers.custom")).toBe("agents.models.custom.list");
    expect(redirectSettingsTarget("models.tiers")).toBe("agents.models.tiers.list");
    expect(redirectSettingsTarget("models.tiers.custom.codex61")).toBe("agents.models.custom.codex61");
    expect(redirectSettingsTarget("tasks.review.model")).toBe("agents.operations.reviewer");
    expect(redirectSettingsTarget("tasks.new-tasks.import-model")).toBe("agents.operations.issueImport");
    expect(parseSettingsTarget("project.review-skill.model")).toEqual({
      group: "project",
      anchor: "project.models.reviewer",
    });
    expect(redirectSettingsTarget("tasks.review.rounds")).toBe("tasks.review.rounds");
  });

  it("finds the Models section by the old names for its settings", () => {
    const group = settingsPaletteEntries().find((e) => e.target === "agents");
    expect(group?.isGroup).toBe(true);
    expect(parseSettingsTarget("models.tiers.light")).toEqual({ group: "agents", anchor: "agents.models.tiers.light" });
    expect(sectionOf("agents.models.tiers.light")?.id).toBe("agents.models");
    expect(settingsGroup("agents").sections[1]?.keywords).toEqual(expect.arrayContaining(["session model", "--model"]));
  });
});

describe("the Autopilot tabs", () => {
  it("sends the old page's anchors to where they are now", () => {
    expect(redirectSettingsTarget("autopilot.engine")).toBe("autopilot.automations");
    expect(redirectSettingsTarget("autopilot.engine.pr-review-rounds")).toBe("autopilot.automations.review_prs");
    expect(redirectSettingsTarget("autopilot.limits.pr-fix-threshold")).toBe("autopilot.automations.fix_prs");
    expect(redirectSettingsTarget("autopilot.limits.quiet-hours")).toBe("autopilot.limits.quiet-hours");
    expect(redirectSettingsTarget("autopilot.engine.settings")).toBe("autopilot.limits");
    expect(redirectSettingsTarget("autopilot.engine.quiet-hours")).toBe("autopilot.limits.quiet-hours");
    expect(redirectSettingsTarget("autopilot.engine.pause-all")).toBe("autopilot.automations.pause-all");
    expect(redirectSettingsTarget("autopilot.engine.automation-fix_prs")).toBe("autopilot.automations.fix_prs");
    expect(redirectSettingsTarget("autopilot.engine.orchestrate")).toBe("autopilot.automations.orchestrate");
    expect(redirectSettingsTarget("autopilot.engine.orchestrate.countdown")).toBe(
      "board.appearance.autopilot-countdown",
    );
    expect(redirectSettingsTarget("autopilot.custom")).toBe("autopilot.automations");
    expect(redirectSettingsTarget("autopilot.custom.variables.list")).toBe("autopilot.limits.variables.list");
    // Today's targets stay as they are.
    expect(redirectSettingsTarget("autopilot.limits.dry-run")).toBe("autopilot.limits.dry-run");
    expect(redirectSettingsTarget("autopilot.automations.digest")).toBe("autopilot.automations.digest");
  });

  it("parses an old anchor as the tab it is on now", () => {
    expect(parseSettingsTarget("autopilot.engine.dry-run")).toEqual({
      group: "autopilot",
      anchor: "autopilot.limits.dry-run",
    });
  });

  it("knows which tab a target is on", () => {
    expect(autopilotTabOf("autopilot.limits.quiet-hours")).toBe("limits");
    expect(autopilotTabOf("autopilot.runs")).toBe("runs");
    expect(autopilotTabOf("autopilot.automations.fix_prs")).toBe("automations");
    expect(autopilotTabOf("autopilot.limitsx")).toBe("automations");
    expect(autopilotTabOf(null)).toBe("automations");
  });

  it("reads the automation a target picks, but not the tab's own rows", () => {
    expect(automationOfTarget("autopilot.automations.review_prs")).toBe("review_prs");
    expect(automationOfTarget("autopilot.automations.custom:abc")).toBe("custom:abc");
    expect(automationOfTarget("autopilot.automations.pause-all")).toBeNull();
    expect(automationOfTarget("autopilot.automations")).toBeNull();
    expect(automationOfTarget("autopilot.limits.dry-run")).toBeNull();
  });

  it("counts the Runs and Limits tabs as pages, not editors", () => {
    expect(isEditorPath("/settings/autopilot")).toBe(false);
    expect(isEditorPath("/settings/autopilot/limits")).toBe(false);
    expect(isEditorPath("/settings/autopilot/runs/all")).toBe(false);
    expect(isEditorPath("/settings/autopilot/custom/new")).toBe(true);
    expect(isEditorPath("/settings/tasks/templates/new")).toBe(true);
  });
});
