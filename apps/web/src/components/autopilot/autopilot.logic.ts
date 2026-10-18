import {
  describeInherited,
  isRetried,
  ScheduledAgentRunOutput,
  type AutopilotActiveRun,
  type AutopilotAutomation,
  type AutopilotConfig,
  type AutopilotField,
  type AutopilotMode,
  type AutopilotRun,
  type AutopilotScopeEntry,
  type AutopilotStatus,
} from "@repo/contracts";

// ── Lane pill and epic button ────────────────────────────────────────────

/** Off: nothing is on for the scope. Idle: on, nothing running. Active: a run is going. Paused: on, but Pause all is set. */
export type PillState = "off" | "idle" | "active" | "paused";

/** Runs in flight in a project. Runs already going finish under Pause all, so they still count. */
export function projectActiveRuns(status: AutopilotStatus | undefined, projectId: string): AutopilotActiveRun[] {
  return status?.active.filter((run) => run.projectId === projectId) ?? [];
}

/** A run in flight on the task, for its card badge. */
export function taskActiveRun(status: AutopilotStatus | undefined, taskId: string): AutopilotActiveRun | undefined {
  return status?.active.find((run) => run.taskId === taskId);
}

/** Runs in flight on tasks of an epic. They still count under Pause all, as runs already going finish. */
export function epicActiveRuns(status: AutopilotStatus | undefined, epicId: string): AutopilotActiveRun[] {
  return status?.active.filter((run) => run.epicId === epicId) ?? [];
}

type ScopeEntries = ReadonlyArray<Pick<AutopilotScopeEntry, "enabled">> | null | undefined;

function scopeState(activeRuns: number, paused: boolean | undefined, scope: ScopeEntries): PillState {
  if (activeRuns > 0) return "active";
  if (!scope?.some((entry) => entry.enabled)) return "off";
  return paused ? "paused" : "idle";
}

/**
 * The lane pill's look. `scope` is the project's entries (null until they load: shown as off, since nothing is
 * known to be on).
 */
export function pillState(status: AutopilotStatus | undefined, projectId: string, scope: ScopeEntries): PillState {
  return scopeState(projectActiveRuns(status, projectId).length, status?.paused, scope);
}

/**
 * The epic button's look, the same states as the pill's. `scope` is the epic's entries, which resolve through its
 * project and the board, so an epic that inherits an automation from the project counts as on.
 */
export function epicPillState(status: AutopilotStatus | undefined, epicId: string, scope: ScopeEntries): PillState {
  return scopeState(epicActiveRuns(status, epicId).length, status?.paused, scope);
}

/** The pill's (or epic button's) tooltip. */
export function pillTooltip(state: PillState, activeRuns: number, subject: "project" | "epic" = "project"): string {
  switch (state) {
    case "active":
      return activeRuns === 1 ? "Autopilot is working on 1 run" : `Autopilot is working on ${activeRuns} runs`;
    case "idle":
      return `Autopilot is on for this ${subject}`;
    case "paused":
      return `Autopilot is on for this ${subject}, but paused`;
    case "off":
      return `Autopilot is off for this ${subject}`;
  }
}

// ── Switches ─────────────────────────────────────────────────────────────

export const AUTOPILOT_MODES: ReadonlyArray<{ value: AutopilotMode; label: string }> = [
  { value: "inherit", label: "Inherit" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

/**
 * The board is the top scope, so Inherit there only falls back to the built-in default, which is Off: its switch
 * offers On and Off alone.
 */
export const BOARD_MODES = AUTOPILOT_MODES.filter((mode) => mode.value !== "inherit");

/** The board switch's choice for a stored mode: no row (inherit) reads as Off. */
export const boardSwitchValue = (mode: AutopilotMode): AutopilotMode => (mode === "inherit" ? "off" : mode);

/**
 * The mode to save for a board switch choice. Off is saved as inherit, which drops the board's row unless it still
 * holds config, since both resolve to Off.
 */
export const boardModeToSave = (mode: AutopilotMode): AutopilotMode => (mode === "off" ? "inherit" : mode);

/** What the board switch's row says about the choice. */
export const boardSummary = (mode: AutopilotMode): string => (mode === "on" ? "On for the board" : "Off for the board");

/**
 * What the Inherit choice resolves to at a project or epic, e.g. "Inherit (On from board)". `parent` is the entry at
 * the scope above (the board's, for a project; the project's, for an epic, which already resolves through the board);
 * without one (still loading) it reads as off by default.
 */
export function inheritLabel(parent: Pick<AutopilotScopeEntry, "enabled" | "source"> | null | undefined): string {
  return describeInherited(parent ?? { enabled: false, source: "default" });
}

/** The entry for `automation` at the scope above (the board's for a project, the project's for an epic), which Inherit follows. */
export function parentEntry(
  parentEntries: ReadonlyArray<AutopilotScopeEntry> | undefined,
  automation: string,
): AutopilotScopeEntry | null {
  return parentEntries?.find((entry) => entry.automation === automation) ?? null;
}

/** What one row of a project's or epic's Autopilot popover shows: a switch that is faded while it follows the scope above. */
export interface ScopeRowModel {
  /** What the automation resolves to here, whether set at this scope or inherited. */
  checked: boolean;
  /** True while the scope sets nothing (Inherit): the switch is faded and there is nothing to reset. */
  inherited: boolean;
  /** The mode a click on the switch saves. It is always an explicit On or Off; the reset button saves Inherit. */
  nextMode: "on" | "off";
  /** False when a click would turn on an automation that can't be (`blocked`). Turning off always works. */
  canToggle: boolean;
  blocked: string | null;
  /** The switch's tooltip: where its state comes from. */
  note: string;
}

/**
 * The row for one automation at a project or epic. `entry` already resolves through the scopes above (`enabled` and
 * `source` are what Inherit would give), so the row needs no entry from the parent scope.
 */
export function scopeRowModel(
  entry: Pick<AutopilotScopeEntry, "mode" | "enabled" | "source">,
  blocked: string | null,
  scope: "project" | "epic",
): ScopeRowModel {
  const inherited = entry.mode === "inherit";
  const nextMode = entry.enabled ? "off" : "on";
  const state = entry.enabled ? "On" : "Off";
  const note = !inherited
    ? `${state} for this ${scope}`
    : entry.source === "default"
      ? `${state} by default`
      : `${state}, following the ${entry.source}`;
  return {
    checked: entry.enabled,
    inherited,
    nextMode,
    canToggle: !(nextMode === "on" && blocked),
    blocked,
    note,
  };
}

// ── Config forms ─────────────────────────────────────────────────────────

/** The automations a scope's popover lists: an epic's leaves out those that don't apply to epics. */
export function scopeAutomations<T extends Pick<AutopilotAutomation, "epicScope">>(
  automations: ReadonlyArray<T>,
  forEpic: boolean,
): T[] {
  return forEpic ? automations.filter((a) => a.epicScope) : [...automations];
}

/** Whether an epic has anything to switch: its button and popover are pointless when no automation applies to epics. */
export const hasEpicAutomations = (automations: ReadonlyArray<Pick<AutopilotAutomation, "epicScope">>): boolean =>
  automations.some((a) => a.epicScope);

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

/** Whether `text` is a complete 24-hour "HH:MM" time, the form a time field and quiet hours save. */
export function isClockTime(text: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text);
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

export function runStatusLabel(run: Pick<AutopilotRun, "status" | "dryRun"> & { dedupeKey?: string }): string {
  // A retried run's work went back to the engine; what it did itself is still the status below.
  if (run.dedupeKey && isRetried(run.dedupeKey)) return run.status === "failed" ? "Failed, retried" : "Retried";
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

/**
 * The runs of one scheduled agent (task-less, so never in a task's panel), newest first, as many as `limit`. A run that
 * left no answer still counts: its failure or its bad answer is part of the story.
 */
export function scheduledAgentRuns(
  runs: ReadonlyArray<AutopilotRun> | undefined,
  automationKey: string,
  limit: number,
): AutopilotRun[] {
  return (runs ?? []).filter((r) => r.automation === automationKey && !r.dryRun && r.taskId === null).slice(0, limit);
}

/** The summary and handover a scheduled agent run left, or null when it left none. */
export function scheduledAnswerOf(run: Pick<AutopilotRun, "output">): ScheduledAgentRunOutput | null {
  const parsed = ScheduledAgentRunOutput.safeParse(run.output);
  return parsed.success ? parsed.data : null;
}

/**
 * The run whose flag the Dismiss button lifts: the newest flagged run that wasn't dismissed, shown only while the task
 * still carries an Autopilot attention reason (a status change or a later success clears the flag by itself, and
 * leaves a flagged run behind that must not offer a Dismiss). `runs` is newest first.
 */
export function dismissableRun<T extends Pick<AutopilotRun, "needsAttention" | "dismissedAt" | "dryRun">>(
  runs: readonly T[],
  attention: ReadonlyArray<{ kind: string }>,
): T | null {
  if (!attention.some((a) => a.kind === "autopilot")) return null;
  return runs.find((r) => r.needsAttention && r.dismissedAt === null && !r.dryRun) ?? null;
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
