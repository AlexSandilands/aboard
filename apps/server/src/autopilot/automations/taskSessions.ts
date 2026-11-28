import {
  AUTOPILOT_ACTOR,
  AUTOPILOT_ORCHESTRATE,
  AUTOPILOT_TASK_SESSIONS,
  BRAND,
  taskHandoffPrompt,
  taskLabel,
  type TaskLink,
  type TaskSummary,
} from "@repo/contracts";
import { messageOf } from "../../integrations/util.ts";
import type { Services } from "../../services/types.ts";
import {
  sessionRefusal,
  taskSessionKey,
  TASK_SESSION_REQUEST_TTL_MS,
  type TaskSessionRequest,
} from "../../services/taskSessions.ts";
import {
  defineAutomation,
  RunAbandonedError,
  WorktreeHeadError,
  type ActionResult,
  type Candidate,
  type RunnerRequest,
} from "../types.ts";
import { orchestrateDefaults, orchestrateSchema } from "./orchestrate.ts";
import { workingAgents } from "./startPlanned.ts";

export { AUTOPILOT_TASK_SESSIONS };

const TITLE = "Task sessions";

type PrLink = Extract<TaskLink, { kind: "pr" }>;

/** The task's open pull request a session can push to: its own repository's branch, with a known head. */
export function sessionPr(task: Pick<TaskSummary, "links">): { link: PrLink; branch: string; head: string } | null {
  for (const link of task.links.toReversed()) {
    if (link.kind !== "pr" || !link.snapshot) continue;
    const { state, headRef, headOid, isCrossRepository } = link.snapshot;
    // A fork's branch isn't on origin, so there is nowhere to push.
    if ((state !== "open" && state !== "draft") || isCrossRepository || !headRef || !headOid) continue;
    return { link, branch: headRef, head: headOid };
  }
  return null;
}

/** Where the session works: the open PR's branch at its head, else a new branch (an integration epic's, from it). */
export function sessionWorkspace(
  task: Pick<TaskSummary, "links" | "integrationBranch">,
): Pick<RunnerRequest, "workspace" | "expectHead"> {
  const pr = sessionPr(task);
  if (pr) return { workspace: { branch: pr.branch }, expectHead: pr.head };
  return task.integrationBranch ? { workspace: { prBase: task.integrationBranch } } : {};
}

/** The prompt: the task's hand-off prompt, then Orchestrate's note marked as its own, then what an unattended run must know. */
export function taskSessionPrompt(input: { task: TaskSummary; boardUrl: string; note: string }): string {
  const { task } = input;
  const pr = sessionPr(task);
  const where = pr
    ? `Your work goes on the task's open pull request (${pr.link.url}): your worktree starts from its branch \`${pr.branch}\`, and the workspace note below says how to push to it. Don't open another pull request.`
    : "Work from earlier sessions may only be on their own branches or worktrees, which you can't see: read the task's notes, steps and activity (get_task) first, and pick up from what they say is done.";
  return [
    taskHandoffPrompt({ task, boardUrl: input.boardUrl, mode: "work", linkedThread: true }),
    "",
    `${BRAND.name} Autopilot's Orchestrate automation started this session because the task had stalled with no ` +
      "agent on it. Its note on what to do follows. It is Orchestrate's, not the user's: weigh it against the " +
      "task, its plan and its notes, which win where they differ.",
    "",
    "<orchestrate-note>",
    input.note.trim(),
    "</orchestrate-note>",
    "",
    where,
    "",
    "You were started by Autopilot and nobody is watching this session, so you can't ask the user anything, the " +
      "Autopilot flag included. If you need an answer, mark the current step blocked with a note saying what you " +
      "need, and stop. Move the task to review when the work is done, and finish with an add_note handover. Never " +
      "force-push, never push to the default branch and never merge a pull request; fix conflicts with a merge, " +
      "not a rebase.",
  ].join("\n");
}

const taskOf = (services: Services, request: TaskSessionRequest): TaskSummary | null => {
  try {
    return services.tasks.summary(request.taskId);
  } catch {
    return null;
  }
};

/**
 * Task sessions: one Autopilot run per request Orchestrate's start_task_session made, which starts a new agent session
 * on the task through the runner, on the runner its Sessions it starts setting picks and, headless, on the provider and
 * model Settings → Agents gives `taskRun`. It is part of Orchestrate: on wherever Orchestrate is, with its settings,
 * and listed under it. The engine adds pause, quiet hours and the caps; a request still held after
 * TASK_SESSION_REQUEST_TTL_MS, or whose project Orchestrate is no longer on in, is dropped.
 */
export const taskSessions = defineAutomation({
  key: AUTOPILOT_TASK_SESSIONS,
  title: TITLE,
  description: "Starts the agent sessions Orchestrate asks for on stalled tasks, one run each.",
  needsAgent: true,
  needsRepo: true,
  group: "ship",
  epicScope: false,
  partOf: AUTOPILOT_ORCHESTRATE,
  schema: orchestrateSchema,
  fields: [],
  defaults: orchestrateDefaults,
  // A skipped run did nothing (the task moved on, or got an agent): a new session is Orchestrate's to ask for again,
  // under the once-an-hour rule, rather than a retry's.
  retryRefusal: (run) =>
    run.status === "skipped"
      ? "That session was skipped, so there is nothing to retry: ask for a new one with start_task_session"
      : null,
  check: ({ services, projects, engine, now }) => {
    const on = new Map(projects.map((scope) => [scope.project.id, scope]));
    const candidates: Array<{ candidate: Candidate; preview: boolean }> = [];
    for (const request of services.taskSessions.open()) {
      // Taken up already (done, or going); a retried run frees its key, so the request runs again.
      if (services.autopilot.hasRun(AUTOPILOT_TASK_SESSIONS, taskSessionKey(request.id), false)) continue;
      const task = taskOf(services, request);
      const waiting = request.runId === null;
      if (!task) {
        services.taskSessions.drop(request.id, "its task is gone");
        continue;
      }
      if (waiting && now.getTime() - Date.parse(request.createdAt) > TASK_SESSION_REQUEST_TTL_MS) {
        services.taskSessions.drop(request.id, "it waited too long for room to run");
        continue;
      }
      const machine = waiting ? services.taskSessions.heldElsewhere(task.id) : null;
      if (machine) {
        services.taskSessions.drop(
          request.id,
          `${taskLabel(task)} is now held by ${machine}, whose own Autopilot looks after it`,
        );
        continue;
      }
      const scope = on.get(task.projectId);
      if (!scope) {
        if (waiting) services.taskSessions.drop(request.id, "Orchestrate is off in its project");
        continue;
      }
      candidates.push({
        candidate: {
          dedupeKey: taskSessionKey(request.id),
          summary: `start a session on ${taskLabel(task)} "${task.title}"`,
          taskId: task.id,
          data: { requestId: request.id },
          preview: `Orchestrate's note for the session:\n${request.note}`,
        },
        preview: scope.dryRun,
      });
    }
    const previewed = candidates.filter((c) => c.preview).map((c) => c.candidate);
    if (engine.dryRun) return previewed;
    const fresh = candidates.filter((c) => !c.preview).map((c) => c.candidate);
    if (fresh.length === 0) return previewed;
    // As Start planned: the engine's cap counts runs, which for T3 end once the thread starts, so leave room for the
    // threads still working.
    const agents = services.autopilot
      .automations()
      .filter((a) => a.needsAgent)
      .map((a) => a.key);
    const running = services.autopilot.usage(agents, new Date(0).toISOString()).active;
    return [
      ...fresh.slice(0, Math.max(0, engine.maxConcurrent - running - workingAgents(services, now))),
      ...previewed,
    ];
  },
  act: async (candidate, { services, runner, run, config, boardUrl }): Promise<ActionResult> => {
    const { requestId } = candidate.data as { requestId: string };
    const request = services.taskSessions.get(requestId);
    if (!request || !services.taskSessions.take(request.id, run.id)) {
      return { status: "skipped", summary: "Skipped: the request was dropped" };
    }
    const task = services.tasks.summary(request.taskId);
    const ref = taskLabel(task);
    const refusal = (): string | null => {
      const current = services.tasks.summary(task.id);
      return sessionRefusal(
        current,
        services.projects.get(current.projectId),
        services.autopilot.runsForTask(current.id, 20).filter((r) => r.id !== run.id),
        Date.now(),
      );
    };
    const before = refusal();
    if (before) return { status: "skipped", summary: `Skipped ${ref}: ${before}` };

    const options = { runner: config.runner };
    try {
      const started = await runner.start({
        run,
        label: TITLE,
        prompt: taskSessionPrompt({ task, boardUrl, note: request.note }),
        operation: "taskRun",
        // Only the runner choice: budget, timeout and T3 access are the board's agent defaults, and the model is the
        // board's for task runs (Orchestrate's own budget, timeout and model are for its look-over).
        options,
        // A wait for T3 can take minutes: the task may have moved on, or got an agent, meanwhile.
        stillWanted: () => {
          try {
            return refusal() === null;
          } catch {
            return false;
          }
        },
        ...sessionWorkspace(task),
      });
      const { result: _result, output: _output, ...patch } = started;
      return {
        ...patch,
        summary:
          started.runner === "headless" ? `Ran a headless session on ${ref}` : `Started a session on ${ref} in T3 Code`,
      };
    } catch (error) {
      if (error instanceof RunAbandonedError) return { status: "skipped", summary: `Skipped ${ref}: ${error.message}` };
      if (error instanceof WorktreeHeadError) {
        // Nothing runs this request again (a skipped session isn't retryable), so the next Orchestrate run is told.
        services.tasks.addNote(
          task.id,
          "Autopilot skipped the session Orchestrate asked for: the pull request moved on before it started. Ask " +
            "for a new one if the task is still stalled.",
          AUTOPILOT_ACTOR,
        );
        return {
          status: "skipped",
          ...(error.moved ? { deferred: "head_moved" as const } : {}),
          summary: `Skipped ${ref}: its pull request moved on before the session started`,
        };
      }
      return {
        status: "failed",
        error: `Autopilot couldn't run a session on ${ref}: ${messageOf(error)}`,
        needsAttention: true,
      };
    }
  },
});
