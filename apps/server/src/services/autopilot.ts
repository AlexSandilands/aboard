import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  AUTOMATION_WEEK_DAYS,
  AUTOMATION_WEEK_LAST_RUNS,
  AUTOPILOT_ACTIVE_STATUSES,
  AUTOPILOT_ACTOR,
  AUTOPILOT_AUTO_PAUSE_FAILURES,
  AUTOPILOT_START_PLANNED,
  automationHints,
  automationTitleOf,
  autoPauseReason,
  engineHints,
  failureStreak,
  AUTOPILOT_FIX_PRS,
  AUTOPILOT_REVIEW_PRS,
  BOARD_RESTARTED_ERROR,
  CUSTOM_AUTOMATION_PREFIX,
  AutopilotEngineSettings,
  AutopilotKeptReason,
  capHandover,
  DEFAULT_AUTOPILOT_ENGINE,
  CHECK_FAILED_KEY_PREFIX,
  FIX_GAVE_UP_KEY_PREFIX,
  FIX_RESOLVE_KEY_PREFIX,
  isRetried,
  isSupersededRun,
  parseLogins,
  resolveAutopilot,
  RETRIED_PREFIX,
  RUN_DELETE_MIN_AGE_MS,
  RUN_PAGE_DEFAULT,
  ScheduledAgentRunOutput,
  unretiredKey,
  type AutomationWeek,
  type AutopilotAutoPause,
  type AutopilotAutomation,
  type AutopilotHint,
  type AutopilotNeed,
  type AutopilotOverview,
  type AutopilotRun,
  type AutopilotRunPage,
  type AutopilotModeRow,
  type AutopilotScopeEntry,
  type AutopilotScopeKind,
  type AutopilotSetting,
  type AutopilotStatus,
  type DeleteAutopilotRunsInput,
  type DeleteAutopilotRunsResult,
  type ListAutopilotRunsQuery,
  type UpdateAutopilotEngineInput,
  type TaskSummary,
  type UpdateAutopilotSettingInput,
  isOnMode,
  PREVIEW_WINDOW_MS,
} from "@repo/contracts";
import { AUTOPILOT_AUTO_ARCHIVE } from "../autopilot/automations/autoArchive.ts";
import { startOfDay } from "../autopilot/limits.ts";
import { agentDefaultsFor } from "../autopilot/runnerOptions.ts";
import type { ActionResult, Automation, AutomationConfig, Candidate, RunPatch } from "../autopilot/types.ts";
import { nowIso } from "../db/database.ts";
import type { Repos } from "../db/repos/index.ts";
import type { RunDeleteFacts } from "../db/repos/autopilotRuns.ts";
import { AppError } from "../errors.ts";
import type { Core, Effects } from "./core.ts";
import type { NotificationsService } from "./notifications.ts";

/** Settings-table keys for the engine. Only the settings are exported in backups; pause stays with the machine. */
export const AUTOPILOT_ENGINE_KEY = "autopilotEngine";
export const AUTOPILOT_PAUSED_KEY = "autopilotPaused";
/** The tuning hints the user dismissed, by id, newest last. Machine state like pause: not in backups. */
export const AUTOPILOT_DISMISSED_HINTS_KEY = "autopilotDismissedHints";
const DISMISSED_HINTS_MAX = 200;

/** The engine settings stored, over the defaults; a value that no longer parses falls back to them. */
export function loadAutopilotEngine(repos: Repos): AutopilotEngineSettings {
  // One row, not the whole table: the service reads it on every resolve, for the agent defaults.
  const raw = repos.settings.get(AUTOPILOT_ENGINE_KEY);
  const stored = raw && typeof raw === "object" ? (raw as Partial<Record<keyof AutopilotEngineSettings, unknown>>) : {};
  const agentDefaults = stored.agentDefaults && typeof stored.agentDefaults === "object" ? stored.agentDefaults : {};
  const parsed = AutopilotEngineSettings.safeParse({
    ...DEFAULT_AUTOPILOT_ENGINE,
    ...stored,
    agentDefaults: { ...DEFAULT_AUTOPILOT_ENGINE.agentDefaults, ...agentDefaults },
  });
  return parsed.success ? parsed.data : DEFAULT_AUTOPILOT_ENGINE;
}

/** The epic a run on this task belongs to: its parent, or itself for an epic (Auto-archive runs on epic cards). */
const epicOf = (task: { id: string; kind: string; parentId: string | null } | null | undefined): string | null =>
  (task?.kind === "epic" ? task.id : task?.parentId) || null;

/** Pause and the runs in flight: what autopilot.changed and the board snapshot carry. */
export function loadAutopilotStatus(repos: Repos): AutopilotStatus {
  return {
    paused: repos.settings.all().get(AUTOPILOT_PAUSED_KEY) === true,
    active: repos.autopilotRuns
      .withStatus(AUTOPILOT_ACTIVE_STATUSES)
      .map(({ id, automation, taskId, projectId, status }) => ({
        id,
        automation,
        taskId,
        projectId,
        status,
        epicId: taskId ? epicOf(repos.tasks.get(taskId)) : null,
      })),
  };
}

/** `defaults`: what applies where no scope sets a key, the board's agent defaults included. */
export const describeAutomation = (
  a: Automation,
  needs: string | null = null,
  defaults: AutopilotAutomation["defaults"] = a.defaults,
): AutopilotAutomation => ({
  key: a.key,
  title: a.title,
  description: a.description,
  needsAgent: a.needsAgent,
  epicScope: a.epicScope ?? true,
  alwaysOn: a.alwaysOn ?? false,
  group: a.group ?? "yours",
  blocked: a.blocked ?? null,
  needs,
  fields: a.fields,
  defaults,
});

/** An automation's effective state for one project (or the board, with null). */
export interface ResolvedAutomation {
  /** On or in Preview. */
  enabled: boolean;
  /** In Preview: its runs here are dry runs. */
  preview: boolean;
  /** Parsed over the automation's defaults; null when the stored config no longer parses. */
  config: AutomationConfig | null;
}

export interface RecordRunInput {
  automation: string;
  candidate: Candidate;
  dryRun: boolean;
}

/** Autopilot settings, the engine's limits and pause, and the run history (docs/features/autopilot.md). */
export interface AutopilotService {
  overview(): AutopilotOverview;
  status(): AutopilotStatus;
  automations(): readonly Automation[];
  engine(): AutopilotEngineSettings;
  updateEngine(input: UpdateAutopilotEngineInput): AutopilotEngineSettings;
  /** Pause all: no new runs start; runs already going finish. */
  setPaused(paused: boolean): AutopilotStatus;
  /**
   * Every automation as seen from a scope: its setting there and what it resolves to. An epic scope needs the
   * project it must be in (`projectId`); any other epic is not found.
   */
  scope(kind: AutopilotScopeKind, id: string | null, projectId?: string): AutopilotScopeEntry[];
  /**
   * Every switch that is set (not Inherit) at any scope, for the Where it runs widget: one read instead of a scope per
   * project and epic. Rows of an archived epic or project are listed too; the UI shows only scopes it has.
   */
  modes(): AutopilotModeRow[];
  /** Sets one automation's mode and/or config at a scope. Inherit with no config removes the row. */
  setScope(
    kind: AutopilotScopeKind,
    id: string | null,
    automation: string,
    input: UpdateAutopilotSettingInput,
    projectId?: string,
  ): AutopilotScopeEntry[];
  /**
   * What the engine uses: on or off, and the config, for the board (null), a project, or a task of the project in
   * `epicId` (an epic that is archived or in another project doesn't count).
   */
  resolve(automation: Automation, projectId: string | null, epicId?: string | null): ResolvedAutomation;
  /**
   * Projects with an epic, not archived, that switches the automation on (or, unless `live`, into Preview): the engine
   * must look there even when the project is off.
   */
  projectsWithEpicOn(automation: Automation, live?: boolean): ReadonlySet<string>;
  /** Epics with a setting of their own for the automation: their tasks follow the epic, not the project. */
  epicsWithOwnSetting(automation: Pick<Automation, "key" | "epicScope">): ReadonlySet<string>;
  /** Newest first. */
  runsForTask(taskId: string, limit?: number): AutopilotRun[];
  /** Newest first. */
  runsForProject(projectId: string, limit?: number): AutopilotRun[];
  /** One automation's runs in a project, newest first. */
  automationRunsForProject(automation: string, projectId: string, limit?: number): AutopilotRun[];
  /** An automation's last seven days, for its This week section. */
  week(automation: string): AutomationWeek;
  /** Hides a tuning hint until its situation changes (its id with it). */
  dismissHint(id: string): void;
  /** Whether the automation paused itself in the project after failing there in a row. */
  isAutoPaused(automation: string, projectId: string): boolean;
  /** Lifts an auto-pause; failures count again from now. Publishes autopilot.changed. */
  resumeAutoPause(automation: string, projectId: string): void;
  /** One page of an automation's (or every automation's) runs for the history page, newest first. */
  history(query: ListAutopilotRunsQuery): AutopilotRunPage;
  /**
   * Deletes runs by hand (the history page: nothing deletes them automatically), or with `preview` only counts what
   * would go. Runs the engine still reads, or may redo work without, are kept and reported with why: those still
   * queued or running, with a worktree on disk, on a task that isn't done, the latest answer of a scheduled agent in
   * its project, and any under a day old. One transaction; publishes autopilot.changed.
   */
  deleteRuns(input: DeleteAutopilotRunsInput): DeleteAutopilotRunsResult;
  hasRun(automation: string, dedupeKey: string, dryRun: boolean): boolean;
  /**
   * The handover the last successful run of a scheduled agent left in a project, for its next run; null when it has
   * none yet. A failed run leaves none, so the one before it is passed on.
   */
  lastHandover(automation: string, projectId: string): string | null;
  /** The run that made this headless session; null when Autopilot didn't. */
  runForSession(sessionId: string): AutopilotRun | null;
  /**
   * When the board's setting for an automation (its switch or config) last changed; null when it has none. With a
   * project, the latest of the board's and that project's.
   */
  settingChangedAt(automation: string, projectId?: string): string | null;
  /** Finished headless runs that made a worktree, oldest first. */
  finishedWithWorktree(): AutopilotRun[];
  /** Real agent runs started and spend since `since`, and agent runs going now. */
  usage(agentAutomations: readonly string[], since: string): { started: number; spendUsd: number; active: number };
  /**
   * Records a candidate as a run: queued, or skipped with "Would …" in dry-run. Null when the dedupe key already
   * has one (another pass got there first).
   */
  record(input: RecordRunInput): AutopilotRun | null;
  /**
   * Lets the engine try a finished run's work again: a run that failed (a board restart strands runs as failed) or
   * was skipped. The run stays as history under a retired dedupe key (`retried:<id>:<key>`), so the automation no
   * longer sees it, and its attention flag is lifted. The next pass decides whether there is still work: switches,
   * pause, quiet hours and the caps apply as usual.
   */
  retry(runId: string, actor: string): AutopilotRun;
  /**
   * Lifts the needs-attention flag the user has dealt with, without redoing anything: the run stays as it was (failed
   * or skipped, dedupe key kept), so the engine doesn't act on it again. Covers every flagged run of the task, so an
   * older flag doesn't surface in its place. Only a flagged run on a task, whose flag still stands, can be dismissed; dismissing again changes nothing.
   */
  dismiss(runId: string, actor: string): AutopilotRun;
  /** queued → running. */
  start(runId: string): AutopilotRun;
  /** Runner details on a run in flight. */
  update(runId: string, patch: RunPatch): AutopilotRun;
  /** Ends a run with the action's result, logging it on the task. */
  finish(runId: string, result: ActionResult): AutopilotRun;
  /**
   * Ends the runs a restart left queued or running as failed. A Review PRs or Fix PRs run is retried once, as by
   * `retry` (its key retired, no flag), so the engine redoes the work; a run whose work a restart already cut short
   * is flagged instead, which stops a loop when the run itself restarts the board. Any other run is flagged, since
   * redoing it could launch an agent twice. Returns how many.
   */
  recover(): number;
  /**
   * Asks for a run of an automation in a project now (Orchestrate's Run now), publishing autopilot.changed so the
   * engine looks at once. The automation's `check` turns it into a candidate and clears it. Kept in memory: a restart
   * drops it. Returns when it was asked for; asking again while one is waiting keeps the first.
   */
  requestRun(automation: string, projectId: string): string;
  /** When a run was asked for and not yet cleared; null when none is waiting or it is older than RUN_REQUEST_TTL_MS. */
  runRequest(automation: string, projectId: string): string | null;
  clearRunRequest(automation: string, projectId: string): void;
}

const RUN_LIMIT = 50;

/** Why a hand delete leaves this run alone, if it does (see `AutopilotService.deleteRuns`). */
function keptReason(run: RunDeleteFacts, now: number): AutopilotKeptReason | null {
  if (AUTOPILOT_ACTIVE_STATUSES.includes(run.status)) return "active";
  // The worktree cleanup finds a run's worktree through its row, so the row stays while the folder does.
  if (run.worktreePath && existsSync(run.worktreePath)) return "worktree";
  if (run.openTask) return "open_task";
  // These key their runs by the task's own state, so a deleted run lets them act on it again: Auto-archive on a task
  // someone unarchived, a custom trigger that still holds. (Other automations' keys follow a PR head, a slot or a
  // cursor that has moved on, or sit on tasks that are open while they matter.)
  if (
    run.taskId &&
    (run.automation === AUTOPILOT_AUTO_ARCHIVE || run.automation.startsWith(CUSTOM_AUTOMATION_PREFIX))
  ) {
    return "task_key";
  }
  if (run.latestAnswer) return "latest_answer";
  if (now - Date.parse(run.createdAt) < RUN_DELETE_MIN_AGE_MS) return "recent";
  return null;
}
/** How long a Run now request waits for the engine before it is dropped. */
export const RUN_REQUEST_TTL_MS = 60 * 60_000;

/** The automations whose run a restart cut short is retried once (see `recover`). */
const RETRIED_AFTER_RESTART: ReadonlySet<string> = new Set([AUTOPILOT_REVIEW_PRS, AUTOPILOT_FIX_PRS]);

export function createAutopilotService(
  core: Core,
  deps: {
    /** The catalogue, read on every call: custom automations come and go. */
    automations: () => readonly Automation[];
    notifications: NotificationsService;
    /**
     * An automation just started applying to these projects: its switch went on for them, or Pause all was lifted.
     * For automations that keep their own schedule and must not catch up on what passed meanwhile.
     */
    onEnabled?: (automation: string, projectIds: readonly string[]) => void;
    /** The same for epics with a setting of their own, when the automation turned on for their tasks. */
    onEpicEnabled?: (automation: string, epicIds: readonly string[]) => void;
    /**
     * These epics just got a setting of their own, so their tasks stop following the project's switch. Called before
     * onEpicEnabled, so an epic that was on through its project can carry over the project's state.
     */
    onEpicOwnSetting?: (automation: string, epicIds: readonly string[]) => void;
    /** Planned tasks in these projects, for Start planned's hint about tasks nobody flagged. */
    plannedTasks?: (projectIds: readonly string[]) => readonly TaskSummary[];
  },
): AutopilotService {
  const { repos } = core;
  /** Run now requests by `automation:projectId`, with when they were made. */
  const requests = new Map<string, string>();
  const requestKey = (automation: string, projectId: string) => `${automation}:${projectId}`;
  const runRequest = (automation: string, projectId: string): string | null => {
    const key = requestKey(automation, projectId);
    const at = requests.get(key);
    if (!at) return null;
    // A request the engine couldn't act on for this long (no free slot all that time) is dropped rather than started
    // out of the blue later.
    if (Date.now() - new Date(at).getTime() > RUN_REQUEST_TTL_MS) {
      requests.delete(key);
      return null;
    }
    return at;
  };
  const find = (key: string) => deps.automations().find((a) => a.key === key);
  const titleOf = (key: string) => automationTitleOf(deps.automations(), key);

  const epicScoped = (a: Pick<Automation, "epicScope">) => a.epicScope ?? true;

  const automationOf = (key: string): Automation => {
    const automation = find(key);
    if (!automation) throw new AppError("NOT_FOUND", `No automation ${key}`);
    return automation;
  };

  const runOf = (id: string): AutopilotRun => {
    const run = repos.autopilotRuns.get(id);
    if (!run) throw new AppError("NOT_FOUND", `Autopilot run ${id} not found`);
    return run;
  };

  /** Checks the scope exists and returns its id as stored (null for the board). An epic must be one in `projectId`. */
  const checkScope = (kind: AutopilotScopeKind, id: string | null, projectId?: string): string | null => {
    if (kind === "board") {
      if (id) throw new AppError("VALIDATION", "The board scope has no id");
      return null;
    }
    if (kind === "epic") {
      const epic = id ? repos.tasks.get(id) : undefined;
      if (!epic || epic.kind !== "epic" || epic.projectId !== projectId) {
        throw new AppError("NOT_FOUND", `Epic ${id ?? ""} not found in this project`);
      }
      return epic.id;
    }
    if (!id || !repos.projects.get(id)) throw new AppError("NOT_FOUND", `Project ${id ?? ""} not found`);
    return id;
  };

  /** Whether an epic is a scope for its tasks: one in the project, and not archived. */
  const countsAsScope = (epicId: string | null | undefined, projectId: string | null): epicId is string => {
    if (!epicId || projectId === null) return false;
    const epic = repos.tasks.get(epicId);
    return epic?.kind === "epic" && epic.projectId === projectId && epic.archivedAt === null;
  };

  /** Settings from least to most specific scope for a project (or just the board), and for an epic in it. */
  const chainFor = (
    all: readonly AutopilotSetting[],
    automation: string,
    projectId: string | null,
    epicId: string | null = null,
  ) => {
    const at = (kind: AutopilotScopeKind, id: string) =>
      all.find((s) => s.scopeKind === kind && s.scopeId === id && s.automation === automation);
    return [
      all.find((s) => s.scopeKind === "board" && s.automation === automation),
      projectId === null ? undefined : at("project", projectId),
      epicId === null ? undefined : at("epic", epicId),
    ];
  };

  /** The automation's defaults with the board's agent defaults laid over them: what applies where no scope sets a key. */
  const defaultsOf = (automation: Automation, board = loadAutopilotEngine(repos).agentDefaults): AutomationConfig => ({
    ...automation.defaults,
    ...agentDefaultsFor(automation, board),
  });

  const parseConfig = (automation: Automation, config: AutomationConfig, defaults = defaultsOf(automation)) =>
    automation.schema.safeParse({ ...defaults, ...config });

  const entries = (kind: AutopilotScopeKind, id: string | null, projectId?: string): AutopilotScopeEntry[] => {
    const all = repos.autopilotSettings.all();
    const board = loadAutopilotEngine(repos).agentDefaults;
    return deps
      .automations()
      .filter((automation) => kind !== "epic" || epicScoped(automation))
      .map((automation) => {
        const own = all.find((s) => s.scopeKind === kind && s.scopeId === id && s.automation === automation.key);
        const resolved = resolveAutopilot(
          chainFor(all, automation.key, kind === "board" ? null : (projectId ?? id), kind === "epic" ? id : null),
        );
        const defaults = defaultsOf(automation, board);
        const parsed = parseConfig(automation, resolved.config, defaults);
        return {
          automation: automation.key,
          mode: own?.mode ?? "inherit",
          config: own?.config ?? {},
          lastOnMode: own?.lastOnMode ?? null,
          enabled: resolved.enabled,
          preview: resolved.preview,
          source: resolved.source,
          effectiveConfig: parsed.success ? parsed.data : { ...defaults, ...resolved.config },
        };
      });
  };

  /**
   * Epics with a setting of their own for the automation (any mode, or config), that count as a scope. A row kept only
   * to remember its last on-mode (Inherit, no config) is no setting: the epic follows its project.
   */
  const epicsWithOwnSetting = (automation: Pick<Automation, "key" | "epicScope">): string[] => {
    if (!epicScoped(automation)) return [];
    return repos.autopilotSettings
      .all()
      .filter((s) => s.scopeKind === "epic" && s.automation === automation.key)
      .filter((s) => s.mode !== "inherit" || Object.keys(s.config).length > 0)
      .map((s) => repos.tasks.get(s.scopeId!))
      .filter((epic) => epic && countsAsScope(epic.id, epic.projectId))
      .map((epic) => epic!.id);
  };

  /** Whether the automation is on (in Preview too) and live for each of these epics' tasks, as the engine resolves it. */
  const epicStates = (
    automation: Automation,
    epicIds: Iterable<string>,
  ): Map<string, { on: boolean; live: boolean }> => {
    const all = repos.autopilotSettings.all();
    const states = new Map<string, { on: boolean; live: boolean }>();
    for (const epicId of epicIds) {
      const epic = repos.tasks.get(epicId);
      if (!epic || !countsAsScope(epic.id, epic.projectId)) continue;
      const resolved = resolveAutopilot(chainFor(all, automation.key, epic.projectId, epic.id));
      states.set(epicId, { on: resolved.enabled, live: resolved.enabled && !resolved.preview });
    }
    return states;
  };

  /**
   * The projects an automation is on for (in Preview too), with the board's setting and any project's own taken into
   * account; with `live`, only those where it runs for real.
   */
  const enabledProjects = (key: string, live = false): string[] => {
    const all = repos.autopilotSettings.all();
    const always = find(key)?.alwaysOn === true;
    return repos.projects
      .list()
      .filter((p) => {
        if (always) return true;
        const resolved = resolveAutopilot(chainFor(all, key, p.id));
        return resolved.enabled && (!live || !resolved.preview);
      })
      .map((p) => p.id);
  };

  const logRun = (fx: Effects, run: AutopilotRun) => {
    if (!run.taskId) return;
    fx.log(run.taskId, AUTOPILOT_ACTOR, "autopilot_run", {
      automation: run.automation,
      title: titleOf(run.automation),
      status: run.status,
      summary: run.summary,
      ...(run.dryRun ? { dryRun: true } : {}),
      ...(run.error ? { error: run.error } : {}),
    });
  };

  /** A real run that failed, or that ended asking for the user, goes to the inbox once. */
  const notifyEnded = (run: AutopilotRun) => {
    if (run.dryRun || (run.status !== "failed" && !run.needsAttention)) return;
    const task = run.taskId ? repos.tasks.get(run.taskId) : null;
    const title = titleOf(run.automation);
    deps.notifications.notify({
      kind: "autopilot_failed",
      taskId: run.taskId,
      title: run.status === "failed" ? `${title} failed` : `${title} needs you`,
      body: [task ? `#${task.number} ${task.title}` : null, run.error ?? run.summary].filter(Boolean).join("\n"),
      dedupeKey: `autopilot:${run.id}`,
    });
  };

  /** The runs on the same task (or, without one, in the same project), newest first. */
  const runsAround = (run: AutopilotRun): AutopilotRun[] =>
    run.taskId
      ? repos.autopilotRuns.forTask(run.taskId, 500)
      : run.projectId
        ? repos.autopilotRuns.forProject(run.projectId, 500)
        : [];

  const retiredKey = (run: AutopilotRun) => `${RETRIED_PREFIX}${run.id}:${run.dedupeKey}`;

  /** Whether a restart already cut short an earlier run of the same work (same automation and key). */
  const restartedBefore = (run: AutopilotRun): boolean =>
    runsAround(run).some(
      (o) =>
        o.automation === run.automation &&
        !o.dryRun &&
        isRetried(o.dedupeKey) &&
        unretiredKey(o.dedupeKey) === run.dedupeKey &&
        (o.error ?? "").startsWith(BOARD_RESTARTED_ERROR),
    );

  const save = (run: AutopilotRun, opts: { log?: boolean } = {}): AutopilotRun => {
    core.write((fx) => {
      repos.autopilotRuns.update(run);
      if (opts.log) logRun(fx, run);
      // The card's attention reason may change with the run.
      else if (run.taskId) fx.task(run.taskId);
      if (run.finishedAt) notifyEnded(run);
      fx.autopilot();
    });
    return run;
  };

  /** Which of the projects an automation is on in (or one of whose epics it is on in) won't run it, and why, or null. */
  const needsOf = (automation: Automation): string | null => {
    if (!automation.needs) return null;
    const settings = repos.autopilotSettings.all();
    const withEpicOn = new Set(
      epicScoped(automation)
        ? settings.flatMap((s) => {
            if (s.scopeKind !== "epic" || !isOnMode(s.mode) || s.automation !== automation.key) return [];
            const epic = repos.tasks.get(s.scopeId!);
            return epic && countsAsScope(epic.id, epic.projectId) ? [epic.projectId] : [];
          })
        : [],
    );
    const on = repos.projects
      .list()
      .filter((p) => withEpicOn.has(p.id) || resolveAutopilot(chainFor(settings, automation.key, p.id, null)).enabled);
    return automation.needs(on, (p) => ({
      ...automation.defaults,
      ...resolveAutopilot(chainFor(settings, automation.key, p.id, null)).config,
    }));
  };

  const usage = (agentAutomations: readonly string[], since: string) => {
    const agents = new Set(agentAutomations);
    return {
      started: repos.autopilotRuns.startedSince(agentAutomations, since),
      spendUsd: repos.autopilotRuns.spendSince(since),
      active: repos.autopilotRuns
        .withStatus(AUTOPILOT_ACTIVE_STATUSES)
        .filter(
          (r) =>
            !r.dryRun &&
            agents.has(r.automation) &&
            !r.dedupeKey.startsWith(FIX_GAVE_UP_KEY_PREFIX) &&
            !r.dedupeKey.startsWith(FIX_RESOLVE_KEY_PREFIX) &&
            !r.dedupeKey.startsWith(CHECK_FAILED_KEY_PREFIX),
        ).length,
    };
  };

  /**
   * The Needs you list: failed runs whose flag still stands on their task (one per task, the latest), drafts waiting
   * for review, then automations that can't run as set up. Only a run on a task is flagged (and can be dismissed), so
   * a task-less failure (a digest's) shows on its automation's row instead.
   */
  const needsYou = (described: readonly AutopilotAutomation[]): AutopilotNeed[] => {
    const seen = new Set<string>();
    const failed = repos.autopilotRuns.standingFailures(50).flatMap((run): AutopilotNeed[] => {
      const taskId = run.taskId!;
      if (seen.has(taskId)) return [];
      seen.add(taskId);
      const task = repos.tasks.get(taskId);
      if (!task || task.archivedAt) return [];
      return [
        {
          kind: "failed_run",
          run,
          title: titleOf(run.automation),
          task: `#${task.number} ${task.title}`,
        },
      ];
    });
    const now = core.now().getTime();
    const drafts = repos.autopilotDrafts
      .all()
      .filter((d) => Date.parse(d.expiresAt) > now)
      .map((d): AutopilotNeed => ({
        kind: "draft",
        draftId: d.id,
        name: d.bundle.name,
        replaces: d.replaces
          ? { id: d.replaces, name: repos.autopilotCustom.get(d.replaces)?.name ?? d.bundle.name }
          : null,
        createdBy: d.createdBy,
        createdAt: d.createdAt,
      }));
    const setup = described.flatMap((a): AutopilotNeed[] =>
      a.blocked || a.needs
        ? [{ kind: "setup", automation: a.key, title: a.title, reason: (a.blocked ?? a.needs)! }]
        : [],
    );
    // Other people's PRs Review PRs found clean that only the user can approve, while it still reviews them there: a row
    // left from before the source (or the author) was switched off would never be lifted by a poll.
    const autopilotSettings = repos.autopilotSettings.all();
    const reviewPrs = deps.automations().find((a) => a.key === AUTOPILOT_REVIEW_PRS);
    const stillReviewed = (projectId: string, author: string | null): boolean => {
      if (!reviewPrs) return false;
      const resolved = resolveAutopilot(chainFor(autopilotSettings, AUTOPILOT_REVIEW_PRS, projectId, null));
      const config = { ...reviewPrs.defaults, ...resolved.config };
      return resolved.enabled && config.otherPrs === true && parseLogins(config.otherAuthors).includes(author ?? "");
    };
    const approvals = repos.repoPrReviews
      .ready()
      .filter((r) => stillReviewed(r.projectId, r.author))
      .map((r): AutopilotNeed => ({
        kind: "pr_approval",
        url: r.url,
        pr: `${r.repo}#${r.number}`,
        title: r.title,
        author: r.author,
        reason: r.reasonDetail ?? "ready for your approval",
        since: r.readySince!,
      }));
    return [...failed, ...approvals, ...drafts, ...setup];
  };

  /** Local midnight `days` days before today's. */
  const dayStart = (now: Date, days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  const localDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const week = (automation: string): AutomationWeek => {
    const now = core.now();
    const days = Array.from({ length: AUTOMATION_WEEK_DAYS }, (_, i) => dayStart(now, AUTOMATION_WEEK_DAYS - 1 - i));
    const since = days[0]!.toISOString();
    const runs = repos.autopilotRuns.automationSince(automation, since);
    const real = runs.filter((r) => !r.dryRun);
    const acted = real.filter((r) => r.status !== "skipped");
    // Newest first, as the repo lists them.
    const gaveUpRuns = (budget: string) =>
      real.filter((r) => {
        const k = unretiredKey(r.dedupeKey);
        return k.startsWith(FIX_GAVE_UP_KEY_PREFIX) && k.endsWith(`:${budget}`);
      });
    const gaveUp = (budget: string) => new Set(gaveUpRuns(budget).map((r) => unretiredKey(r.dedupeKey))).size;
    return {
      automation,
      since,
      runs: acted.length,
      failed: acted.filter((r) => r.status === "failed").length,
      deferred: real.filter((r) => r.status === "skipped" && r.deferred !== null).length,
      spendUsd: real.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
      wouldRun: runs.length - real.length,
      gaveUp: { review: gaveUp("review"), comments: gaveUp("comments") },
      lastGaveUp: { review: gaveUpRuns("review")[0]?.id ?? null, comments: gaveUpRuns("comments")[0]?.id ?? null },
      days: days.map((day, i) => {
        const end = days[i + 1]?.toISOString() ?? "\uffff";
        const start = day.toISOString();
        const inDay = acted.filter((r) => r.createdAt >= start && r.createdAt < end);
        return {
          date: localDate(day),
          runs: inDay.length,
          failed: inDay.filter((r) => r.status === "failed").length,
        };
      }),
      lastRuns: repos.autopilotRuns.latestFinishedOf(automation, AUTOMATION_WEEK_LAST_RUNS),
    };
  };

  /** When the automation's setting last changed at the board, or at the board or the project when one is given. */
  const settingChangedAt = (automation: string, projectId?: string): string | null =>
    repos.autopilotSettings
      .all()
      .filter(
        (s) =>
          s.automation === automation &&
          (s.scopeKind === "board" ||
            (projectId !== undefined && s.scopeKind === "project" && s.scopeId === projectId)),
      )
      .map((s) => s.updatedAt)
      .sort()
      .at(-1) ?? null;

  const dismissedHints = (): string[] => {
    const stored = repos.settings.all().get(AUTOPILOT_DISMISSED_HINTS_KEY);
    return Array.isArray(stored) ? stored.filter((v): v is string => typeof v === "string") : [];
  };

  /** Every tuning hint the user hasn't dismissed: Autopilot-wide first, then each automation's that is on somewhere. */
  const hints = (today: { agentRuns: number; spendUsd: number }): AutopilotHint[] => {
    const engine = loadAutopilotEngine(repos);
    const dismissed = new Set(dismissedHints());
    const all = [...engineHints({ engine, today, date: localDate(core.now()) })];
    for (const automation of deps.automations()) {
      const projects = enabledProjects(automation.key);
      const board = resolveAutopilot(chainFor(repos.autopilotSettings.all(), automation.key, null));
      if (projects.length === 0 && !board.enabled) continue;
      const parsed = parseConfig(automation, board.config);
      let planned: { flagged: number; unflagged: { id: string; number: number }[] } | undefined;
      if (automation.key === AUTOPILOT_START_PLANNED && deps.plannedTasks) {
        const ready = deps
          .plannedTasks(projects)
          .filter(
            (t) =>
              t.kind !== "epic" &&
              !t.manual &&
              t.archivedAt === null &&
              t.status === "planned" &&
              t.progress.total > 0 &&
              !t.blocked,
          );
        planned = {
          flagged: ready.filter((t) => t.autopilot === true).length,
          unflagged: ready.filter((t) => t.autopilot === null).map((t) => ({ id: t.id, number: t.number })),
        };
      }
      const thisWeek = week(automation.key);
      const changedAt = settingChangedAt(automation.key);
      const runsSinceConfigChange = repos.autopilotRuns
        .automationSince(automation.key, changedAt && changedAt > thisWeek.since ? changedAt : thisWeek.since)
        .filter((r) => !r.dryRun && r.status !== "skipped").length;
      all.push(
        ...automationHints({
          automation,
          week: thisWeek,
          runsSinceConfigChange,
          boardConfig: parsed.success ? parsed.data : automation.defaults,
          planned,
        }),
      );
    }
    return all.filter((h) => !dismissed.has(h.id));
  };

  const autoPaused = (): AutopilotAutoPause[] =>
    repos.autopilotAutoPauses.paused().flatMap((p) => {
      const project = repos.projects.get(p.projectId);
      if (!project || !find(p.automation)) return [];
      return [
        {
          automation: p.automation,
          projectId: p.projectId,
          projectTitle: project.title,
          reason: p.reason ?? "",
          pausedAt: p.pausedAt!,
        },
      ];
    });

  /**
   * After a real run in a project fails: when it is the automation's AUTOPILOT_AUTO_PAUSE_FAILURES-th failure there in
   * a row (since it was last resumed), pauses the automation in that project and tells the user.
   */
  const autoPauseAfter = (run: AutopilotRun) => {
    if (run.dryRun || !run.projectId) return;
    const current = repos.autopilotAutoPauses.get(run.automation, run.projectId);
    if (current?.pausedAt) return;
    const streak = failureStreak(
      repos.autopilotRuns.finishedInProject(run.automation, run.projectId, current?.countedFrom ?? null, 20),
    );
    if (streak.count < AUTOPILOT_AUTO_PAUSE_FAILURES) return;
    const project = repos.projects.get(run.projectId);
    if (!project) return;
    const at = nowIso();
    const reason = autoPauseReason(streak.count, streak.last);
    const title = titleOf(run.automation);
    core.write((fx) => {
      repos.autopilotAutoPauses.pause(run.automation, run.projectId!, at, reason);
      fx.autopilot();
    });
    deps.notifications.notify({
      kind: "autopilot_failed",
      taskId: null,
      title: `${title} paused in ${project.title}`,
      body: `${reason}\nIt stays paused there until you resume it in Settings → Autopilot.`,
      dedupeKey: `autopilot-paused:${run.automation}:${run.projectId}:${at}`,
    });
  };

  return {
    overview: () => {
      const engine = loadAutopilotEngine(repos);
      const automations = deps
        .automations()
        .map((automation) =>
          describeAutomation(automation, needsOf(automation), defaultsOf(automation, engine.agentDefaults)),
        );
      const agents = deps
        .automations()
        .filter((a) => a.needsAgent)
        .map((a) => a.key);
      const { started, spendUsd } = usage(agents, startOfDay(core.now()));
      return {
        paused: loadAutopilotStatus(repos).paused,
        engine,
        automations,
        today: { agentRuns: started, spendUsd },
        needsYou: needsYou(automations),
        autoPaused: autoPaused(),
        hints: hints({ agentRuns: started, spendUsd }),
        lastRuns: repos.autopilotRuns.latestFinished(),
        previewRuns: repos.autopilotRuns.dryRunCountsSince(
          new Date(core.now().getTime() - PREVIEW_WINDOW_MS).toISOString(),
        ),
      };
    },
    status: () => loadAutopilotStatus(repos),
    automations: () => deps.automations(),
    engine: () => loadAutopilotEngine(repos),
    updateEngine(input) {
      const current = loadAutopilotEngine(repos);
      const next = AutopilotEngineSettings.safeParse({
        ...current,
        ...input,
        quietHours: { ...current.quietHours, ...input.quietHours },
        agentDefaults: { ...current.agentDefaults, ...input.agentDefaults },
      });
      if (!next.success) throw new AppError("VALIDATION", "Invalid Autopilot settings", next.error.issues);
      core.write((fx) => {
        repos.settings.set(AUTOPILOT_ENGINE_KEY, next.data);
        fx.autopilot();
      });
      return next.data;
    },
    setPaused(paused) {
      const wasPaused = loadAutopilotStatus(repos).paused;
      core.write((fx) => {
        repos.settings.set(AUTOPILOT_PAUSED_KEY, paused);
        fx.autopilot();
      });
      if (wasPaused && !paused) {
        for (const a of deps.automations()) {
          deps.onEnabled?.(a.key, enabledProjects(a.key));
          const epics = [...epicStates(a, epicsWithOwnSetting(a))].filter(([, state]) => state.on).map(([id]) => id);
          if (epics.length > 0) deps.onEpicEnabled?.(a.key, epics);
        }
      }
      return loadAutopilotStatus(repos);
    },
    scope(kind, id, projectId) {
      return entries(kind, checkScope(kind, id, projectId), projectId);
    },
    modes() {
      return repos.autopilotSettings
        .all()
        .filter((s) => s.mode !== "inherit")
        .map((s) => ({ scopeKind: s.scopeKind, scopeId: s.scopeId, automation: s.automation, mode: s.mode }));
    },
    setScope(kind, id, key, input, projectId) {
      const scopeId = checkScope(kind, id, projectId);
      const automation = automationOf(key);
      if (kind === "epic" && !epicScoped(automation)) {
        throw new AppError("VALIDATION", `${automation.title} doesn't apply to epics`);
      }
      if (automation.alwaysOn) throw new AppError("VALIDATION", `${automation.title} has no switch: its rules do`);
      if (input.mode && isOnMode(input.mode) && automation.blocked) {
        throw new AppError("VALIDATION", automation.blocked);
      }
      const own = repos.autopilotSettings.forScope(kind, scopeId).find((s) => s.automation === key);
      const mode = input.mode ?? own?.mode ?? "inherit";
      // Kept through Off and Inherit, so the switch can bring back the mode it was last on in.
      const lastOnMode = isOnMode(mode) ? mode : (own?.lastOnMode ?? null);
      const known = new Set(automation.fields.map((f) => f.key));
      const stored = own?.config ?? {};
      // A key the automation has since dropped (Unstick's `nudge`) may still be in the stored row, and the forms send
      // the whole config back. It is tolerated, and gone from what is saved; a key never stored is still an error.
      const unknown = Object.keys(input.config ?? {}).find((k) => !known.has(k) && !Object.hasOwn(stored, k));
      if (unknown) throw new AppError("VALIDATION", `${automation.title} has no setting ${unknown}`);
      const config = Object.fromEntries(Object.entries(input.config ?? stored).filter(([k]) => known.has(k)));
      const parsed = parseConfig(automation, config);
      if (!parsed.success) {
        throw new AppError("VALIDATION", `Invalid settings for ${automation.title}`, parsed.error.issues);
      }
      const before = new Set(enabledProjects(key));
      const liveBefore = new Set(enabledProjects(key, true));
      // Epics with their own setting follow it rather than the project, so their switching on is tracked apart.
      const ownBefore = new Set(epicsWithOwnSetting(automation));
      const watched = new Set([...ownBefore, ...(kind === "epic" && scopeId ? [scopeId] : [])]);
      const epicsBefore = epicStates(automation, watched);
      core.write((fx) => {
        if (mode === "inherit" && Object.keys(config).length === 0 && lastOnMode === null) {
          repos.autopilotSettings.delete(kind, scopeId, key);
        } else {
          repos.autopilotSettings.upsert({
            scopeKind: kind,
            scopeId,
            automation: key,
            mode,
            config,
            lastOnMode,
            updatedAt: nowIso(),
          });
        }
        fx.autopilot();
      });
      const enabledNow = new Set(enabledProjects(key));
      // Run now requests where the automation just went off are dropped, not kept for when it's back on.
      for (const wasOn of before) if (!enabledNow.has(wasOn)) requests.delete(requestKey(key, wasOn));
      // Going from Preview to On starts it too: what Preview only recorded isn't caught up on.
      const liveNow = new Set(enabledProjects(key, true));
      const started = [...enabledNow].filter(
        (enabledId) => !before.has(enabledId) || (liveNow.has(enabledId) && !liveBefore.has(enabledId)),
      );
      if (started.length > 0) deps.onEnabled?.(key, started);
      const gainedOwn = epicsWithOwnSetting(automation).filter((epicId) => !ownBefore.has(epicId));
      if (gainedOwn.length > 0) deps.onEpicOwnSetting?.(key, gainedOwn);
      const epicsStarted = [...epicStates(automation, watched)]
        .filter(([epicId, now]) => {
          const was = epicsBefore.get(epicId);
          return (now.on && !was?.on) || (now.live && !was?.live);
        })
        .map(([epicId]) => epicId);
      if (epicsStarted.length > 0) deps.onEpicEnabled?.(key, epicsStarted);
      return entries(kind, scopeId, projectId);
    },
    resolve(automation, projectId, epicId = null) {
      const epic = epicScoped(automation) && countsAsScope(epicId, projectId) ? epicId : null;
      const resolved = resolveAutopilot(chainFor(repos.autopilotSettings.all(), automation.key, projectId, epic));
      const parsed = parseConfig(automation, resolved.config);
      return {
        enabled: automation.alwaysOn ? true : resolved.enabled,
        preview: automation.alwaysOn ? false : resolved.preview,
        config: parsed.success ? parsed.data : null,
      };
    },
    epicsWithOwnSetting: (automation) => new Set(epicsWithOwnSetting(automation)),
    projectsWithEpicOn(automation, live = false) {
      const projects = new Set<string>();
      if (!epicScoped(automation)) return projects;
      for (const s of repos.autopilotSettings.all()) {
        if (s.scopeKind !== "epic" || s.automation !== automation.key) continue;
        if (!(live ? s.mode === "on" : isOnMode(s.mode))) continue;
        const epic = repos.tasks.get(s.scopeId!);
        if (epic && countsAsScope(epic.id, epic.projectId)) projects.add(epic.projectId);
      }
      return projects;
    },
    runsForTask: (taskId, limit = RUN_LIMIT) => repos.autopilotRuns.forTask(taskId, limit),
    runsForProject: (projectId, limit = RUN_LIMIT) => repos.autopilotRuns.forProject(projectId, limit),
    automationRunsForProject: (automation, projectId, limit = RUN_LIMIT) =>
      repos.autopilotRuns.forProjectAutomation(projectId, automation, limit),
    week(key) {
      automationOf(key);
      return week(key);
    },
    dismissHint(id) {
      const kept = dismissedHints().filter((d) => d !== id);
      core.write((fx) => {
        repos.settings.set(AUTOPILOT_DISMISSED_HINTS_KEY, [...kept, id].slice(-DISMISSED_HINTS_MAX));
        fx.autopilot();
      });
    },
    isAutoPaused: (automation, projectId) => !!repos.autopilotAutoPauses.get(automation, projectId)?.pausedAt,
    resumeAutoPause(automation, projectId) {
      if (!repos.projects.get(projectId)) throw new AppError("NOT_FOUND", `Project ${projectId} not found`);
      if (!repos.autopilotAutoPauses.get(automation, projectId)?.pausedAt) {
        throw new AppError("CONFLICT", `${titleOf(automation)} isn't paused in this project`);
      }
      core.write((fx) => {
        repos.autopilotAutoPauses.resume(automation, projectId, nowIso());
        deps.notifications.resolve({ keyPrefix: `autopilot-paused:${automation}:${projectId}:` });
        fx.autopilot();
      });
      // Like lifting Pause all: what keeps its own schedule doesn't catch up on what passed while paused.
      deps.onEnabled?.(automation, [projectId]);
    },
    history({ cursor, limit = RUN_PAGE_DEFAULT, ...filter }) {
      const page = repos.autopilotRuns.history(filter, cursor, limit);
      if (page === "invalid") throw new AppError("VALIDATION", "Invalid cursor");
      return page;
    },
    deleteRuns({ ids, filter, preview = false }) {
      const weigh = (): { deletable: string[]; kept: Map<AutopilotKeptReason, number> } => {
        const asked = ids ?? repos.autopilotRuns.idsMatching(filter!);
        const now = Date.now();
        const deletable: string[] = [];
        const kept = new Map<AutopilotKeptReason, number>();
        for (const facts of repos.autopilotRuns.deleteFacts(asked)) {
          const reason = keptReason(facts, now);
          if (reason) kept.set(reason, (kept.get(reason) ?? 0) + 1);
          else deletable.push(facts.id);
        }
        return { deletable, kept };
      };
      const result = ({ kept }: ReturnType<typeof weigh>, deleted: number): DeleteAutopilotRunsResult => ({
        preview,
        deleted,
        kept: [...kept.values()].reduce((sum, n) => sum + n, 0),
        keptReasons: AutopilotKeptReason.options.flatMap((reason) =>
          kept.has(reason) ? [{ reason, count: kept.get(reason)! }] : [],
        ),
      });
      if (preview) {
        const weighed = weigh();
        return result(weighed, weighed.deletable.length);
      }
      // Weighed inside the write, so a run that starts between the preview and the confirm is still kept.
      return core.write((fx) => {
        const weighed = weigh();
        const deleted = repos.autopilotRuns.deleteIds(weighed.deletable);
        if (deleted > 0) fx.autopilot();
        return result(weighed, deleted);
      });
    },
    hasRun: (automation, dedupeKey, dryRun) => repos.autopilotRuns.exists(automation, dedupeKey, dryRun),
    lastHandover(automation, projectId) {
      const parsed = ScheduledAgentRunOutput.safeParse(
        repos.autopilotRuns.lastScheduledAnswer(automation, projectId)?.output,
      );
      return parsed.success && parsed.data.handover ? capHandover(parsed.data.handover) : null;
    },
    runForSession: (sessionId) => repos.autopilotRuns.forSession(sessionId),
    settingChangedAt,
    finishedWithWorktree: () => repos.autopilotRuns.finishedWithWorktree(),
    usage,
    record({ automation, candidate, dryRun }) {
      const at = nowIso();
      const run: AutopilotRun = {
        id: randomUUID(),
        automation,
        taskId: candidate.taskId ?? null,
        projectId: candidate.projectId ?? null,
        dedupeKey: candidate.dedupeKey,
        status: dryRun ? "skipped" : "queued",
        summary: dryRun ? `Would ${candidate.summary}` : candidate.summary,
        dryRun,
        runner: null,
        sessionId: null,
        threadUrl: null,
        worktreePath: null,
        costUsd: null,
        detail: dryRun ? (candidate.preview ?? null) : null,
        exitCode: null,
        error: null,
        deferred: null,
        needsAttention: false,
        dismissedAt: null,
        output: null,
        model: null,
        createdAt: at,
        startedAt: null,
        finishedAt: dryRun ? at : null,
        updatedAt: at,
      };
      return core.write((fx) => {
        if (repos.autopilotRuns.exists(automation, candidate.dedupeKey, dryRun)) return null;
        repos.autopilotRuns.insert(run);
        if (dryRun) logRun(fx, run);
        fx.autopilot();
        return run;
      });
    },
    retry(runId, actor) {
      const run = runOf(runId);
      if (run.dryRun) throw new AppError("VALIDATION", "A dry run did nothing, so there is nothing to retry");
      if (isRetried(run.dedupeKey)) throw new AppError("CONFLICT", "This run has already been retried");
      if (run.status !== "failed" && run.status !== "skipped") {
        throw new AppError(
          "CONFLICT",
          run.status === "succeeded" ? "This run succeeded, so there is nothing to retry" : "This run is still going",
        );
      }
      if (isSupersededRun(run, runsAround(run))) {
        throw new AppError("CONFLICT", "The automation has run again since, so this run's work is history");
      }
      const retired: AutopilotRun = {
        ...run,
        dedupeKey: retiredKey(run),
        needsAttention: false,
        updatedAt: nowIso(),
      };
      core.write((fx) => {
        repos.autopilotRuns.update(retired);
        if (run.taskId) {
          fx.log(run.taskId, actor, "autopilot_run", {
            automation: run.automation,
            title: titleOf(run.automation),
            status: "retried",
            summary: run.summary,
          });
        }
        fx.autopilot();
      });
      return retired;
    },
    dismiss(runId, actor) {
      const run = runOf(runId);
      // Dismissing twice (a second tab, a double click) already did what was asked.
      if (run.dismissedAt) return run;
      if (!run.taskId || !run.needsAttention) throw new AppError("CONFLICT", "This run isn't flagged for attention");
      if (!repos.autopilotRuns.attentionFor([run.taskId]).has(run.taskId)) {
        throw new AppError("CONFLICT", "This run's flag no longer stands, so there is nothing to dismiss");
      }
      const at = nowIso();
      core.write((fx) => {
        repos.autopilotRuns.dismissFlagged(run.taskId!, at);
        fx.log(run.taskId!, actor, "autopilot_run", {
          automation: run.automation,
          title: titleOf(run.automation),
          status: "dismissed",
          summary: run.summary,
        });
        fx.autopilot();
      });
      return runOf(runId);
    },
    start(runId) {
      const run = runOf(runId);
      if (run.status !== "queued") throw new AppError("CONFLICT", `Run ${runId} is ${run.status}, not queued`);
      const at = nowIso();
      return save({ ...run, status: "running", startedAt: at, updatedAt: at }, { log: true });
    },
    update(runId, patch) {
      return save({ ...runOf(runId), ...patch, updatedAt: nowIso() });
    },
    finish(runId, result) {
      const run = runOf(runId);
      const { status = "succeeded", summary, error, needsAttention, ...patch } = result;
      const at = nowIso();
      const finished = save(
        {
          ...run,
          ...patch,
          status,
          summary: summary ?? run.summary,
          error: error ?? null,
          needsAttention: needsAttention ?? false,
          finishedAt: at,
          updatedAt: at,
        },
        { log: true },
      );
      if (finished.status === "failed") autoPauseAfter(finished);
      return finished;
    },
    recover() {
      const stranded = repos.autopilotRuns.withStatus(AUTOPILOT_ACTIVE_STATUSES);
      if (stranded.length === 0) return 0;
      const strandedIds = new Set(stranded.map((r) => r.id));
      core.write((fx) => {
        const at = nowIso();
        for (const run of stranded) {
          const error = `${BOARD_RESTARTED_ERROR} while this run was going`;
          // Only the PR automations are handed back (their keys follow the PR's head, so the engine re-checks that
          // the work is still needed; a Fix PRs run killed after its agent pushed may leave a second session to push
          // again, within its attempt cap). An agent launch (Start planned, Orchestrate) may have started something
          // nothing re-checks, so it is flagged for the user.
          // The key is retired as by `retry`, unless this work was cut short before: a run that itself restarts the
          // board must not loop. Runs stranded together don't make each other history.
          if (
            RETRIED_AFTER_RESTART.has(run.automation) &&
            !run.dryRun &&
            !isSupersededRun(
              run,
              runsAround(run).filter((o) => o.id === run.id || !strandedIds.has(o.id)),
            ) &&
            !restartedBefore(run)
          ) {
            repos.autopilotRuns.update({
              ...run,
              status: "failed",
              error,
              dedupeKey: retiredKey(run),
              needsAttention: false,
              finishedAt: at,
              updatedAt: at,
            });
            if (run.taskId) {
              fx.log(run.taskId, AUTOPILOT_ACTOR, "autopilot_run", {
                automation: run.automation,
                title: titleOf(run.automation),
                status: "retried",
                reason: "restart",
                summary: run.summary,
              });
            }
            continue;
          }
          const failed: AutopilotRun = {
            ...run,
            status: "failed",
            error,
            needsAttention: run.taskId !== null,
            finishedAt: at,
            updatedAt: at,
          };
          repos.autopilotRuns.update(failed);
          logRun(fx, failed);
          notifyEnded(failed);
        }
        fx.autopilot();
      });
      return stranded.length;
    },
    requestRun(automation, projectId) {
      const key = requestKey(automation, projectId);
      const waiting = runRequest(automation, projectId);
      if (waiting) return waiting;
      const at = nowIso();
      requests.set(key, at);
      core.write((fx) => fx.autopilot());
      return at;
    },
    runRequest,
    clearRunRequest(automation, projectId) {
      requests.delete(requestKey(automation, projectId));
    },
  };
}
