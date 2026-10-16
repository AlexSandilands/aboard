import {
  describeInherited,
  type AutopilotActiveRun,
  type AutopilotAutomation,
  type AutopilotConfig,
  type AutopilotField,
  type AutopilotMode,
  type AutopilotRun,
  type AutopilotScopeEntry,
  type AutopilotStatus,
} from "@repo/contracts";

// ── Lane pill ────────────────────────────────────────────────────────────

/** Off: nothing is on for the project. Idle: on, nothing running. Active: a run is going. Paused: on, but Pause all is set. */
export type PillState = "off" | "idle" | "active" | "paused";

/** Runs in flight in a project. Runs already going finish under Pause all, so they still count. */
export function projectActiveRuns(status: AutopilotStatus | undefined, projectId: string): AutopilotActiveRun[] {
  return status?.active.filter((run) => run.projectId === projectId) ?? [];
}

/** A run in flight on the task, for its card badge. */
export function taskActiveRun(status: AutopilotStatus | undefined, taskId: string): AutopilotActiveRun | undefined {
  return status?.active.find((run) => run.taskId === taskId);
}

/**
 * The lane pill's look. `scope` is the project's entries (null until they load: shown as off, since nothing is
 * known to be on).
 */
export function pillState(
  status: AutopilotStatus | undefined,
  projectId: string,
  scope: ReadonlyArray<Pick<AutopilotScopeEntry, "enabled">> | null | undefined,
): PillState {
  if (projectActiveRuns(status, projectId).length > 0) return "active";
  if (!scope?.some((entry) => entry.enabled)) return "off";
  return status?.paused ? "paused" : "idle";
}

/** The pill's tooltip. */
export function pillTooltip(state: PillState, activeRuns: number): string {
  switch (state) {
    case "active":
      return activeRuns === 1 ? "Autopilot is working on 1 run" : `Autopilot is working on ${activeRuns} runs`;
    case "idle":
      return "Autopilot is on for this project";
    case "paused":
      return "Autopilot is on for this project, but paused";
    case "off":
      return "Autopilot is off for this project";
  }
}

// ── Switches ─────────────────────────────────────────────────────────────

export const AUTOPILOT_MODES: ReadonlyArray<{ value: AutopilotMode; label: string }> = [
  { value: "inherit", label: "Inherit" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

/**
 * What the Inherit choice resolves to at a scope, e.g. "Inherit (On from board)". `parent` is the entry at the scope
 * above (the board's, for a project); the board itself has none, so Inherit there is off by default.
 */
export function inheritLabel(parent: Pick<AutopilotScopeEntry, "enabled" | "source"> | null | undefined): string {
  return describeInherited(parent ?? { enabled: false, source: "default" });
}

/** The board's entry for `automation`, which a project's Inherit follows. */
export function parentEntry(
  boardEntries: ReadonlyArray<AutopilotScopeEntry> | undefined,
  automation: string,
): AutopilotScopeEntry | null {
  return boardEntries?.find((entry) => entry.automation === automation) ?? null;
}

// ── Config forms ─────────────────────────────────────────────────────────

/** The entry for an automation, or an inherit-everything stand-in while the scope loads. */
export function entryFor(
  entries: ReadonlyArray<AutopilotScopeEntry> | undefined,
  automation: AutopilotAutomation,
): AutopilotScopeEntry {
  return (
    entries?.find((entry) => entry.automation === automation.key) ?? {
      automation: automation.key,
      mode: "inherit",
      config: {},
      enabled: false,
      source: "default",
      effectiveConfig: automation.defaults,
    }
  );
}

/** This scope's config with one key set, or cleared (`undefined`) so it inherits again. The server replaces the whole config. */
export function withConfigValue(own: AutopilotConfig, key: string, value: unknown): AutopilotConfig {
  const next = { ...own };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/** What a number field's text means: a number in range, `undefined` for empty (inherit), or null when it isn't valid. */
export function parseNumberField(
  text: string,
  field: Pick<Extract<AutopilotField, { kind: "number" }>, "min" | "max">,
): number | undefined | null {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  if (field.min !== undefined && value < field.min) return null;
  if (field.max !== undefined && value > field.max) return null;
  return value;
}

/** A field's value as an input shows it. */
export function fieldText(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}

// ── Engine limits ────────────────────────────────────────────────────────

/**
 * An optional limit's text: a number within `min`..`max` (whole numbers only when `integer`), `null` for empty (no
 * limit), or `undefined` when it isn't valid.
 */
export function parseLimit(
  text: string,
  { min, max, integer }: { min: number; max: number; integer: boolean },
): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < min || value > max) return undefined;
  if (integer && !Number.isInteger(value)) return undefined;
  return value;
}

// ── Runs ─────────────────────────────────────────────────────────────────

type BadgeVariant = "info" | "warning" | "error" | "success" | "outline";

export function runStatusLabel(run: Pick<AutopilotRun, "status" | "dryRun">): string {
  switch (run.status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "succeeded":
      return "Done";
    case "failed":
      return "Failed";
    case "skipped":
      return run.dryRun ? "Dry run" : "Skipped";
  }
}

export function runStatusVariant(status: AutopilotRun["status"]): BadgeVariant {
  switch (status) {
    case "queued":
    case "running":
      return "info";
    case "succeeded":
      return "success";
    case "failed":
      return "error";
    case "skipped":
      return "outline";
  }
}

/** "$0.42", "$0.004" for sub-cent costs, or null when the run has none. */
export function formatCost(costUsd: number | null): string | null {
  if (costUsd === null) return null;
  if (costUsd > 0 && costUsd < 0.01) return `$${costUsd.toFixed(3)}`;
  return `$${costUsd.toFixed(2)}`;
}

/** The title of an automation by key, falling back to the key for one no longer in the catalogue. */
export function automationTitle(
  automations: ReadonlyArray<Pick<AutopilotAutomation, "key" | "title">>,
  key: string,
): string {
  return automations.find((a) => a.key === key)?.title ?? key;
}

/** The Autopilot section's collapsed summary. */
export function runsSummary(runs: ReadonlyArray<Pick<AutopilotRun, "status" | "needsAttention">>): string {
  if (runs.length === 0) return "No runs";
  const active = runs.filter((r) => r.status === "queued" || r.status === "running").length;
  const flagged = runs.filter((r) => r.needsAttention).length;
  const parts = [`${runs.length} run${runs.length === 1 ? "" : "s"}`];
  if (active) parts.push(`${active} running`);
  if (flagged) parts.push(`${flagged} need${flagged === 1 ? "s" : ""} attention`);
  return parts.join(" · ");
}
