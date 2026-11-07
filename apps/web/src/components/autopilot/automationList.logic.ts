// Pure helpers for Settings → Autopilot's list and detail: which group each automation is listed under, the line
// under its name, whether it is dimmed as off, and whether its Advanced section holds anything changed.
import {
  AGENT_DEFAULT_KEYS,
  AUTOMATION_GROUPS,
  fieldTier,
  RUNNER_CHOICES,
  T3_RUNTIME_MODES,
  type AutomationGroup,
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

/** The line under a row's name: "Off", or "where · last run". */
export function rowSubline(reach: AutomationReach, run: LastRun | undefined, nowMs?: number): string {
  if (isOffEverywhere(reach)) return "Off";
  return `${whereText(reach)} · ${lastRunText(run, nowMs)}`;
}

/** The status line under the detail's title; `preview` when the board's mode is Preview. */
export function statusLine(reach: AutomationReach, preview = false): string {
  return isOffEverywhere(reach) ? "Off" : `${preview ? "Preview" : "On"} · ${whereText(reach)}`;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Whether any advanced field's value differs from the automation's default, so the closed Advanced section gets a
 * dot. Read from the effective config, so a value inherited from the board counts on a project too.
 */
export function advancedChanged(
  automation: Pick<AutopilotAutomation, "fields" | "defaults">,
  effective: AutopilotConfig,
): boolean {
  return automation.fields.some(
    (field) =>
      fieldTier(field) === "advanced" &&
      field.key in effective &&
      !same(effective[field.key], automation.defaults[field.key]),
  );
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
