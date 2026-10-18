import {
  AUTOPILOT_ACTOR,
  AUTOPILOT_REVIEW_PRS,
  AUTOPILOT_UNSTICK,
  BOARD_RESTARTED_ERROR,
  UNSTICK_STALE_PREFIX,
  type AutopilotRunStatus,
  prReviewOutput,
  type FindingSeverity,
  type FindingStatus,
  type PrReviewRunOutput,
  type TaskEvent,
  type TaskStatus,
} from "@repo/contracts";
import type { Core } from "./core.ts";

/** The statuses a task waits in before Done, in column order. */
export const OPEN_STATUSES = ["backlog", "planned", "in_progress", "review"] as const satisfies readonly TaskStatus[];

/** One stretch a task spent in a status; `until` is null for the one it is still in. */
export interface StatusStay {
  status: TaskStatus;
  since: string;
  until: string | null;
}

/**
 * Where a task was and when, rebuilt from its moves (`status_changed` and `closed` events, oldest first). It started in
 * the status its first move left, or in `current` when it never moved; a close carries no `to` and means Done.
 */
export function statusStays(createdAt: string, moves: readonly TaskEvent[], current: TaskStatus): StatusStay[] {
  let status = moves[0] ? (moves[0].payload.from as TaskStatus) : current;
  let since = createdAt;
  const stays: StatusStay[] = [];
  for (const move of moves) {
    stays.push({ status, since, until: move.at });
    status = move.payload.to === undefined ? "done" : (move.payload.to as TaskStatus);
    since = move.at;
  }
  stays.push({ status, since, until: null });
  return stays;
}

export interface ActivityTask {
  number: number;
  title: string;
}

/** A task that reached Done in the window. */
export interface FinishedTask extends ActivityTask {
  finishedAt: string;
  /** Set when it was closed without being done here (duplicate, won't do, completed elsewhere). */
  resolution: string | null;
  /** Milliseconds spent in each status before it finished, whatever the window. */
  inStatus: Partial<Record<(typeof OPEN_STATUSES)[number], number>>;
  /** Local review rounds it had in all. */
  localRounds: number;
  /** Autopilot PR review rounds it had in all (the highest round number reached). */
  prRounds: number;
  stepsBlocked: number;
  stepsSkipped: number;
}

export interface LocalFinding extends ActivityTask {
  label: string;
  severity: FindingSeverity;
  status: FindingStatus;
  file: string | null;
  title: string;
}

export interface PrReviewActivity extends ActivityTask {
  round: number;
  maxRounds: number;
  counts: PrReviewRunOutput["counts"];
  fyi: number;
  handoff: PrReviewRunOutput["handoff"];
}

export interface RunFailure {
  task: ActivityTask | null;
  reason: string;
  /** The run was cut short by the board restarting, not by anything it did. */
  restarted: boolean;
}

/** One automation's real runs that finished in the window. */
export interface AutomationActivity {
  key: string;
  title: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** Runs that followed a failed run of the same automation on the same task in the window. */
  retries: number;
  /** Runs that ended by saying Autopilot gave up. */
  gaveUp: number;
  failures: RunFailure[];
}

export interface Stall extends ActivityTask {
  kind: "stale" | "waiting";
  at: string;
  text: string;
}

export interface NoteActivity extends ActivityTask {
  at: string;
  actor: string;
  text: string;
}

export interface BoardActivity {
  from: string;
  to: string;
  /** Null for the whole board. */
  project: { id: string; title: string } | null;
  finished: FinishedTask[];
  reviews: {
    rounds: { total: number; failed: number; stalled: number };
    local: LocalFinding[];
    pr: PrReviewActivity[];
  };
  runs: AutomationActivity[];
  stalls: Stall[];
  notes: NoteActivity[];
}

/** What happened on the board in a window, read from the activity log, reviews and Autopilot runs. */
export interface ActivityService {
  /** Everything in `[from, to)`, for one project or all of them. */
  between(from: Date, to: Date, projectId?: string): BoardActivity;
}

export function createActivityService(core: Core, deps: { automationTitle: (key: string) => string }): ActivityService {
  const { repos } = core;

  return {
    between(from, to, projectId) {
      const [start, end] = [from.toISOString(), to.toISOString()];
      const project = projectId ? repos.projects.get(projectId) : null;
      const projectOf = new Map<string, string>();
      const refs = new Map<string, ActivityTask>();
      /** The task's number and title, and whether it is in scope (its project, when one was asked for). */
      const taskRef = (taskId: string | null): ActivityTask | null => {
        if (!taskId) return null;
        let ref = refs.get(taskId);
        if (!ref) {
          const task = repos.tasks.get(taskId);
          if (!task) return null;
          ref = { number: task.number, title: task.title };
          refs.set(taskId, ref);
          projectOf.set(taskId, task.projectId);
        }
        return ref;
      };
      const inScope = (taskId: string | null, runProject?: string | null): boolean => {
        if (!projectId) return true;
        if (runProject) return runProject === projectId;
        if (!taskRef(taskId)) return false;
        return projectOf.get(taskId!) === projectId;
      };

      // Tasks finished: a move to Done, or a close. Epics follow their tasks, so they aren't work of their own.
      const lastFinish = new Map<string, { at: string; resolution: string | null }>();
      for (const e of repos.events.between(["status_changed", "closed"], start, end)) {
        if (projectId && e.projectId !== projectId) continue;
        if (e.type === "status_changed" && e.payload.to !== "done") continue;
        if (e.payload.fromChildren) continue;
        lastFinish.set(e.taskId, {
          at: e.at,
          resolution: e.type === "closed" && typeof e.payload.resolution === "string" ? e.payload.resolution : null,
        });
      }
      const finishedIds = [...lastFinish.keys()].filter((id) => repos.tasks.get(id)?.kind !== "epic");
      const history = repos.events.ofTypes(finishedIds, ["status_changed", "closed", "step_updated"]);
      const rounds = new Map<string, number>();
      for (const r of repos.reviews.forTasks(finishedIds)) rounds.set(r.taskId, (rounds.get(r.taskId) ?? 0) + 1);
      const finished: FinishedTask[] = [];
      for (const id of finishedIds) {
        const task = repos.tasks.get(id)!;
        const done = lastFinish.get(id)!;
        const mine = history.filter((e) => e.taskId === id && e.at <= done.at);
        const moves = mine.filter((e) => e.type !== "step_updated");
        const inStatus: FinishedTask["inStatus"] = {};
        for (const stay of statusStays(task.createdAt, moves, "backlog")) {
          const open = OPEN_STATUSES.find((s) => s === stay.status);
          if (open && stay.until) {
            inStatus[open] = (inStatus[open] ?? 0) + Math.max(0, Date.parse(stay.until) - Date.parse(stay.since));
          }
        }
        const steps = mine.filter((e) => e.type === "step_updated");
        const prRounds = repos.autopilotRuns
          .forTask(id, 200)
          .reduce((max, run) => Math.max(max, prReviewOutput(run)?.round ?? 0), 0);
        finished.push({
          number: task.number,
          title: task.title,
          finishedAt: done.at,
          resolution: done.resolution,
          inStatus,
          localRounds: rounds.get(id) ?? 0,
          prRounds,
          stepsBlocked: steps.filter((e) => e.payload.to === "blocked").length,
          stepsSkipped: steps.filter((e) => e.payload.to === "skipped").length,
        });
      }
      finished.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt) || a.number - b.number);

      // Local review rounds and the findings they raised.
      const localRounds = repos.reviews.roundsBetween(start, end).filter((r) => inScope(r.taskId));
      const local: LocalFinding[] = [];
      for (const f of repos.reviews.findingsBetween(start, end)) {
        const ref = inScope(f.taskId) ? taskRef(f.taskId) : null;
        if (!ref) continue;
        local.push({
          ...ref,
          label: `R${f.round}.${f.position}`,
          severity: f.severity,
          status: f.status,
          file: f.file,
          title: f.title,
        });
      }

      // Autopilot runs count in the period they finished in, so a long one that fails later is reported then.
      const byAutomation = new Map<string, AutomationActivity>();
      // The last status of each automation's run on a task: a run that follows a failed one is a retry. Review and fix
      // rounds run on a task again and again by design, and aren't.
      const lastOnTask = new Map<string, AutopilotRunStatus>();
      const pr: PrReviewActivity[] = [];
      const stalls = new Map<string, Stall>();
      const addStall = (stall: Stall & { taskId: string }) => {
        const key = `${stall.taskId}:${stall.kind}`;
        if (!stalls.has(key)) stalls.set(key, stall);
      };
      for (const run of repos.autopilotRuns.between(start, end, [])) {
        if (!inScope(run.taskId, run.projectId)) continue;
        const ref = taskRef(run.taskId);
        let group = byAutomation.get(run.automation);
        if (!group) {
          group = {
            key: run.automation,
            title: deps.automationTitle(run.automation),
            total: 0,
            succeeded: 0,
            failed: 0,
            skipped: 0,
            retries: 0,
            gaveUp: 0,
            failures: [],
          };
          byAutomation.set(run.automation, group);
        }
        group.total += 1;
        if (run.status === "succeeded") group.succeeded += 1;
        if (run.status === "skipped") group.skipped += 1;
        if (run.status === "failed") {
          group.failed += 1;
          const reason = run.error ?? run.summary;
          group.failures.push({
            task: ref,
            reason,
            restarted: reason.startsWith(BOARD_RESTARTED_ERROR),
          });
        }
        if (run.taskId) {
          const key = `${run.automation}:${run.taskId}`;
          if (lastOnTask.get(key) === "failed") group.retries += 1;
          lastOnTask.set(key, run.status);
        }
        const review = run.automation === AUTOPILOT_REVIEW_PRS ? prReviewOutput(run) : null;
        if (review?.handoff === "gave_up") group.gaveUp += 1;
        if (review && ref) {
          pr.push({
            ...ref,
            round: review.round,
            maxRounds: review.maxRounds,
            counts: review.counts,
            fyi: review.fyi,
            handoff: review.handoff,
          });
        }
        if (run.automation === AUTOPILOT_UNSTICK && run.status === "succeeded" && run.taskId && ref) {
          addStall({
            ...ref,
            taskId: run.taskId,
            kind: run.summary.startsWith(UNSTICK_STALE_PREFIX) ? "stale" : "waiting",
            at: run.finishedAt ?? run.updatedAt,
            text: run.summary,
          });
        }
      }
      const runs = [...byAutomation.values()].sort((a, b) => b.failed - a.failed || b.total - a.total);

      // Threads that waited on input are also announced to the inbox, whether or not Unstick ran on them.
      for (const n of repos.notifications.between(["thread_waiting"], start, end)) {
        const ref = n.taskId && inScope(n.taskId) ? taskRef(n.taskId) : null;
        if (ref)
          addStall({
            ...ref,
            taskId: n.taskId!,
            kind: "waiting",
            at: n.createdAt,
            text: n.title,
          });
      }

      // The latest note of each task, newest first: a task's handover is its last note, and a busy task's progress
      // notes would otherwise crowd the others out.
      const notes: NoteActivity[] = [];
      const noted = new Set<string>();
      for (const e of repos.events.between(["note"], start, end).reverse()) {
        if (e.actor === AUTOPILOT_ACTOR || (projectId && e.projectId !== projectId) || noted.has(e.taskId)) continue;
        noted.add(e.taskId);
        notes.push({
          number: e.number,
          title: e.title,
          at: e.at,
          actor: e.actor,
          text: typeof e.payload.text === "string" ? e.payload.text : "",
        });
      }

      return {
        from: start,
        to: end,
        project: project ? { id: project.id, title: project.title } : null,
        finished,
        reviews: {
          rounds: {
            total: localRounds.length,
            failed: localRounds.filter((r) => r.status === "failed").length,
            stalled: localRounds.filter((r) => r.status === "stalled").length,
          },
          local,
          pr,
        },
        runs,
        stalls: [...stalls.values()].sort((a, b) => a.at.localeCompare(b.at)),
        notes,
      };
    },
  };
}
