import { AUTOPILOT_ACTOR, inQuietHours, type AutopilotEngineSettings, type AutopilotRun } from "@repo/contracts";
import type { EventBus } from "../bus.ts";
import { messageOf } from "../integrations/github.ts";
import type { Logger } from "../integrations/util.ts";
import type { Services } from "../services/types.ts";
import {
  NO_RUNNER,
  type Automation,
  type AutomationConfig,
  type Candidate,
  type Runner,
  type RunPatch,
} from "./types.ts";

export const AUTOPILOT_TICK_MS = 60_000;
/** Board events come in bursts (a move publishes several); one pass after the burst is enough. */
export const AUTOPILOT_DEBOUNCE_MS = 1_000;

const IGNORED_EVENTS: ReadonlySet<string> = new Set([
  "task.detail_changed",
  "labels.colors_changed",
  "notification.created",
  "notifications.changed",
]);

export interface AutopilotEngine {
  /** One pass over every automation; resolves when the pass is done (agent runs it started may still be going). */
  pass(): Promise<void>;
  /** Resolves when no pass and no action is in flight. */
  idle(): Promise<void>;
  start(): void;
  /** Stops new passes; actions already going finish. */
  stop(): void;
}

/** Local midnight of `now`, for the daily caps. */
const startOfDay = (now: Date): string => new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

/**
 * Runs the Autopilot automations (docs/features/autopilot.md): after board events and every minute, each automation
 * that is on somewhere checks the board, and each candidate that has no run for its dedupe key yet is recorded and
 * acted on, within pause, quiet hours, the concurrency cap and the daily caps.
 */
export function createAutopilotEngine(deps: {
  services: () => Services;
  bus: EventBus;
  runner?: Runner;
  now?: () => Date;
  debounceMs?: number;
  tickMs?: number;
  log?: Logger;
}): AutopilotEngine {
  const runner = deps.runner ?? NO_RUNNER;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console;
  const inFlight = new Set<Promise<void>>();
  let passing: Promise<void> | null = null;
  let again = false;
  let own = 0;
  let timer: NodeJS.Timeout | null = null;
  let debounce: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;

  /**
   * Runs one of the engine's own writes. Events published meanwhile are its own and start no pass: dedupe keys
   * already stop an action's change from acting again, this only saves the pass.
   */
  const self = <T>(fn: () => T): T => {
    own += 1;
    try {
      return fn();
    } finally {
      own -= 1;
    }
  };

  const schedule = () => {
    if (!unsubscribe) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void pass();
    }, deps.debounceMs ?? AUTOPILOT_DEBOUNCE_MS);
  };

  /** Why an agent run can't start now, or null when it can. */
  const held = (s: Services, engine: AutopilotEngineSettings, at: Date): string | null => {
    if (inQuietHours(engine.quietHours, at.getHours() * 60 + at.getMinutes())) return "quiet hours";
    const agents = s.autopilot
      .automations()
      .filter((a) => a.needsAgent)
      .map((a) => a.key);
    const usage = s.autopilot.usage(agents, startOfDay(at));
    if (usage.active >= engine.maxConcurrent) return "concurrency";
    if (engine.dailyRunCap !== null && usage.started >= engine.dailyRunCap) return "daily run cap";
    if (engine.dailySpendCapUsd !== null && usage.spendUsd >= engine.dailySpendCapUsd) return "daily spend cap";
    return null;
  };

  const act = async (automation: Automation, run: AutopilotRun, candidate: Candidate, config: AutomationConfig) => {
    const s = deps.services();
    try {
      const started = self(() => s.autopilot.start(run.id));
      const update = (patch: RunPatch) => {
        self(() => s.autopilot.update(run.id, patch));
      };
      // The action's synchronous part counts as the engine's own write; changes it makes after an await don't.
      const result = await self(() =>
        automation.act(candidate, {
          services: s,
          runner: { start: (request) => runner.start(request, update) },
          engine: s.autopilot.engine(),
          config,
          run: started,
          actor: AUTOPILOT_ACTOR,
          update,
        }),
      );
      self(() => s.autopilot.finish(run.id, result));
    } catch (error) {
      try {
        self(() =>
          s.autopilot.finish(run.id, {
            status: "failed",
            error: messageOf(error),
            needsAttention: run.taskId !== null,
          }),
        );
      } catch (finishError) {
        // The run went with its task (deleted meanwhile); nothing is left to record it on.
        log.warn(`[autopilot] couldn't record ${automation.key} failing: ${messageOf(finishError)}`);
      }
    }
  };

  /** Starts the action without waiting for it; agent runs are long. */
  const launch = (automation: Automation, run: AutopilotRun, candidate: Candidate, config: AutomationConfig) => {
    const done = act(automation, run, candidate, config).finally(() => {
      inFlight.delete(done);
      // A finished agent run frees a slot that held candidates are waiting for.
      if (automation.needsAgent) schedule();
    });
    inFlight.add(done);
    return done;
  };

  const runAutomation = async (s: Services, automation: Automation, engine: AutopilotEngineSettings, at: Date) => {
    const board = s.autopilot.resolve(automation, null);
    const projects = s.projects
      .list()
      .map((project) => ({ project, resolved: s.autopilot.resolve(automation, project.id) }))
      .flatMap(({ project, resolved }) =>
        resolved.enabled && resolved.config ? [{ project, config: resolved.config }] : [],
      );
    const boardConfig = board.enabled ? board.config : null;
    if (projects.length === 0 && !boardConfig) return;

    const candidates = await automation.check({ services: s, engine, now: at, projects, board: boardConfig });
    for (const found of candidates) {
      let candidate = found;
      // A task's run belongs to the task's project, whatever the check said, so that project's switch applies.
      if (candidate.taskId) {
        let projectId: string;
        try {
          projectId = s.tasks.summary(candidate.taskId).projectId;
        } catch {
          continue;
        }
        candidate = { ...candidate, projectId };
      }
      const projectId = candidate.projectId ?? null;
      // Only where the automation is on: a check may return more than it was asked for.
      const config = projectId ? projects.find((p) => p.project.id === projectId)?.config : boardConfig;
      if (!config) continue;
      if (s.autopilot.status().paused) return;
      if (engine.dryRun) {
        if (!s.autopilot.hasRun(automation.key, candidate.dedupeKey, true)) {
          self(() => s.autopilot.record({ automation: automation.key, candidate, dryRun: true }));
        }
        continue;
      }
      if (s.autopilot.hasRun(automation.key, candidate.dedupeKey, false)) continue;
      // Held candidates aren't recorded: a later pass picks them up once there is room.
      if (automation.needsAgent && held(s, engine, at)) continue;
      const run = self(() => s.autopilot.record({ automation: automation.key, candidate, dryRun: false }));
      if (!run) continue;
      const done = launch(automation, run, candidate, config);
      // Quick board changes run one after another; agent runs and shell commands go on in the background.
      if (!automation.needsAgent && !automation.background) await done;
    }
  };

  const runPass = async (): Promise<void> => {
    const s = deps.services();
    if (s.autopilot.status().paused) return;
    const engine = s.autopilot.engine();
    const at = now();
    for (const automation of s.autopilot.automations()) {
      await runAutomation(s, automation, engine, at).catch((error: unknown) => {
        log.warn(`[autopilot] ${automation.key} failed: ${messageOf(error)}`);
      });
    }
  };

  const pass = (): Promise<void> => {
    if (passing) {
      // The board changed mid-pass; look again once it's done.
      again = true;
      return passing;
    }
    // Cleared in .finally, as in reviewFallbacks: a pass with nothing to await settles synchronously.
    passing = runPass().finally(() => {
      passing = null;
      if (again) {
        again = false;
        schedule();
      }
    });
    return passing;
  };

  return {
    pass,
    async idle() {
      for (;;) {
        const pending = [passing, ...inFlight].filter((p) => p !== null);
        if (pending.length === 0) return;
        await Promise.all(pending);
      }
    },
    start() {
      if (unsubscribe) return;
      unsubscribe = deps.bus.subscribe((event) => {
        // Notifications are the board telling the user something, not a change an automation could act on.
        if (own > 0 || IGNORED_EVENTS.has(event.type)) return;
        schedule();
      });
      timer = setInterval(() => void pass(), deps.tickMs ?? AUTOPILOT_TICK_MS);
      schedule();
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
      if (timer) clearInterval(timer);
      if (debounce) clearTimeout(debounce);
      timer = null;
      debounce = null;
    },
  };
}
