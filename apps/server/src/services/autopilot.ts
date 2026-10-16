import { randomUUID } from "node:crypto";
import {
  AUTOPILOT_ACTIVE_STATUSES,
  AUTOPILOT_ACTOR,
  AutopilotEngineSettings,
  DEFAULT_AUTOPILOT_ENGINE,
  resolveAutopilot,
  type AutopilotAutomation,
  type AutopilotOverview,
  type AutopilotRun,
  type AutopilotScopeEntry,
  type AutopilotScopeKind,
  type AutopilotSetting,
  type AutopilotStatus,
  type UpdateAutopilotEngineInput,
  type UpdateAutopilotSettingInput,
} from "@repo/contracts";
import type { ActionResult, Automation, AutomationConfig, Candidate, RunPatch } from "../autopilot/types.ts";
import { nowIso } from "../db/database.ts";
import type { Repos } from "../db/repos/index.ts";
import { AppError } from "../errors.ts";
import type { Core, Effects } from "./core.ts";
import type { NotificationsService } from "./notifications.ts";

/** Settings-table keys for the engine. Only the settings are exported in backups; pause stays with the machine. */
export const AUTOPILOT_ENGINE_KEY = "autopilotEngine";
export const AUTOPILOT_PAUSED_KEY = "autopilotPaused";

/** The engine settings stored, over the defaults; a value that no longer parses falls back to them. */
export function loadAutopilotEngine(repos: Repos): AutopilotEngineSettings {
  const stored = repos.settings.all().get(AUTOPILOT_ENGINE_KEY);
  const parsed = AutopilotEngineSettings.safeParse({
    ...DEFAULT_AUTOPILOT_ENGINE,
    ...(typeof stored === "object" ? stored : {}),
  });
  return parsed.success ? parsed.data : DEFAULT_AUTOPILOT_ENGINE;
}

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
        epicId: (taskId && repos.tasks.get(taskId)?.parentId) || null,
      })),
  };
}

export const describeAutomation = (a: Automation): AutopilotAutomation => ({
  key: a.key,
  title: a.title,
  description: a.description,
  needsAgent: a.needsAgent,
  epicScope: a.epicScope ?? true,
  fields: a.fields,
  defaults: a.defaults,
});

/** An automation's effective state for one project (or the board, with null). */
export interface ResolvedAutomation {
  enabled: boolean;
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
  /** Projects with an epic, not archived, that switches the automation on: the engine must look there even when the project is off. */
  projectsWithEpicOn(automation: Automation): ReadonlySet<string>;
  /** Epics with a setting of their own for the automation: their tasks follow the epic, not the project. */
  epicsWithOwnSetting(automation: Pick<Automation, "key" | "epicScope">): ReadonlySet<string>;
  /** Newest first. */
  runsForTask(taskId: string, limit?: number): AutopilotRun[];
  /** Newest first. */
  runsForProject(projectId: string, limit?: number): AutopilotRun[];
  hasRun(automation: string, dedupeKey: string, dryRun: boolean): boolean;
  /** When the board's setting for an automation (its switch or config) last changed; null when it has none. */
  settingChangedAt(automation: string): string | null;
  /** Finished headless runs that made a worktree, oldest first. */
  finishedWithWorktree(): AutopilotRun[];
  /** Real agent runs started and spend since `since`, and agent runs going now. */
  usage(agentAutomations: readonly string[], since: string): { started: number; spendUsd: number; active: number };
  /**
   * Records a candidate as a run: queued, or skipped with "Would …" in dry-run. Null when the dedupe key already
   * has one (another pass got there first).
   */
  record(input: RecordRunInput): AutopilotRun | null;
  /** queued → running. */
  start(runId: string): AutopilotRun;
  /** Runner details on a run in flight. */
  update(runId: string, patch: RunPatch): AutopilotRun;
  /** Ends a run with the action's result, logging it on the task. */
  finish(runId: string, result: ActionResult): AutopilotRun;
  /** Fails and flags the runs a restart left queued or running. Returns how many. */
  recover(): number;
}

const RUN_LIMIT = 50;

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
  },
): AutopilotService {
  const { repos } = core;
  const find = (key: string) => deps.automations().find((a) => a.key === key);
  const titleOf = (key: string) => find(key)?.title ?? key;

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

  const parseConfig = (automation: Automation, config: AutomationConfig) =>
    automation.schema.safeParse({ ...automation.defaults, ...config });

  const entries = (kind: AutopilotScopeKind, id: string | null, projectId?: string): AutopilotScopeEntry[] => {
    const all = repos.autopilotSettings.all();
    return deps
      .automations()
      .filter((automation) => kind !== "epic" || epicScoped(automation))
      .map((automation) => {
        const own = all.find((s) => s.scopeKind === kind && s.scopeId === id && s.automation === automation.key);
        const resolved = resolveAutopilot(
          chainFor(all, automation.key, kind === "board" ? null : (projectId ?? id), kind === "epic" ? id : null),
        );
        const parsed = parseConfig(automation, resolved.config);
        return {
          automation: automation.key,
          mode: own?.mode ?? "inherit",
          config: own?.config ?? {},
          enabled: resolved.enabled,
          source: resolved.source,
          effectiveConfig: parsed.success ? parsed.data : { ...automation.defaults, ...resolved.config },
        };
      });
  };

  /** Epics with a setting of their own for the automation (any mode), that count as a scope. */
  const epicsWithOwnSetting = (automation: Pick<Automation, "key" | "epicScope">): string[] => {
    if (!epicScoped(automation)) return [];
    return repos.autopilotSettings
      .all()
      .filter((s) => s.scopeKind === "epic" && s.automation === automation.key)
      .map((s) => repos.tasks.get(s.scopeId!))
      .filter((epic) => epic && countsAsScope(epic.id, epic.projectId))
      .map((epic) => epic!.id);
  };

  /** Whether the automation is on for each of these epics' tasks, as the engine resolves it. */
  const epicStates = (automation: Automation, epicIds: Iterable<string>): Map<string, boolean> => {
    const all = repos.autopilotSettings.all();
    const states = new Map<string, boolean>();
    for (const epicId of epicIds) {
      const epic = repos.tasks.get(epicId);
      if (!epic || !countsAsScope(epic.id, epic.projectId)) continue;
      states.set(epicId, resolveAutopilot(chainFor(all, automation.key, epic.projectId, epic.id)).enabled);
    }
    return states;
  };

  /** The projects an automation is on for, with the board's setting and any project's own taken into account. */
  const enabledProjects = (key: string): string[] => {
    const all = repos.autopilotSettings.all();
    return repos.projects
      .list()
      .filter((p) => resolveAutopilot(chainFor(all, key, p.id)).enabled)
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

  return {
    overview: () => ({
      paused: loadAutopilotStatus(repos).paused,
      engine: loadAutopilotEngine(repos),
      automations: deps.automations().map(describeAutomation),
    }),
    status: () => loadAutopilotStatus(repos),
    automations: () => deps.automations(),
    engine: () => loadAutopilotEngine(repos),
    updateEngine(input) {
      const current = loadAutopilotEngine(repos);
      const next = AutopilotEngineSettings.safeParse({
        ...current,
        ...input,
        quietHours: { ...current.quietHours, ...input.quietHours },
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
          const epics = [...epicStates(a, epicsWithOwnSetting(a))].filter(([, on]) => on).map(([id]) => id);
          if (epics.length > 0) deps.onEpicEnabled?.(a.key, epics);
        }
      }
      return loadAutopilotStatus(repos);
    },
    scope(kind, id, projectId) {
      return entries(kind, checkScope(kind, id, projectId), projectId);
    },
    setScope(kind, id, key, input, projectId) {
      const scopeId = checkScope(kind, id, projectId);
      const automation = automationOf(key);
      if (kind === "epic" && !epicScoped(automation)) {
        throw new AppError("VALIDATION", `${automation.title} doesn't apply to epics`);
      }
      const own = repos.autopilotSettings.forScope(kind, scopeId).find((s) => s.automation === key);
      const mode = input.mode ?? own?.mode ?? "inherit";
      const config = input.config ?? own?.config ?? {};
      const known = new Set(automation.fields.map((f) => f.key));
      const unknown = Object.keys(config).find((k) => !known.has(k));
      if (unknown) throw new AppError("VALIDATION", `${automation.title} has no setting ${unknown}`);
      const parsed = parseConfig(automation, config);
      if (!parsed.success) {
        throw new AppError("VALIDATION", `Invalid settings for ${automation.title}`, parsed.error.issues);
      }
      const before = new Set(enabledProjects(key));
      // Epics with their own setting follow it rather than the project, so their switching on is tracked apart.
      const ownBefore = new Set(epicsWithOwnSetting(automation));
      const watched = new Set([...ownBefore, ...(kind === "epic" && scopeId ? [scopeId] : [])]);
      const epicsBefore = epicStates(automation, watched);
      core.write((fx) => {
        if (mode === "inherit" && Object.keys(config).length === 0) {
          repos.autopilotSettings.delete(kind, scopeId, key);
        } else {
          repos.autopilotSettings.upsert({
            scopeKind: kind,
            scopeId,
            automation: key,
            mode,
            config,
            updatedAt: nowIso(),
          });
        }
        fx.autopilot();
      });
      const started = enabledProjects(key).filter((enabledId) => !before.has(enabledId));
      if (started.length > 0) deps.onEnabled?.(key, started);
      const gainedOwn = epicsWithOwnSetting(automation).filter((epicId) => !ownBefore.has(epicId));
      if (gainedOwn.length > 0) deps.onEpicOwnSetting?.(key, gainedOwn);
      const epicsStarted = [...epicStates(automation, watched)]
        .filter(([epicId, on]) => on && !epicsBefore.get(epicId))
        .map(([epicId]) => epicId);
      if (epicsStarted.length > 0) deps.onEpicEnabled?.(key, epicsStarted);
      return entries(kind, scopeId, projectId);
    },
    resolve(automation, projectId, epicId = null) {
      const epic = epicScoped(automation) && countsAsScope(epicId, projectId) ? epicId : null;
      const resolved = resolveAutopilot(chainFor(repos.autopilotSettings.all(), automation.key, projectId, epic));
      const parsed = parseConfig(automation, resolved.config);
      return { enabled: resolved.enabled, config: parsed.success ? parsed.data : null };
    },
    epicsWithOwnSetting: (automation) => new Set(epicsWithOwnSetting(automation)),
    projectsWithEpicOn(automation) {
      const projects = new Set<string>();
      if (!epicScoped(automation)) return projects;
      for (const s of repos.autopilotSettings.all()) {
        if (s.scopeKind !== "epic" || s.mode !== "on" || s.automation !== automation.key) continue;
        const epic = repos.tasks.get(s.scopeId!);
        if (epic && countsAsScope(epic.id, epic.projectId)) projects.add(epic.projectId);
      }
      return projects;
    },
    runsForTask: (taskId, limit = RUN_LIMIT) => repos.autopilotRuns.forTask(taskId, limit),
    runsForProject: (projectId, limit = RUN_LIMIT) => repos.autopilotRuns.forProject(projectId, limit),
    hasRun: (automation, dedupeKey, dryRun) => repos.autopilotRuns.exists(automation, dedupeKey, dryRun),
    settingChangedAt: (automation) =>
      repos.autopilotSettings.all().find((s) => s.scopeKind === "board" && s.automation === automation)?.updatedAt ??
      null,
    finishedWithWorktree: () => repos.autopilotRuns.finishedWithWorktree(),
    usage(agentAutomations, since) {
      const agents = new Set(agentAutomations);
      return {
        started: repos.autopilotRuns.startedSince(agentAutomations, since),
        spendUsd: repos.autopilotRuns.spendSince(since),
        active: repos.autopilotRuns
          .withStatus(AUTOPILOT_ACTIVE_STATUSES)
          .filter((r) => !r.dryRun && agents.has(r.automation)).length,
      };
    },
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
        needsAttention: false,
        output: null,
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
      return save(
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
    },
    recover() {
      const stranded = repos.autopilotRuns.withStatus(AUTOPILOT_ACTIVE_STATUSES);
      if (stranded.length === 0) return 0;
      core.write((fx) => {
        const at = nowIso();
        for (const run of stranded) {
          const failed: AutopilotRun = {
            ...run,
            status: "failed",
            error: "The board restarted while this run was going",
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
  };
}
