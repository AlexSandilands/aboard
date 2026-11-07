// Pure helpers for the settings page: its groups and sub-sections, scroll-spy, the project it shows and the provider
// its Providers page edits.
import { ProviderId } from "@repo/contracts";
import { keybindingGroups } from "./keybindings.logic";

export const SETTINGS_GROUP_IDS = [
  "board",
  "keybindings",
  "tasks",
  "agents",
  "autopilot",
  "integrations",
  "project",
] as const;
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
      section("board.appearance", "Appearance", ["theme", "dark", "light", "banner", "contrast", "font"]),
      section("board.notifications", "Notifications", ["pop-ups", "alerts", "quiet hours"]),
      section("board.data", "Data", ["backup", "git", "machine name", "archived projects", "restore"]),
    ],
  },
  {
    id: "keybindings",
    label: "Keybindings",
    // One sub-section per group of the keybinding registry, so a command in a new group needs no wiring here.
    sections: keybindingGroups().map(({ label, sectionId }) =>
      section(sectionId, label, ["shortcuts", "hotkeys", "keys", "keyboard", "when"]),
    ),
  },
  {
    id: "tasks",
    label: "Tasks",
    sections: [
      section("tasks.new-tasks", "New tasks", ["templates", "issue import", "tickets", "github issues"]),
      section("tasks.planning", "Planning", ["plan tasks", "planning skill", "bulk planning"]),
      section("tasks.review", "Review", ["local review", "rounds", "board reviewer", "skill", "budget"]),
      section("tasks.suggestions", "Suggestions", ["suggested changes", "prompts", "skills", "improve", "accept"]),
    ],
  },
  {
    id: "agents",
    label: "Agents",
    // Providers come first: until one is added, the other sections have nothing to set and are hidden.
    sections: [
      section("agents.providers", "Providers", [
        "t3 code",
        "claude code",
        "codex",
        "copilot",
        "mcp",
        "skill",
        "cli",
        "session",
        "pairing",
        "threads",
        "openai",
        "vs code",
        "add provider",
      ]),
      section("agents.models", "Models", [
        "light",
        "standard",
        "deep",
        "model",
        "suggested model",
        "session model",
        "--model",
        "t3 code",
        "claude code",
        "copilot",
        "codex",
        "effort",
        "preferred provider",
        "model tiers",
        "custom model",
        "profile",
        "label",
        "model per label",
      ]),
      section("agents.operations", "Operations", [
        "operation",
        "reviewer model",
        "board reviewer",
        "pr review",
        "fix prs",
        "orchestrate",
        "digest",
        "issue import",
        "ask",
        "headless",
        "automation model",
      ]),
    ],
  },
  {
    id: "autopilot",
    label: "Autopilot",
    // Three tabs of one page, each a sub-section: the list of automations, their run history, and the engine's limits.
    sections: [
      section("autopilot.automations", "Automations", [
        "custom automations",
        "needs you",
        "pause",
        "orchestrate",
        "triggers",
        "commands",
        "drafts",
        "import",
      ]),
      section("autopilot.runs", "Runs", ["run history", "history", "failed runs", "handover", "delete runs"]),
      section("autopilot.limits", "Limits & safety", [
        "limits",
        "quiet hours",
        "dry run",
        "caps",
        "concurrency",
        "variables",
        "worktrees",
      ]),
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    sections: [
      section("integrations.github", "GitHub", ["gh", "pull requests", "enterprise"]),
      section("integrations.tickets", "Ticket systems", ["jira", "linear", "issue keys", "presets"]),
      section("integrations.terminal", "Terminal", ["open in terminal", "windows terminal", "sessions"]),
    ],
  },
  {
    id: "project",
    label: "Project",
    sections: [
      section("project.general", "General", ["name", "icon", "folder", "workspace"]),
      section("project.plan-skill", "Planning skill"),
      section("project.review-skill", "Review skill"),
      section("project.models", "Reviewer model", ["models", "review model", "board reviewer"]),
      section("project.autopilot", "Automations", ["automations"]),
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

/** The provider sections that moved out of Integrations, by their old id. */
const MOVED_PROVIDER_SECTIONS: Record<string, ProviderId> = {
  "integrations.t3-code": "t3-code",
  "integrations.claude-code": "claude-code",
  "integrations.copilot": "copilot-cli",
  "integrations.codex": "codex",
};

/** Rows that were renamed when they moved, by their old id after the section. */
const MOVED_PROVIDER_ROWS: Record<string, string> = {
  "providers.t3-code.connection": "providers.t3-code.status",
  "providers.copilot-cli.cli": "providers.copilot-cli.mcp",
};

/**
 * Targets that moved to the Models page, or to their own section, by their old id; one ending in "." moves every row
 * under it.
 */
const MOVED_TARGETS: ReadonlyArray<[string, string]> = [
  ["models.tiers.custom.", "models.custom."],
  ["models.tiers.custom", "models.custom.list"],
  ["models.tiers", "models.tiers.list"],
  ["tasks.review.model", "models.operations.reviewer"],
  ["tasks.new-tasks.import-model", "models.operations.issueImport"],
  ["project.review-skill.model", "project.models.reviewer"],
];

/**
 * The Providers and Models pages, merged into Agents: their old targets by prefix (the longest that matches wins), so
 * bookmarks and links into either keep working.
 */
const MOVED_TO_AGENTS: ReadonlyArray<[string, string]> = [
  ["providers", "agents.providers"],
  ["models.operations", "agents.operations"],
  ["models.tiers", "agents.models.tiers"],
  ["models.custom", "agents.models.custom"],
  ["models", "agents.models"],
];

function movedToAgents(target: string): string {
  for (const [old, moved] of MOVED_TO_AGENTS) {
    if (target === old || target.startsWith(`${old}.`)) return moved + target.slice(old.length);
  }
  return target;
}

/** The Autopilot tab a target is on. */
export type AutopilotTab = "automations" | "runs" | "limits";

export function autopilotTabOf(target: string | null | undefined): AutopilotTab {
  if (target === "autopilot.runs" || target?.startsWith("autopilot.runs.")) return "runs";
  if (target === "autopilot.limits" || target?.startsWith("autopilot.limits.")) return "limits";
  return "automations";
}

/** Rows of the Automations tab that aren't automations. */
const AUTOMATIONS_TAB_ROWS: ReadonlySet<string> = new Set(["pause-all", "needs-you"]);

/** The automation a target selects (`autopilot.automations.review_prs` → review_prs), or null. */
export function automationOfTarget(target: string | null | undefined): string | null {
  const prefix = "autopilot.automations.";
  if (!target?.startsWith(prefix)) return null;
  const key = target.slice(prefix.length);
  return key === "" || AUTOMATIONS_TAB_ROWS.has(key) ? null : key;
}

/** Where a setting went when Settings → Autopilot became tabs, by its old id; one ending in "." moves every row under it. */
const MOVED_AUTOPILOT: ReadonlyArray<[string, string]> = [
  ["autopilot.engine.orchestrate.countdown", "board.appearance.autopilot-countdown"],
  ["autopilot.engine.orchestrate", "autopilot.automations.orchestrate"],
  ["autopilot.engine.pause-all", "autopilot.automations.pause-all"],
  ["autopilot.engine.settings", "autopilot.limits"],
  ["autopilot.engine.automation-", "autopilot.automations."],
  ["autopilot.engine.", "autopilot.limits."],
  ["autopilot.engine", "autopilot.automations"],
  ["autopilot.custom.variables", "autopilot.limits.variables"],
  ["autopilot.custom", "autopilot.automations"],
];

function movedAutopilot(target: string): string {
  for (const [old, moved] of MOVED_AUTOPILOT) {
    // A prefix ending in "-" or "." keeps what follows it; any other matches itself and the rows under it.
    if (old.endsWith(".") || old.endsWith("-")) {
      if (target.startsWith(old)) return moved + target.slice(old.length);
    } else if (target === old || target.startsWith(`${old}.`)) {
      return moved + target.slice(old.length);
    }
  }
  return target;
}

/**
 * A target from before it moved: a provider's from before providers had their own page
 * (`integrations.claude-code.cli-path`, a bookmark or an old link) and anything on the old Providers and Models pages
 * as it is now on Agents (`agents.providers.claude-code.cli-path`), and the model settings that moved to the Models
 * page. Any other target as it is.
 */
export function redirectSettingsTarget(target: string): string {
  if (target.startsWith("autopilot.")) return movedAutopilot(target);
  for (const [old, moved] of MOVED_TARGETS) {
    if (old.endsWith(".") ? target.startsWith(old) : target === old) {
      return movedToAgents(old.endsWith(".") ? moved + target.slice(old.length) : moved);
    }
  }
  for (const [old, provider] of Object.entries(MOVED_PROVIDER_SECTIONS)) {
    if (target !== old && !target.startsWith(`${old}.`)) continue;
    const moved = `providers.${provider}${target.slice(old.length)}`;
    return movedToAgents(MOVED_PROVIDER_ROWS[moved] ?? moved);
  }
  return movedToAgents(MOVED_PROVIDER_ROWS[target] ?? target);
}

/**
 * Where a settings target lives: a group (`"tasks"`), a section (`"tasks.review"`) or a row
 * (`"agents.providers.claude-code.cli-path"`). The group is the first segment; anything longer is the anchor to scroll
 * to. Null when the first segment isn't a group. An old target is read as the one it moved to.
 */
export function parseSettingsTarget(target: string): { group: SettingsGroupId; anchor: string | null } | null {
  const current = redirectSettingsTarget(target);
  const group = current.split(".")[0];
  if (!isSettingsGroup(group)) return null;
  return { group, anchor: current === group ? null : current };
}

/** The provider a Providers target is about (`agents.providers.codex.cli-path` → codex), or null. */
export function providerOfTarget(target: string | null | undefined): ProviderId | null {
  const [group, page, id] = (target ?? "").split(".");
  const parsed = ProviderId.safeParse(id);
  return group === "agents" && page === "providers" && parsed.success ? parsed.data : null;
}

/**
 * The sub-sections the list shows for a group: on Agents only Providers until the user adds one, since Models and
 * Operations have nothing to set without one.
 */
export function visibleSections(
  group: SettingsGroupDef,
  added: ReadonlyArray<{ id: ProviderId }> | undefined,
): ReadonlyArray<SettingsSectionDef> {
  if (group.id !== "agents" || (added?.length ?? 0) > 0) return group.sections;
  return group.sections.filter((entry) => entry.id === "agents.providers");
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
      return "autopilot.automations";
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

/**
 * Whether a settings path is an editor sub-page (`/settings/autopilot/custom/new`) rather than a page: the Autopilot
 * tabs at `/settings/autopilot/runs/…` and `/settings/autopilot/limits` are pages.
 */
export function isEditorPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length <= 2) return false;
  return !(parts[1] === "autopilot" && (parts[2] === "runs" || parts[2] === "limits"));
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
