// Pure helpers for Settings → Autopilot's list and detail: which group each automation is listed under, the line
// under its name, whether it is dimmed as off, and whether its Advanced section holds anything changed.
import {
  AGENT_DEFAULT_KEYS,
  AUTOMATION_GROUPS,
  fieldTier,
  INHERIT,
  RUNNER_CHOICES,
  T3_RUNTIME_MODES,
  type AutomationGroup,
  type AutopilotAgentDefaults,
  type AutopilotAutomation,
  type AutopilotField,
  type AutopilotConfig,
  type AutopilotOverview,
  type AutopilotScopeEntry,
} from "@repo/contracts";
import { formatElapsedDurationLabel } from "~/lib/timestampFormat";

export interface AutomationListGroup<T> {
  group: AutomationGroup;
  label: string;
  items: T[];
}

/** The automations under their group headings, in the groups' order and the catalogue's order within each; empty groups left out. */
export function groupAutomations<T extends { automation: Pick<AutopilotAutomation, "group"> }>(
  items: readonly T[],
): AutomationListGroup<T>[] {
  return AUTOMATION_GROUPS.map(({ value, label }) => ({
    group: value,
    label,
    items: items.filter((item) => (item.automation.group ?? "yours") === value),
  })).filter((g) => g.items.length > 0);
}

/** Where an automation is on: the board, or the projects whose own setting (or the board's) switches it on. */
export interface AutomationReach {
  board: boolean;
  /** Titles of the projects it is on in (in Preview too), in board order. */
  projects: string[];
  /** Those of them where it is only in Preview. */
  previewProjects: string[];
  /** How many projects the board has. */
  total: number;
}

/** The projects an automation is on in, given each project's entries; undefined entries (still loading) count as off. */
export function automationReach(
  key: string,
  board: Pick<AutopilotScopeEntry, "enabled"> | undefined,
  projects: ReadonlyArray<{ title: string; entries: ReadonlyArray<AutopilotScopeEntry> | undefined }>,
): AutomationReach {
  const entryIn = (p: (typeof projects)[number]) => p.entries?.find((e) => e.automation === key);
  return {
    board: board?.enabled ?? false,
    projects: projects.filter((p) => entryIn(p)?.enabled).map((p) => p.title),
    previewProjects: projects.filter((p) => entryIn(p)?.enabled && entryIn(p)?.preview).map((p) => p.title),
    total: projects.length,
  };
}

/** The Projects row's status: "On in storefront · Preview in docs", or "On in no project". */
export function projectsStatus(reach: Pick<AutomationReach, "projects" | "previewProjects">): string {
  const preview = new Set(reach.previewProjects);
  const live = reach.projects.filter((title) => !preview.has(title));
  const parts = [
    ...(live.length > 0 ? [`On in ${live.join(", ")}`] : []),
    ...(preview.size > 0 ? [`Preview in ${reach.previewProjects.join(", ")}`] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : "On in no project";
}

/** Off everywhere: the row is dimmed, as a switched-off provider is. */
export const isOffEverywhere = (reach: AutomationReach): boolean => !reach.board && reach.projects.length === 0;

/** "every project", "storefront, docs +2", or "nowhere". */
export function whereText(reach: AutomationReach): string {
  const n = reach.projects.length;
  if (n === 0) return reach.board ? "the board" : "nowhere";
  if (reach.total > 1 && n === reach.total) return "every project";
  if (n <= 2) return reach.projects.join(", ");
  return `${reach.projects.slice(0, 2).join(", ")} +${n - 2}`;
}

export type LastRun = AutopilotOverview["lastRuns"][number];

/** "✓ 2m", "✗ 1h", "skipped 3d", or "no runs yet". */
export function lastRunText(run: LastRun | undefined, nowMs: number = Date.now()): string {
  if (!run) return "no runs yet";
  const ago = formatElapsedDurationLabel(run.at, nowMs);
  if (run.status === "succeeded") return `✓ ${ago}`;
  if (run.status === "failed") return `✗ ${ago}`;
  return `${run.status} ${ago}`;
}

/**
 * What a list row's switch shows: the board's own setting, or mixed when the board isn't on but some projects set
 * their own On (a project beats the board, so it really runs there).
 */
export type SwitchState = "on" | "off" | "mixed";

export function switchState(reach: Pick<AutomationReach, "board" | "projects">): SwitchState {
  if (reach.board) return "on";
  return reach.projects.length > 0 ? "mixed" : "off";
}

const projectsCount = (titles: readonly string[]): string =>
  titles.length === 1 ? titles[0]! : `${titles.length} projects`;

/**
 * Where it runs while the board is off and projects set their own: "On in 5 projects", "On in storefront" (one is
 * named), "Preview in docs" for a project only in Preview, or both ("On in 2 projects · Preview in docs").
 */
export function onInProjectsText(reach: Pick<AutomationReach, "projects" | "previewProjects">): string {
  const preview = new Set(reach.previewProjects);
  const live = reach.projects.filter((title) => !preview.has(title));
  return [
    ...(live.length > 0 ? [`On in ${projectsCount(live)}`] : []),
    ...(preview.size > 0 ? [`Preview in ${projectsCount(reach.previewProjects)}`] : []),
  ].join(" · ");
}

export type SublineTone = "warning" | "danger";

/**
 * The line under a row's name. A row that is plainly On or Off has no marker (its switch says it); a state the switch
 * can't show leads the line as a coloured word: Preview, Paused, Last run failed. A board that is off while projects
 * set their own On reads "On in 5 projects".
 */
export interface RowSubline {
  word: { text: string; tone: SublineTone } | null;
  /** Between the word and the text: " " for "Paused in storefront", else " · ". */
  sep: string;
  text: string;
}

export function rowSubline(
  reach: AutomationReach,
  run: LastRun | undefined,
  opts: {
    nowMs?: number;
    /** The board's mode is Preview. */
    preview?: boolean;
    /** "Paused in storefront", when it paused itself somewhere after failing. */
    paused?: string | null;
    /** Recurring tasks: no switch and no reach, only its last run. */
    switchless?: boolean;
  } = {},
): RowSubline {
  const { nowMs, preview = false, paused = null, switchless = false } = opts;
  const off = !switchless && isOffEverywhere(reach);
  if (off) return { word: null, sep: "", text: "Off" };
  const ago = (r: LastRun) => formatElapsedDurationLabel(r.at, nowMs ?? Date.now());
  if (paused) return { word: { text: "Paused", tone: "warning" }, sep: " ", text: paused.replace(/^Paused /, "") };
  const where = switchless ? null : switchState(reach) === "mixed" ? onInProjectsText(reach) : whereText(reach);
  if (preview && !switchless) {
    return { word: { text: "Preview", tone: "warning" }, sep: " · ", text: `${where} · ${lastRunText(run, nowMs)}` };
  }
  if (run?.status === "failed") {
    return { word: { text: "Last run failed", tone: "danger" }, sep: " · ", text: `${ago(run)} ago` };
  }
  return { word: null, sep: "", text: where ? `${where} · ${lastRunText(run, nowMs)}` : lastRunText(run, nowMs) };
}

/** The status line under the detail's title; `preview` when the board's mode is Preview. Agrees with the list switch. */
export function statusLine(reach: AutomationReach, preview = false): string {
  if (isOffEverywhere(reach)) return "Off";
  if (switchState(reach) === "mixed") return `${onInProjectsText(reach)} · Off for the board`;
  return `${preview ? "Preview" : "On"} · ${whereText(reach)}`;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What a field is when this scope doesn't set it: the board's agent default (Limits & safety) for runner, budget,
 * timeout and T3 access, Inherit for the model, the automation's own default for the rest.
 */
export function fieldDefault(
  automation: Pick<AutopilotAutomation, "defaults">,
  field: Pick<AutopilotField, "key" | "kind">,
  agentDefaults: Partial<AutopilotAgentDefaults> = {},
): unknown {
  if (AGENT_KEYS.has(field.key) && field.key in agentDefaults) {
    return agentDefaults[field.key as keyof AutopilotAgentDefaults];
  }
  if (field.kind === "model") return automation.defaults[field.key] ?? INHERIT;
  return automation.defaults[field.key];
}

/**
 * Whether a field is set at this scope to something other than its default. Set by hand back to the default counts as
 * unchanged, so its reset hides.
 */
export function fieldChanged(
  automation: Pick<AutopilotAutomation, "defaults">,
  field: Pick<AutopilotField, "key" | "kind">,
  config: AutopilotConfig,
  agentDefaults: Partial<AutopilotAgentDefaults> = {},
): boolean {
  return field.key in config && !same(config[field.key], fieldDefault(automation, field, agentDefaults));
}

/** How many advanced fields differ from their default, for the Advanced header's "Agent · 2 changed". */
export function advancedChangedCount(
  automation: Pick<AutopilotAutomation, "fields" | "defaults">,
  config: AutopilotConfig,
  agentDefaults: Partial<AutopilotAgentDefaults> = {},
): number {
  return automation.fields.filter(
    (field) => fieldTier(field) === "advanced" && fieldChanged(automation, field, config, agentDefaults),
  ).length;
}

/** A value as a reset's tooltip names it: "Reset to $5", "60 min", "Auto", "T3 Code's default", "Inherit". */
export function fieldValueText(field: AutopilotField, value: unknown): string {
  switch (field.key) {
    case "runner":
      return RUNNER_CHOICES.find((c) => c.value === value)?.short ?? String(value);
    case "budgetUsd":
      return typeof value === "number" ? money(value) : "no cap";
    case "timeoutMinutes":
      return typeof value === "number" ? `${value} min` : String(value);
    case "t3Access":
      return value === "default"
        ? "T3 Code's default"
        : (T3_RUNTIME_MODES.find((m) => m.value === value)?.label ?? String(value));
  }
  switch (field.kind) {
    case "model":
      return value === INHERIT || value === undefined ? "Inherit" : "the default";
    case "boolean":
      return value === true ? "on" : "off";
    case "select":
      return field.options.find((o) => o.value === value)?.label ?? String(value);
    case "number":
      return typeof value === "number" ? `${value}${field.unit ? ` ${field.unit}` : ""}` : "empty";
    case "text":
      return typeof value === "string" && value !== "" ? value : "empty";
    default:
      return "the default";
  }
}

/** The selected automation: the one asked for when it exists, else the first listed. */
export function selectedAutomation(keys: readonly string[], requested: string | undefined): string | null {
  if (requested && keys.includes(requested)) return requested;
  return keys[0] ?? null;
}

const AGENT_KEYS: ReadonlySet<string> = new Set(AGENT_DEFAULT_KEYS);

/**
 * An automation's advanced fields split into its agent's (the model, and what the board's agent defaults cover:
 * runner, budget, timeout, T3 access) and the rest. The agent's show as summary lines with Override, not one row each.
 */
export function splitAgentFields<F extends Pick<AutopilotField, "key" | "kind">>(
  fields: readonly F[],
): { model: F | null; runner: F[]; rest: F[] } {
  return {
    model: fields.find((f) => f.kind === "model") ?? null,
    runner: fields.filter((f) => AGENT_KEYS.has(f.key)),
    rest: fields.filter((f) => f.kind !== "model" && !AGENT_KEYS.has(f.key)),
  };
}

const RUNNER_NAMES: Record<string, string> = {
  runner: "runner",
  budgetUsd: "budget",
  timeoutMinutes: "timeout",
  t3Access: "T3 access",
};

/** "Runner, budget and timeout": what an automation's agent-defaults line covers, from the fields it has. */
export function agentFieldsTitle(fields: ReadonlyArray<Pick<AutopilotField, "key">>): string {
  const names = fields.map((f) => RUNNER_NAMES[f.key] ?? f.key);
  const text = names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const money = (n: number): string => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/** "Auto · $5 · 60 min", from the effective values of the keys the automation has; T3 access only when not T3's default. */
export function agentSummary(fields: ReadonlyArray<Pick<AutopilotField, "key">>, config: AutopilotConfig): string {
  const parts = fields.flatMap((f): string[] => {
    const value = config[f.key];
    switch (f.key) {
      case "runner":
        return typeof value === "string" ? [RUNNER_CHOICES.find((c) => c.value === value)?.short ?? value] : [];
      case "budgetUsd":
        return typeof value === "number" ? [money(value)] : [];
      case "timeoutMinutes":
        return typeof value === "number" ? [`${value} min`] : [];
      case "t3Access": {
        if (typeof value !== "string" || value === "default") return [];
        const mode = T3_RUNTIME_MODES.find((m) => m.value === value);
        return [`T3: ${mode?.label ?? value}`];
      }
      default:
        return [];
    }
  });
  return parts.join(" · ");
}

/** The Advanced section's summary of what it holds: "Agent, Review drafts", agent fields named once. */
export function advancedFieldNames(fields: ReadonlyArray<Pick<AutopilotField, "key" | "kind" | "label">>): string[] {
  const { model, runner, rest } = splitAgentFields(fields);
  return [...(model || runner.length > 0 ? ["Agent"] : []), ...rest.map((f) => f.label)];
}
