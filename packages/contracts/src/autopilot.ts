import { z } from "zod";
import { OperationId, OperationNeed, RunModelRecord } from "./operations.ts";
import { T3RuntimeMode } from "./t3Launch.ts";
import type { TaskSummary } from "./schemas.ts";

// Autopilot: a rule engine in the server that runs a catalogue of automations (docs/decisions/0008-autopilot-engine.md).

/** The actor on activity entries the engine writes and on changes its actions make. */
export const AUTOPILOT_ACTOR = "autopilot";

/** The automation that starts flagged Planned tasks. Shared so hints can name it before it is registered. */
export const AUTOPILOT_START_PLANNED = "start_planned";

/**
 * The retired automation that flagged In Progress tasks gone quiet; its runs stay in the history and their attention
 * clears on new activity, so the repo knows its key. It is now the `task_quiet` and `thread_waited` notifications.
 */
export const AUTOPILOT_UNSTICK = "unstick";

/** The retired automation that told the user a task's last blocker finished; now the `task_unblocked` notification. */
export const AUTOPILOT_UNBLOCK_DEPENDENTS = "unblock_dependents";

/** The scheduled agent that sees a project's work through: unsticks it, merges what's ready. The UI shows its handovers. */
export const AUTOPILOT_ORCHESTRATE = "orchestrate";

/** The weekly agent that audits how agents did and suggests rewrites of the prompts and skills they run with. */
export const AUTOPILOT_IMPROVE = "improve_automations";

/** How an Unstick note and run summary open for a task gone quiet; board_activity tells the two kinds apart by it. */
export const UNSTICK_STALE_PREFIX = "Stale: no activity for";
/** How they open for a task whose thread waits on the user. */
export const UNSTICK_WAITING_PREFIX = "Thread waiting for input for";

/** What a run failed by the board restarting says first, so reports can tell it from a failure of the run's own. */
export const BOARD_RESTARTED_ERROR = "The board restarted";

/**
 * An automation's switch at one scope. `inherit` defers to the next scope up; nothing set anywhere is off. `preview`
 * is on, but every run is a dry run: it records what it would do and does none of it (a custom automation's check
 * script still runs for real, to find what it would act on).
 */
export const AutopilotMode = z.enum(["inherit", "on", "preview", "off"]);
export type AutopilotMode = z.infer<typeof AutopilotMode>;

/** The modes that switch an automation on: what a scope remembers so its switch can restore it after Off. */
export const AutopilotOnMode = z.enum(["on", "preview"]);
export type AutopilotOnMode = z.infer<typeof AutopilotOnMode>;

export const isOnMode = (mode: AutopilotMode): mode is AutopilotOnMode => mode === "on" || mode === "preview";

/** How far back an automation's Preview hint counts its "would …" runs. */
export const PREVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** The last on-mode this scope was set to, kept through Off; null when it never was on. */
  lastOnMode: AutopilotOnMode.nullable().default(null),
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
  /** On or in Preview: the automation's check runs. */
  enabled: boolean;
  /** Enabled in Preview: its runs are dry runs. */
  preview: boolean;
  source: AutopilotModeSource;
  /** Config keys merged board first, most specific scope last. Not yet merged over the automation's defaults. */
  config: AutopilotConfig;
}

/**
 * The effective mode and config of one automation, given its settings from least to most specific scope (board,
 * project, then the task's epic). The most specific scope that isn't `inherit` wins; with none, it's off. Preview
 * counts as enabled, with `preview` set, so the engine records its runs as dry runs. Config keys
 * merge in the same order whatever the modes, so a project can tune an automation that is switched on for the whole
 * board.
 */
export function resolveAutopilot(
  chain: ReadonlyArray<Pick<AutopilotSetting, "scopeKind" | "mode" | "config"> | null | undefined>,
): ResolvedAutopilot {
  let enabled = false;
  let preview = false;
  let source: AutopilotModeSource = "default";
  const config: AutopilotConfig = {};
  for (const setting of chain) {
    if (!setting) continue;
    Object.assign(config, setting.config);
    if (setting.mode !== "inherit") {
      enabled = isOnMode(setting.mode);
      preview = setting.mode === "preview";
      source = setting.scopeKind;
    }
  }
  return { enabled, preview, source, config };
}

const AUTOPILOT_LABELLED_PREFIX = "Autopilot · ";
const AUTOPILOT_TASK_MARKER = " · Autopilot: ";
const AUTOPILOT_UNLABELLED_NAME = "Autopilot session";
const AUTOPILOT_TITLE_MAX = 60;
// The shape `autopilotSessionName` gives a run on a task, with or without a label.
const AUTOPILOT_TASK_NAME = /^#\d+ .* · Autopilot(: .+)?$/s;

/** A task title cut to about 60 characters, ending in "…" when it was cut, so the automation behind it survives. */
const shortTaskTitle = (title: string): string => {
  // By code point, so the cut never leaves half of an emoji.
  const chars = Array.from(title.trim());
  return chars.length <= AUTOPILOT_TITLE_MAX
    ? chars.join("")
    : `${chars
        .slice(0, AUTOPILOT_TITLE_MAX - 1)
        .join("")
        .trimEnd()}…`;
};

/**
 * What an Autopilot session is called. A run on a task: "#7 Add a cart · Autopilot: Fix PRs · PR #9", the task first
 * like a thread started by hand. A run without one: the run's label behind "Autopilot · ", or just "Autopilot session".
 */
export const autopilotSessionName = (
  label: string | undefined,
  task?: { number: number; title: string } | null,
): string => {
  const what = label?.trim();
  if (!task) return what ? `${AUTOPILOT_LABELLED_PREFIX}${what}` : AUTOPILOT_UNLABELLED_NAME;
  const head = `#${task.number} ${shortTaskTitle(task.title)}`;
  return what ? `${head}${AUTOPILOT_TASK_MARKER}${what}` : `${head} · Autopilot`;
};

/** Whether a name is one `autopilotSessionName` made (now or before it put the task first): how the panel tells a session Autopilot is still running. */
export const isAutopilotSessionName = (name: string | null | undefined): boolean =>
  !!name &&
  (name === AUTOPILOT_UNLABELLED_NAME || name.startsWith(AUTOPILOT_LABELLED_PREFIX) || AUTOPILOT_TASK_NAME.test(name));

/** What a resolved switch reads as: Off, Preview or On. */
export const resolvedModeLabel = (resolved: Pick<ResolvedAutopilot, "enabled" | "preview">): string =>
  !resolved.enabled ? "Off" : resolved.preview ? "Preview" : "On";

/** "Inherit (On from board)": how the UI labels an inherit switch. */
export function describeInherited(
  resolved: Pick<ResolvedAutopilot, "enabled" | "source"> & { preview?: boolean },
): string {
  const state = resolvedModeLabel({ enabled: resolved.enabled, preview: resolved.preview ?? false });
  return resolved.source === "default" ? `Inherit (${state} by default)` : `Inherit (${state} from ${resolved.source})`;
}

// ── Automation catalogue ─────────────────────────────────────────────────

/**
 * How far into an automation's detail a field sits: essential ones show with it, advanced ones under its closed
 * Advanced section. Unset is advanced, so a new field stays out of the way until someone decides it is essential.
 */
export const AutopilotFieldTier = z.enum(["essential", "advanced"]);
export type AutopilotFieldTier = z.infer<typeof AutopilotFieldTier>;

const FieldBase = {
  key: z.string(),
  label: z.string(),
  /** One short line under the label (docs/reference/style.md: one description line per settings row). */
  help: z.string().optional(),
  /** The detail that doesn't fit that line, behind an info button beside the label. */
  info: z.string().optional(),
  /** Drawn in that field's row, its control beside that one's, rather than as a row of its own. */
  inRowOf: z.string().optional(),
  /** Set per project in Where it runs: the automation's settings draw no row for it. */
  inWhereTable: z.boolean().optional(),
  tier: AutopilotFieldTier.optional(),
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
  z.object({
    ...FieldBase,
    kind: z.literal("text"),
    placeholder: z.string().optional(),
    /** Several lines of text (instructions), edited in a text area. */
    multiline: z.boolean().optional(),
  }),
  z.object({
    ...FieldBase,
    kind: z.literal("select"),
    options: z.array(z.object({ value: z.string(), label: z.string() })),
  }),
  /** A time of day, "HH:MM" on a 24-hour clock in the server's local time. */
  z.object({ ...FieldBase, kind: z.literal("time") }),
  /**
   * Which model a run starts on (a ModelChoice): inherit (the board's setting for the operation, then the task's), a
   * tier, a custom model from Settings → Agents → Models, or a model typed for one provider. The UI lists them live, greying
   * out the providers that can't run `operation`.
   */
  z.object({
    ...FieldBase,
    kind: z.literal("model"),
    operation: OperationId.optional(),
    /** What its runs ask beyond the operation's needs (a custom agent's tools or schema), greyed out the same way. */
    needs: z.array(OperationNeed).optional(),
  }),
  /** A skill reference, picked the way the review skill is. */
  z.object({
    ...FieldBase,
    kind: z.literal("skill"),
    /** What the built-in entry is called, when it isn't the review skill (e.g. "Default workflow"). */
    builtinLabel: z.string().optional(),
  }),
]);
export type AutopilotField = z.infer<typeof AutopilotField>;

/** A field's tier; unset is advanced. */
export const fieldTier = (field: Pick<AutopilotField, "tier">): AutopilotFieldTier => field.tier ?? "advanced";

/** An automation's fields split by tier, each in the order the automation lists them. */
export function splitFieldsByTier<F extends Pick<AutopilotField, "tier">>(
  fields: readonly F[],
): { essential: F[]; advanced: F[] } {
  return {
    essential: fields.filter((f) => fieldTier(f) === "essential"),
    advanced: fields.filter((f) => fieldTier(f) === "advanced"),
  };
}

/**
 * Where an automation is listed in Settings → Autopilot: shipping work, pull requests, upkeep of the board, or the
 * user's own (custom automations, and anything that doesn't say).
 */
export const AutomationGroup = z.enum(["ship", "prs", "upkeep", "yours"]);
export type AutomationGroup = z.infer<typeof AutomationGroup>;

/** The list's headings, in the order the groups are listed. */
export const AUTOMATION_GROUPS: ReadonlyArray<{ value: AutomationGroup; label: string }> = [
  { value: "ship", label: "Ship work" },
  { value: "prs", label: "Pull requests" },
  { value: "upkeep", label: "Upkeep" },
  { value: "yours", label: "Yours" },
];

export const AutopilotAutomation = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string(),
  /** Starts an agent, so it counts against the concurrency and daily caps and waits out quiet hours. */
  needsAgent: z.boolean(),
  /** An epic can switch it on or off for its tasks. False for automations that don't act on tasks in an epic. */
  epicScope: z.boolean(),
  /** It works on a repository, so the project table leaves out the General project, which has none. */
  needsRepo: z.boolean().default(false),
  /** It has no switch: it runs wherever it has work (Recurring tasks, whose rules each have their own). */
  alwaysOn: z.boolean().default(false),
  /** Where the settings page lists it. Defaults to the user's own, as for a custom automation. */
  group: AutomationGroup.default("yours"),
  /** Why it can't be switched on yet ("Won't work until you fill in: Jira tools"), or null. */
  blocked: z.string().nullable().default(null),
  /** Which projects it is on in won't run it for lack of a variable ("Needs `jira_key` in: billing"), or null. */
  needs: z.string().nullable().default(null),
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
  /** The last on-mode set at this scope, kept through Off, so a switch can restore it; null when never on here. */
  lastOnMode: AutopilotOnMode.nullable(),
  /** On or in Preview, from this scope or one above. */
  enabled: z.boolean(),
  /** Enabled in Preview: its runs here are dry runs. */
  preview: z.boolean(),
  source: AutopilotModeSource,
  /** The config the engine would use: defaults, then every scope's keys. */
  effectiveConfig: AutopilotConfig,
});
export type AutopilotScopeEntry = z.infer<typeof AutopilotScopeEntry>;

// ── Engine ───────────────────────────────────────────────────────────────

const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");

/** Where an agent run goes. Auto: a T3 Code thread when T3 is connected, else headless. */
export const RunnerChoice = z.enum(["auto", "t3", "headless"]);
export type RunnerChoice = z.infer<typeof RunnerChoice>;

/** The runner choices as the settings list them; `short` is for one-line summaries. */
export const RUNNER_CHOICES: ReadonlyArray<{ value: RunnerChoice; label: string; short: string }> = [
  { value: "auto", label: "Auto (T3 Code when connected, else headless)", short: "Auto" },
  { value: "t3", label: "T3 Code only", short: "T3 Code" },
  { value: "headless", label: "Headless only (a CLI in a worktree)", short: "Headless" },
];

/**
 * What every agent automation runs with unless it overrides it (docs/features/autopilot.md#agent-defaults). The model
 * isn't here: it comes from Settings → Agents → Operations, per kind of run.
 */
export const AutopilotAgentDefaults = z.object({
  runner: RunnerChoice,
  /** Headless: `--max-budget-usd`, for Claude Code only (Codex and Copilot CLI have no cap). */
  budgetUsd: z.number().positive().max(100),
  /** Headless: the run is stopped after this long. */
  timeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  /** T3: the most access a thread gets; "default" is T3's own default, which is also the ceiling. */
  t3Access: z.union([z.literal("default"), T3RuntimeMode]),
});
export type AutopilotAgentDefaults = z.infer<typeof AutopilotAgentDefaults>;

/** The agent defaults' keys: an automation's config field of the same key overrides the board's value. */
export const AGENT_DEFAULT_KEYS = Object.keys(AutopilotAgentDefaults.shape) as ReadonlyArray<
  keyof AutopilotAgentDefaults
>;

export const DEFAULT_AGENT_DEFAULTS: AutopilotAgentDefaults = {
  runner: "auto",
  budgetUsd: 5,
  timeoutMinutes: 60,
  t3Access: "default",
};

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
  /** Preview everything: every automation records what would run, as skipped runs, and does nothing. */
  dryRun: z.boolean(),
  /** Days a finished headless run's worktree is kept when its PR hasn't merged; clean ones are then removed. */
  worktreeRetentionDays: z.number().int().min(1).max(365),
  /**
   * What agent automations run with when no scope of theirs sets it. Review rounds, comment rounds and the fix
   * threshold were engine settings before 044_autopilot_agent_defaults moved them into Review PRs and Fix PRs.
   */
  agentDefaults: AutopilotAgentDefaults,
});
export type AutopilotEngineSettings = z.infer<typeof AutopilotEngineSettings>;

export const DEFAULT_AUTOPILOT_ENGINE: AutopilotEngineSettings = {
  maxConcurrent: 1,
  dailyRunCap: null,
  dailySpendCapUsd: null,
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
  dryRun: false,
  worktreeRetentionDays: 7,
  agentDefaults: DEFAULT_AGENT_DEFAULTS,
};

export const UpdateAutopilotEngineInput = AutopilotEngineSettings.extend({
  quietHours: AutopilotEngineSettings.shape.quietHours.partial(),
  agentDefaults: AutopilotAgentDefaults.partial(),
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

/**
 * Why a skipped run stopped short of its work for now, to be done again later: `head_moved`, the PR's head moved on
 * before or while it ran, so the new head is acted on next. Shown as "Deferred", not as a plain skip.
 */
export const AutopilotRunDeferral = z.enum(["head_moved"]);
export type AutopilotRunDeferral = z.infer<typeof AutopilotRunDeferral>;

export const DEFERRAL_TEXT: Record<AutopilotRunDeferral, string> = { head_moved: "head moved" };

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
  /** Set on a skipped run that stopped for a reason that defers its work (AutopilotRunDeferral); null otherwise. */
  deferred: AutopilotRunDeferral.nullable(),
  needsAttention: z.boolean(),
  /** When the user dismissed the flag; the run stays flagged but no longer counts as attention. Null when not. */
  dismissedAt: z.string().nullable(),
  /** A structured result the action left for later automations to read (the PR review's verdict); null when none. */
  output: z.record(z.string(), z.unknown()).nullable(),
  /** What an agent run ran on: provider, model, effort and where the choice came from; null for other runs and older ones. */
  model: RunModelRecord.nullable(),
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

/** An automation paused in one project after failing there `AUTOPILOT_AUTO_PAUSE_FAILURES` times in a row. */
export const AutopilotAutoPause = z.object({
  automation: z.string(),
  projectId: z.string(),
  projectTitle: z.string(),
  /** "Failed 3 times in a row. The last: …". */
  reason: z.string(),
  pausedAt: z.string(),
});
export type AutopilotAutoPause = z.infer<typeof AutopilotAutoPause>;

/** What a hint's one click does. */
export const AutopilotHintAction = z.discriminatedUnion("kind", [
  /** Sets one config key of the automation at the board scope, keeping the rest of the board's own config. */
  z.object({ kind: z.literal("board_config"), label: z.string(), key: z.string(), value: z.unknown() }),
  /** Flags these tasks for Autopilot. */
  z.object({ kind: z.literal("flag_tasks"), label: z.string(), taskIds: z.array(z.string()).min(1) }),
  /** Hands an agent the failures to look into: copies this prompt. */
  z.object({ kind: z.literal("ask_agent"), label: z.string(), prompt: z.string() }),
  /** Opens Limits & safety. */
  z.object({ kind: z.literal("open_limits"), label: z.string() }),
]);
export type AutopilotHintAction = z.infer<typeof AutopilotHintAction>;

/**
 * A rule-based suggestion for tuning an automation (no model reads anything), with one click to apply it. `id` names
 * the situation, so a dismissed hint comes back only when the situation changes (a new give-up, other tasks, a new
 * failure, another week or day). Applying one dismisses it too.
 */
export const AutopilotHint = z.object({
  id: z.string(),
  /** The automation it is about; null for Autopilot as a whole (a daily cap). */
  automation: z.string().nullable(),
  tone: z.enum(["info", "warning", "danger"]),
  text: z.string(),
  action: AutopilotHintAction,
  /** What the toast says once applied. */
  done: z.string().optional(),
});
export type AutopilotHint = z.infer<typeof AutopilotHint>;

/**
 * Something in Autopilot only the user can sort out, for the Needs you list: a failed run still flagged on its task
 * (a task-less failure isn't flagged; its automation's row shows it),
 * a draft an agent wrote for them to review, or an automation that can't run as set up (a tool slot or variable
 * missing).
 */
export const AutopilotNeed = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("failed_run"),
    run: AutopilotRun,
    /** The automation's title, or its key when it is gone. */
    title: z.string(),
    /** "#12 Rewrite the cart drawer". Only a run on a task is flagged, so there always is one. */
    task: z.string(),
  }),
  z.object({
    kind: z.literal("draft"),
    draftId: z.string(),
    name: z.string(),
    /** The custom automation it proposes a new version of (its current name), or null for a new one. */
    replaces: z.object({ id: z.string(), name: z.string() }).nullable(),
    createdBy: z.string(),
    createdAt: z.string(),
  }),
  z.object({
    kind: z.literal("setup"),
    automation: z.string(),
    title: z.string(),
    /** What is missing, as the automation's `blocked` or `needs` says it. */
    reason: z.string(),
  }),
  /**
   * Another person's PR Review PRs found clean, but that only the user can approve: the approval gate stopped it (a
   * sensitive path, a required check, no linked issue) or Approve is off. Gone once the PR is approved, closed or moves.
   */
  z.object({
    kind: z.literal("pr_approval"),
    url: z.string(),
    /** "acme/app#42". */
    pr: z.string(),
    title: z.string(),
    author: z.string().nullable(),
    /** What stopped the approval, e.g. "touches sensitive paths: .github/workflows/ci.yml". */
    reason: z.string(),
    since: z.string(),
  }),
]);
export type AutopilotNeed = z.infer<typeof AutopilotNeed>;

/** `GET /api/autopilot`: engine settings, pause and the catalogue, and what the page's status strip reads. */
export const AutopilotOverview = z.object({
  paused: z.boolean(),
  engine: AutopilotEngineSettings,
  automations: z.array(AutopilotAutomation),
  /** Since local midnight: real agent runs started (as the daily run cap counts them) and what runs cost. */
  today: z.object({ agentRuns: z.number().int(), spendUsd: z.number() }),
  /** Failed runs (newest first), PRs waiting for the user's approval (oldest first), drafts, then setup gaps. */
  needsYou: z.array(AutopilotNeed),
  /** Automations that paused themselves in a project after failing there in a row, newest first. */
  autoPaused: z.array(AutopilotAutoPause),
  /** Tuning hints not dismissed, for Needs you and each automation's detail. */
  hints: z.array(AutopilotHint),
  /** Each automation's latest real run that has finished, for its row in the list; none for one that never ran. */
  lastRuns: z.array(z.object({ automation: z.string(), status: AutopilotRunStatus, at: z.string() })),
  /** Each automation's dry runs ("would …") over the last 7 days, for its Preview hint; none for one with none. */
  previewRuns: z.array(z.object({ automation: z.string(), count: z.number().int() })),
});
export type AutopilotOverview = z.infer<typeof AutopilotOverview>;

/**
 * Why Orchestrate's next slot in a project won't start a run, the first that applies: switched off there, Pause all,
 * quiet hours at the slot, a daily cap reached, or nothing to look at.
 */
export const OrchestrateHold = z.enum(["off", "paused", "quiet_hours", "daily_cap", "idle"]);
export type OrchestrateHold = z.infer<typeof OrchestrateHold>;

/** Attention that is the user's to answer: an orchestrator can only wait on it. */
const WAITING_ON_USER = new Set(["agent_request", "thread_needs_input"]);

/**
 * A task Orchestrate has a reason to look at: work going on, something wrong with it (a failed start included), or a
 * Review task it may merge. One waiting on the user isn't, nor a Review task with nothing wrong that only the user
 * merges, or a project whose work all waits on them would start a paid run every slot. Planned tasks are Start
 * planned's to start, so they count only once flagged. Manual tasks are the user's, so they never count. A project with
 * none of these is idle: its slots don't run.
 */
export const orchestrateNeedsLooking = (
  t: Pick<TaskSummary, "archivedAt" | "status" | "attention" | "autoMerge" | "manual">,
): boolean =>
  t.archivedAt === null &&
  !t.manual &&
  t.status !== "done" &&
  !t.attention.some((a) => WAITING_ON_USER.has(a.kind)) &&
  (t.status === "in_progress" || (t.status === "review" && t.autoMerge === true) || t.attention.length > 0);

/** `GET /api/autopilot/orchestrate/:projectId`: Orchestrate in one project, for its section of the lane popover. */
export const OrchestrateState = z.object({
  enabled: z.boolean(),
  everyMinutes: z.number().int(),
  /** The next slot (`nextMinutesSlot`): when the next check is due, not a promise of a run. */
  nextSlotAt: z.string(),
  /** Why that slot won't run; null when it will, if there is still something to look at by then. */
  hold: OrchestrateHold.nullable(),
  /** A run is queued or running in the project. */
  running: z.boolean(),
  /** When Run now was asked for, until its run is recorded; null when there is no request. */
  requestedAt: z.string().nullable(),
  /** The project's latest real Orchestrate run, finished or not. */
  lastRun: AutopilotRun.nullable(),
});
export type OrchestrateState = z.infer<typeof OrchestrateState>;

/**
 * A retried run keeps its row as history under this prefix plus its id, so its old dedupe key is free for the
 * engine to act on again and automations that read keys (rounds, attempts) no longer count it.
 */
export const RETRIED_PREFIX = "retried:";

export const isRetried = (dedupeKey: string): boolean => dedupeKey.startsWith(RETRIED_PREFIX);

/** The key a retired one (`retried:<runId>:<key>`) had before it was retired. */
export const unretiredKey = (dedupeKey: string): string =>
  isRetried(dedupeKey) ? dedupeKey.slice(dedupeKey.indexOf(":", RETRIED_PREFIX.length) + 1) : dedupeKey;

/**
 * Whether the same automation has made a real run on the same task (or, for a task-less run, in the same project)
 * since this one. A superseded run's work is history: retrying it would redo nothing, yet drop it from the rounds and
 * attempts its automation counts. `others` is newest first, as the board lists runs: when it holds the run, the runs
 * before it are the later ones, since two runs made in one millisecond share a `createdAt` and only the list's order
 * (rowid) tells them apart. A run not in the list is compared by time.
 */
export function isSupersededRun(
  run: Pick<AutopilotRun, "id" | "automation" | "taskId" | "projectId" | "createdAt">,
  others: readonly Pick<AutopilotRun, "id" | "automation" | "taskId" | "projectId" | "dryRun" | "createdAt">[],
): boolean {
  const at = others.findIndex((o) => o.id === run.id);
  const later = at >= 0 ? others.slice(0, at) : others.filter((o) => o.createdAt > run.createdAt);
  return later.some(
    (o) =>
      !o.dryRun &&
      o.automation === run.automation &&
      (run.taskId ? o.taskId === run.taskId : o.taskId === null && o.projectId === run.projectId),
  );
}

/**
 * Whether a run can be retried: a real run that ended failed or skipped, hasn't been retried already and, given the
 * runs around it, hasn't been superseded by a later run of its automation.
 */
export const canRetryRun = (
  run: Pick<
    AutopilotRun,
    "id" | "automation" | "taskId" | "projectId" | "createdAt" | "dryRun" | "status" | "dedupeKey"
  >,
  others: Parameters<typeof isSupersededRun>[1] = [],
): boolean =>
  !run.dryRun &&
  (run.status === "failed" || run.status === "skipped") &&
  !isRetried(run.dedupeKey) &&
  !isSupersededRun(run, others);

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
    case "retried":
      return payload.reason === "restart"
        ? `${title} will try again, since the board restarted while it was going: ${summary}`
        : `asked ${title} to try again: ${summary}`;
    case "dismissed":
      return `dismissed the ${title} flag: ${summary}`;
    default:
      return payload.dryRun === true ? `${title} (dry run): ${summary}` : `skipped ${title}: ${summary}`;
  }
}
