import { randomUUID } from "node:crypto";
import {
  agentAtWorkOn,
  AUTOPILOT_ACTIVE_STATUSES,
  AUTOPILOT_ACTOR,
  AUTOPILOT_TASK_SESSIONS,
  taskLabel,
  type AutopilotRun,
  type Project,
  type TaskSummary,
} from "@repo/contracts";
import type { TaskSessionRequest } from "../db/repos/taskSessionRequests.ts";
import { AppError } from "../errors.ts";
import type { Core } from "./core.ts";
import type { ProjectsService, TasksService } from "./types.ts";

export type { TaskSessionRequest };

/** How long after a session was asked for on a task another one is refused. */
export const TASK_SESSION_COOLDOWN_MS = 60 * 60_000;

/** How long a request waits for its run (held by quiet hours, a cap, or the concurrency limit) before it is dropped. */
export const TASK_SESSION_REQUEST_TTL_MS = 2 * 60 * 60_000;

/** How long after a request its run can be retried (retry_autopilot_run frees its key, and the request runs again). */
export const TASK_SESSION_RETRY_MS = 24 * 60 * 60_000;

/** The longest note Orchestrate can hand a session. */
export const TASK_SESSION_NOTE_MAX = 4_000;

/**
 * Why a new agent session can't start on the task now, or null when it can. The same rules refuse the tool and make
 * the run skip a request whose task moved on while it waited. `runs` are the task's Autopilot runs (without the run
 * asking, when one is), newest first.
 */
export function sessionRefusal(
  task: TaskSummary,
  project: Pick<Project, "title" | "workspaceRoot" | "t3ProjectId">,
  runs: readonly AutopilotRun[],
  now: number,
): string | null {
  const ref = taskLabel(task);
  if (task.kind === "epic") return `${ref} is an epic: start sessions on its tasks`;
  if (task.manual) return `${ref} is a manual task, the user's own to-do: leave it alone`;
  if (task.archivedAt !== null) return `${ref} is archived`;
  if (task.status === "planned") {
    return `${ref} is in Planned, which Start planned starts: if its start failed, retry_autopilot_run("${ref}", "start_planned")`;
  }
  if (task.status !== "in_progress" && task.status !== "review") {
    return `${ref} is in ${task.status === "done" ? "Done" : "Backlog"}: sessions start only on tasks In Progress or in Review`;
  }
  if (task.blocked) return `${ref} is blocked by unfinished tasks`;
  if (!project.workspaceRoot && !project.t3ProjectId) {
    return `${project.title} has neither a folder nor a T3 project for a session to work in`;
  }
  const working = agentAtWorkOn(task, now);
  if (working) {
    return working.kind === "t3_thread"
      ? `${ref} already has a T3 thread working on it: send it a message with message_task_thread("${ref}", ...) instead`
      : `${ref} already has an agent session working on it`;
  }
  // A review or a fix going on may change what is left to do; the session would race it.
  if (runs.some((r) => !r.dryRun && AUTOPILOT_ACTIVE_STATUSES.includes(r.status))) {
    return `an Autopilot run is working on ${ref} now`;
  }
  return null;
}

export interface RequestTaskSessionInput {
  /** The task's id. */
  taskId: string;
  note: string;
  actor: string;
  /** The project the asking run is bound to: a task in any other is refused. */
  projectId: string;
  requestedByRunId?: string | null;
}

/**
 * Orchestrate's requests for a new agent session on a task (docs/features/autopilot.md#task-sessions). The tool records
 * one; the Task sessions automation turns each into one Autopilot run, under the engine's switches, pause, quiet hours
 * and caps.
 */
export interface TaskSessionsService {
  /** Records a request, or throws CONFLICT with the reason the session can't start. */
  request(input: RequestTaskSessionInput): TaskSessionRequest;
  get(id: string): TaskSessionRequest | null;
  /** Requests made in the last TASK_SESSION_RETRY_MS that weren't dropped, oldest first. */
  open(): TaskSessionRequest[];
  /** Marks the request taken up by the run (again, for a retry); false when it was dropped. */
  take(id: string, runId: string): boolean;
  /**
   * Drops a waiting request with the reason, and notes it on the task so the next Orchestrate run knows no session
   * came; false when it no longer waited.
   */
  drop(id: string, reason: string): boolean;
  /**
   * The name of the connected machine holding the task whose own Autopilot looks after it, or null. The board doesn't
   * run its automations on such a task (autopilot/placement.ts), and the machine has no Task sessions, so a request
   * there would never run.
   */
  heldElsewhere(taskId: string): string | null;
}

export function createTaskSessionsService(
  core: Core,
  deps: {
    tasks: () => TasksService;
    projects: ProjectsService;
    runsForTask: (taskId: string) => AutopilotRun[];
    /** The connected machine holding the task whose own Autopilot looks after it (boardPlacement's rule), or null. */
    heldElsewhere: (taskId: string) => string | null;
  },
): TaskSessionsService {
  const { repos } = core;
  return {
    request(input) {
      const tasks = deps.tasks();
      const task = tasks.summary(input.taskId);
      const now = core.now().getTime();
      if (task.projectId !== input.projectId) {
        throw new AppError("CONFLICT", `${taskLabel(task)} isn't in the project this run looks after`);
      }
      const note = input.note.trim();
      if (!note) throw new AppError("VALIDATION", "Say what the session should do");
      if (note.length > TASK_SESSION_NOTE_MAX) {
        throw new AppError("VALIDATION", `Keep the note under ${TASK_SESSION_NOTE_MAX} characters`);
      }
      const project = deps.projects.get(task.projectId);
      const refusal = sessionRefusal(task, project, deps.runsForTask(task.id), now);
      if (refusal) throw new AppError("CONFLICT", `Not started: ${refusal}.`);
      const machine = deps.heldElsewhere(task.id);
      if (machine) {
        throw new AppError(
          "CONFLICT",
          `Not started: ${taskLabel(task)} is held by ${machine}, whose own Autopilot looks after it. Message its ` +
            "thread, or request_attention if nothing is working on it.",
        );
      }
      const since = new Date(now - TASK_SESSION_COOLDOWN_MS).toISOString();
      const recent = repos.taskSessionRequests.forTaskSince(task.id, since)[0];
      if (recent) {
        const at = recent.createdAt.slice(11, 16);
        throw new AppError(
          "CONFLICT",
          `Not started: a session was already asked for on ${taskLabel(task)} at ${at} UTC. ` +
            "Give it time, and look again on a later run: one session per task per hour.",
        );
      }
      const request = {
        id: randomUUID(),
        taskId: task.id,
        projectId: task.projectId,
        note,
        actor: input.actor,
        requestedByRunId: input.requestedByRunId ?? null,
        createdAt: new Date(now).toISOString(),
      };
      core.write((fx) => {
        repos.taskSessionRequests.insert(request);
        // A pass picks it up.
        fx.autopilot();
      });
      // Through the task service, so a held task's note goes to its machine.
      tasks.addNote(task.id, `Orchestrate asked for a new agent session on this task:\n\n${note}`, input.actor);
      return repos.taskSessionRequests.get(request.id)!;
    },
    get: (id) => repos.taskSessionRequests.get(id),
    open: () => repos.taskSessionRequests.open(new Date(core.now().getTime() - TASK_SESSION_RETRY_MS).toISOString()),
    take(id, runId) {
      return core.write((fx) => {
        const taken = repos.taskSessionRequests.take(id, runId);
        if (taken) fx.autopilot();
        return taken;
      });
    },
    drop(id, reason) {
      const dropped = core.write((fx) => {
        const done = repos.taskSessionRequests.drop(id, core.now().toISOString(), reason);
        if (done) fx.autopilot();
        return done;
      });
      const request = dropped ? repos.taskSessionRequests.get(id) : null;
      if (request && repos.tasks.get(request.taskId)) {
        deps
          .tasks()
          .addNote(
            request.taskId,
            `Autopilot dropped Orchestrate's request for a new session: ${reason}.`,
            AUTOPILOT_ACTOR,
          );
      }
      return dropped;
    },
    heldElsewhere: (taskId) => deps.heldElsewhere(taskId),
  };
}

/** The automation's dedupe key for a request: one run per request. */
export const taskSessionKey = (requestId: string): string => `${AUTOPILOT_TASK_SESSIONS}:${requestId}`;
