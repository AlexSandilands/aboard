import { z } from "zod";
import { FindingSeverity } from "./reviews.ts";

// Autopilot: a rule engine in the server that runs a catalogue of automations (docs/decisions/0008-autopilot-engine.md).

/** The actor on activity entries the engine writes and on changes its actions make. */
export const AUTOPILOT_ACTOR = "autopilot";

/** The automation that starts flagged Planned tasks. Shared so hints can name it before it is registered. */
export const AUTOPILOT_START_PLANNED = "start_planned";

/** The automation that flags In Progress tasks gone quiet. Its attention clears on new activity, so the repo knows its key. */
export const AUTOPILOT_UNSTICK = "unstick";

/** An automation's switch at one scope. `inherit` defers to the next scope up; nothing set anywhere is off. */
export const AutopilotMode = z.enum(["inherit", "on", "off"]);
export type AutopilotMode = z.infer<typeof AutopilotMode>;

/** Most specific last. An epic's setting applies to the tasks in it. */
export const AutopilotScopeKind = z.enum(["board", "project", "epic"]);
export type AutopilotScopeKind = z.infer<typeof AutopilotScopeKind>;

export const AutopilotRunStatus = z.enum(["queued", "running", "succeeded", "failed", "skipped"]);
export type AutopilotRunStatus = z.infer<typeof AutopilotRunStatus>;

/** Statuses of a run that hasn't finished. */
export const AUTOPILOT_ACTIVE_STATUSES: ReadonlyArray<AutopilotRunStatus> = ["queued", "running"];

const AutopilotConfig = z.record(z.string(), z.unknown());
export type AutopilotConfig = z.infer<typeof AutopilotConfig>;

/** One automation's mode and config at one scope. `scopeId` is null for the board. */
export const AutopilotSetting = z.object({
  scopeKind: AutopilotScopeKind,
  scopeId: z.string().nullable(),
  automation: z.string(),
  mode: AutopilotMode,
  /** Only the keys set at this scope; the others inherit. */
  config: AutopilotConfig,
  updatedAt: z.string(),
});
export type AutopilotSetting = z.infer<typeof AutopilotSetting>;

export const UpdateAutopilotSettingInput = z.object({
  mode: AutopilotMode.optional(),
  /** Replaces this scope's config; keys left out inherit. */
  config: AutopilotConfig.optional(),
});
export type UpdateAutopilotSettingInput = z.infer<typeof UpdateAutopilotSettingInput>;

/** Where an effective mode came from: a scope that set it, or the default (off). */
export const AutopilotModeSource = z.enum(["board", "project", "epic", "default"]);
export type AutopilotModeSource = z.infer<typeof AutopilotModeSource>;

export interface ResolvedAutopilot {
  enabled: boolean;
  source: AutopilotModeSource;
  /** Config keys merged board first, most specific scope last. Not yet merged over the automation's defaults. */
  config: AutopilotConfig;
}

/**
 * The effective mode and config of one automation, given its settings from least to most specific scope (board,
 * project, then the task's epic). The most specific scope that isn't `inherit` wins; with none, it's off. Config keys
 * merge in the same order whatever the modes, so a project can tune an automation that is switched on for the whole
 * board.
 */
export function resolveAutopilot(
  chain: ReadonlyArray<Pick<AutopilotSetting, "scopeKind" | "mode" | "config"> | null | undefined>,
): ResolvedAutopilot {
  let enabled = false;
  let source: AutopilotModeSource = "default";
  const config: AutopilotConfig = {};
  for (const setting of chain) {
    if (!setting) continue;
    Object.assign(config, setting.config);
    if (setting.mode !== "inherit") {
      enabled = setting.mode === "on";
      source = setting.scopeKind;
    }
  }
  return { enabled, source, config };
}

const AUTOPILOT_LABELLED_PREFIX = "Autopilot · ";
const AUTOPILOT_UNLABELLED_NAME = "Autopilot session";

/** What an Autopilot session is called: the run's label behind "Autopilot · ", or just "Autopilot session". */
export const autopilotSessionName = (label: string | undefined): string =>
  label?.trim() ? `${AUTOPILOT_LABELLED_PREFIX}${label.trim()}` : AUTOPILOT_UNLABELLED_NAME;

/** Whether a name is one `autopilotSessionName` made: how the panel tells a session Autopilot is still running. */
export const isAutopilotSessionName = (name: string | null | undefined): boolean =>
  !!name && (name === AUTOPILOT_UNLABELLED_NAME || name.startsWith(AUTOPILOT_LABELLED_PREFIX));

/** "Inherit (On from board)": how the UI labels an inherit switch. */
export function describeInherited(resolved: Pick<ResolvedAutopilot, "enabled" | "source">): string {
  const state = resolved.enabled ? "On" : "Off";
  return resolved.source === "default" ? `Inherit (${state} by default)` : `Inherit (${state} from ${resolved.source})`;
}

// ── Automation catalogue ─────────────────────────────────────────────────

const FieldBase = {
  key: z.string(),
  label: z.string(),
  help: z.string().optional(),
};

/** One config field of an automation, described so the UI can render its form without knowing the automation. */
export const AutopilotField = z.discriminatedUnion("kind", [
  z.object({ ...FieldBase, kind: z.literal("boolean") }),
  z.object({
    ...FieldBase,
    kind: z.literal("number"),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    /** Shown after the input, e.g. "days" or "USD". */
    unit: z.string().optional(),
  }),
  z.object({ ...FieldBase, kind: z.literal("text"), placeholder: z.string().optional() }),
  z.object({
    ...FieldBase,
    kind: z.literal("select"),
    options: z.array(z.object({ value: z.string(), label: z.string() })),
  }),
  /** A time of day, "HH:MM" on a 24-hour clock in the server's local time. */
  z.object({ ...FieldBase, kind: z.literal("time") }),
  /** A skill reference, picked the way the review skill is. */
  z.object({
    ...FieldBase,
    kind: z.literal("skill"),
    /** What the built-in entry is called, when it isn't the review skill (e.g. "Default workflow"). */
    builtinLabel: z.string().optional(),
  }),
]);
export type AutopilotField = z.infer<typeof AutopilotField>;

export const AutopilotAutomation = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string(),
  /** Starts an agent, so it counts against the concurrency and daily caps and waits out quiet hours. */
  needsAgent: z.boolean(),
  /** An epic can switch it on or off for its tasks. False for automations that don't act on tasks in an epic. */
  epicScope: z.boolean(),
  /** Why it can't be switched on yet ("Won't work until you fill in: Jira tools"), or null. */
  blocked: z.string().nullable().default(null),
  fields: z.array(AutopilotField),
  /** Every field's value when no scope sets it. */
  defaults: AutopilotConfig,
});
export type AutopilotAutomation = z.infer<typeof AutopilotAutomation>;

/** An automation as seen from one scope: its own setting there and what it resolves to. */
export const AutopilotScopeEntry = z.object({
  automation: z.string(),
  /** The mode set at this scope (inherit when nothing is). */
  mode: AutopilotMode,
  /** The config set at this scope only. */
  config: AutopilotConfig,
  enabled: z.boolean(),
  source: AutopilotModeSource,
  /** The config the engine would use: defaults, then every scope's keys. */
  effectiveConfig: AutopilotConfig,
});
export type AutopilotScopeEntry = z.infer<typeof AutopilotScopeEntry>;

// ── Engine ───────────────────────────────────────────────────────────────

const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");

/** Engine-wide limits. Caps and quiet hours apply only to automations that start an agent. */
export const AutopilotEngineSettings = z.object({
  /** Agent runs at once. */
  maxConcurrent: z.number().int().min(1).max(10),
  /** Agent runs started per day (local time); null is no cap. */
  dailyRunCap: z.number().int().min(1).max(1000).nullable(),
  /** Spend on agent runs per day, in USD; null is no cap. */
  dailySpendCapUsd: z.number().positive().max(10_000).nullable(),
  /** No agent runs start between `start` and `end` (local time, may wrap midnight) while on. Equal times are no window. */
  quietHours: z.object({ enabled: z.boolean(), start: ClockTime, end: ClockTime }),
  /** Record what would run, as skipped runs, and do nothing. */
  dryRun: z.boolean(),
  /** Review rounds the PR review automation runs per PR. */
  prReviewRounds: z.number().int().min(1).max(10),
  /** The lowest finding severity the PR automations ask an agent to fix. */
  prFixThreshold: FindingSeverity,
  /** Days a finished headless run's worktree is kept when its PR hasn't merged; clean ones are then removed. */
  worktreeRetentionDays: z.number().int().min(1).max(365),
});
export type AutopilotEngineSettings = z.infer<typeof AutopilotEngineSettings>;

export const DEFAULT_AUTOPILOT_ENGINE: AutopilotEngineSettings = {
  maxConcurrent: 1,
  dailyRunCap: null,
  dailySpendCapUsd: null,
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
  dryRun: false,
  prReviewRounds: 3,
  prFixThreshold: "major",
  worktreeRetentionDays: 7,
};

export const UpdateAutopilotEngineInput = AutopilotEngineSettings.extend({
  quietHours: AutopilotEngineSettings.shape.quietHours.partial(),
}).partial();
export type UpdateAutopilotEngineInput = z.infer<typeof UpdateAutopilotEngineInput>;

/** Whether `minutes` past local midnight falls in the window. Equal ends are no window. */
export function inQuietHours(quiet: AutopilotEngineSettings["quietHours"], minutes: number): boolean {
  if (!quiet.enabled || quiet.start === quiet.end) return false;
  const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export const AutopilotRun = z.object({
  id: z.string(),
  automation: z.string(),
  taskId: z.string().nullable(),
  projectId: z.string().nullable(),
  dedupeKey: z.string(),
  status: AutopilotRunStatus,
  /** What the action did, or would do in dry-run. */
  summary: z.string(),
  dryRun: z.boolean(),
  /** How an agent action ran (set by the runner), e.g. "t3" or "headless". */
  runner: z.string().nullable(),
  sessionId: z.string().nullable(),
  threadUrl: z.string().nullable(),
  worktreePath: z.string().nullable(),
  costUsd: z.number().nullable(),
  /** What a shell action printed (the tail), or what a dry run of a custom automation would have run. */
  detail: z.string().nullable(),
  /** A shell action's exit code; null when it didn't exit (a timeout) or isn't a shell action. */
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
  needsAttention: z.boolean(),
  /** A structured result the action left for later automations to read (the PR review's verdict); null when none. */
  output: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type AutopilotRun = z.infer<typeof AutopilotRun>;

/** A run that hasn't finished, for spinners on lanes, epic bands and cards. */
export const AutopilotActiveRun = AutopilotRun.pick({
  id: true,
  automation: true,
  taskId: true,
  projectId: true,
  status: true,
}).extend({
  /** The epic the run's task is in, so an epic's button can spin; not stored, read from the task. */
  epicId: z.string().nullable(),
});
export type AutopilotActiveRun = z.infer<typeof AutopilotActiveRun>;

/** What the board shows of Autopilot at a glance; sent in the snapshot and with every autopilot.changed. */
export const AutopilotStatus = z.object({
  paused: z.boolean(),
  active: z.array(AutopilotActiveRun),
});
export type AutopilotStatus = z.infer<typeof AutopilotStatus>;

/** `GET /api/autopilot`: engine settings, pause and the catalogue. */
export const AutopilotOverview = z.object({
  paused: z.boolean(),
  engine: AutopilotEngineSettings,
  automations: z.array(AutopilotAutomation),
});
export type AutopilotOverview = z.infer<typeof AutopilotOverview>;

/** The activity line for an `autopilot_run` event (after the actor), shared by the panel and MCP results. */
export function autopilotRunEventText(payload: Record<string, unknown>): string {
  const text = (key: string) => (typeof payload[key] === "string" ? payload[key] : null);
  const title = text("title") ?? text("automation") ?? "an automation";
  const summary = text("summary") ?? "";
  switch (text("status")) {
    case "running":
      return `started ${title}: ${summary}`;
    case "succeeded":
      return `finished ${title}: ${summary}`;
    case "failed":
      return `${title} failed: ${text("error") ?? summary}`;
    default:
      return payload.dryRun === true ? `${title} (dry run): ${summary}` : `skipped ${title}: ${summary}`;
  }
}
