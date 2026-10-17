// Pure helpers for the settings page: its groups and sub-sections, scroll-spy and the project it shows.

export const SETTINGS_GROUP_IDS = ["board", "tasks", "autopilot", "integrations", "project"] as const;
export type SettingsGroupId = (typeof SETTINGS_GROUP_IDS)[number];

export interface SettingsSectionDef {
  /** Stable id, `<group>.<section>`: the element id and URL hash, and the prefix of its rows' ids. */
  id: string;
  label: string;
  /** Extra words the command palette matches on. */
  keywords: ReadonlyArray<string>;
}

export interface SettingsGroupDef {
  id: SettingsGroupId;
  label: string;
  sections: ReadonlyArray<SettingsSectionDef>;
}

const section = (id: string, label: string, keywords: ReadonlyArray<string> = []): SettingsSectionDef => ({
  id,
  label,
  keywords,
});

/** Every settings page and its sub-sections, in sidebar order. Section ids are stable: search targets them. */
export const SETTINGS_GROUPS: ReadonlyArray<SettingsGroupDef> = [
  {
    id: "board",
    label: "Board",
    sections: [
      section("board.appearance", "Appearance", ["theme", "dark", "light", "banner"]),
      section("board.notifications", "Notifications", ["pop-ups", "alerts", "quiet hours"]),
      section("board.keybindings", "Keybindings", ["shortcuts", "hotkeys", "keys", "keyboard", "when"]),
      section("board.data", "Data", ["backup", "git", "archived projects", "restore"]),
    ],
  },
  {
    id: "tasks",
    label: "Tasks",
    sections: [
      section("tasks.new-tasks", "New tasks", ["templates", "issue import", "jira", "github issues"]),
      section("tasks.review", "Review", ["local review", "rounds", "board reviewer", "skill", "budget"]),
      section("tasks.models", "Models", ["model tiers", "light", "standard", "deep"]),
    ],
  },
  {
    id: "autopilot",
    label: "Autopilot",
    sections: [
      section("autopilot.engine", "Autopilot", ["automations", "quiet hours", "pause", "dry run", "limits"]),
      section("autopilot.custom", "Custom automations", ["triggers", "commands"]),
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    sections: [
      section("integrations.t3-code", "T3 Code", ["pairing", "threads", "connection"]),
      section("integrations.claude-code", "Claude Code", ["mcp", "skill", "cli"]),
      section("integrations.copilot", "GitHub Copilot", ["mcp", "vs code", "cli"]),
      section("integrations.codex", "Codex", ["mcp"]),
      section("integrations.github", "GitHub", ["gh", "pull requests", "enterprise"]),
      section("integrations.jira", "Jira", ["base url"]),
      section("integrations.terminal", "Terminal", ["open in terminal", "windows terminal", "sessions"]),
    ],
  },
  {
    id: "project",
    label: "Project",
    sections: [
      section("project.general", "General", ["name", "icon", "folder", "workspace"]),
      section("project.review-skill", "Review skill"),
      section("project.autopilot", "Autopilot overrides", ["automations"]),
      section("project.recurring", "Recurring tasks", ["schedule", "rules"]),
      section("project.danger-zone", "Danger zone", ["archive", "delete"]),
    ],
  },
];

export function isSettingsGroup(value: unknown): value is SettingsGroupId {
  return typeof value === "string" && (SETTINGS_GROUP_IDS as ReadonlyArray<string>).includes(value);
}

export function settingsGroup(id: SettingsGroupId): SettingsGroupDef {
  return SETTINGS_GROUPS.find((group) => group.id === id)!;
}

/**
 * Where a settings target lives: a group (`"tasks"`), a section (`"tasks.review"`) or a row
 * (`"integrations.claude-code.cli-path"`). The group is the first segment; anything longer is the anchor to scroll
 * to. Null when the first segment isn't a group.
 */
export function parseSettingsTarget(target: string): { group: SettingsGroupId; anchor: string | null } | null {
  const group = target.split(".")[0];
  if (!isSettingsGroup(group)) return null;
  return { group, anchor: target === group ? null : target };
}

/** The sidebar section that holds an anchor (a section id, or a row id under one). */
export function sectionOf(anchor: string): SettingsSectionDef | null {
  for (const group of SETTINGS_GROUPS) {
    for (const entry of group.sections) {
      if (anchor === entry.id || anchor.startsWith(`${entry.id}.`)) return entry;
    }
  }
  return null;
}

/** The section listing what an editor sub-page edits, which leaving the editor returns to. */
export function editorListSection(group: SettingsGroupId): string {
  switch (group) {
    case "tasks":
      return "tasks.new-tasks";
    case "autopilot":
      return "autopilot.custom";
    case "project":
      return "project.recurring";
    default:
      return group;
  }
}

/** How far below the top of the scroll area a section's heading may sit and still count as the one being read. */
export const SPY_THRESHOLD_PX = 96;

/**
 * Scroll-spy: the section being read, given each section's top relative to the top of the visible scroll area, in
 * page order. It is the last one whose top has reached the threshold; before any has, the first. Scrolled to the
 * bottom, it is the last one, which may be too short ever to reach the threshold.
 */
export function activeSectionId(
  sections: ReadonlyArray<{ id: string; top: number }>,
  { atBottom, threshold = SPY_THRESHOLD_PX }: { atBottom: boolean; threshold?: number },
): string | null {
  if (sections.length === 0) return null;
  if (atBottom) return sections.at(-1)!.id;
  let active = sections[0]!.id;
  for (const entry of sections) {
    if (entry.top <= threshold) active = entry.id;
    else break;
  }
  return active;
}

/**
 * The project the project page shows: the one asked for in `?project=`, else the board's (its scope when Settings
 * opened), else the first. An id that is gone (deleted, or archived and so out of the snapshot) falls through.
 */
export function resolveSettingsProject<P extends { id: string }>(
  projects: ReadonlyArray<P>,
  requested: string | null | undefined,
  fallback: string | null | undefined,
): P | null {
  const byId = (id: string | null | undefined) => (id ? projects.find((p) => p.id === id) : undefined);
  return byId(requested) ?? byId(fallback) ?? projects[0] ?? null;
}

/** The top bar's crumbs: Settings, the group, then the editor open on a sub-page. */
export function settingsCrumbs(group: SettingsGroupId, editor: string | null): string[] {
  return ["Settings", settingsGroup(group).label, ...(editor ? [editor] : [])];
}

export interface SettingsPaletteEntry {
  /** The settings target: a group id or a section id. */
  target: string;
  title: string;
  searchTerms: string[];
  /** Groups always show; sections only once the user types, so the root list stays short. */
  isGroup: boolean;
}

/** "Settings: <group>" and "Settings: <section>" for the command palette. */
export function settingsPaletteEntries(): SettingsPaletteEntry[] {
  return SETTINGS_GROUPS.flatMap((group) => [
    {
      target: group.id,
      title: `Settings: ${group.label}`,
      searchTerms: ["preferences", ...group.sections.map((s) => s.label)],
      isGroup: true,
    },
    // A section named like its group (Autopilot's own) is the top of the group's page: the group entry covers it.
    ...group.sections
      .filter((entry) => entry.label !== group.label)
      .map((entry) => ({
        target: entry.id,
        title: `Settings: ${entry.label}`,
        searchTerms: ["preferences", group.label, ...entry.keywords],
        isGroup: false,
      })),
  ]);
}
