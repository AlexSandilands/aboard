// Pure helpers for Settings → Autopilot's list and detail: which group each automation is listed under, the line
// under its name, whether it is dimmed as off, and whether its Advanced section holds anything changed.
import {
  AUTOMATION_GROUPS,
  fieldTier,
  type AutomationGroup,
  type AutopilotAutomation,
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
  /** Titles of the projects it is on in, in board order. */
  projects: string[];
  /** How many projects the board has. */
  total: number;
}

/** The projects an automation is on in, given each project's entries; undefined entries (still loading) count as off. */
export function automationReach(
  key: string,
  board: Pick<AutopilotScopeEntry, "enabled"> | undefined,
  projects: ReadonlyArray<{ title: string; entries: ReadonlyArray<AutopilotScopeEntry> | undefined }>,
): AutomationReach {
  return {
    board: board?.enabled ?? false,
    projects: projects.filter((p) => p.entries?.find((e) => e.automation === key)?.enabled).map((p) => p.title),
    total: projects.length,
  };
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
