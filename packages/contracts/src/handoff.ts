import { BRAND } from "./brand.ts";
import type { TaskSummary } from "./schemas.ts";

/** "work" picks the task up; "plan" asks the agent to shape the plan with the user first. */
export type HandoffMode = "work" | "plan";

export interface HandoffPromptInput {
  task: Pick<TaskSummary, "id" | "number" | "title">;
  /** Board origin, e.g. `http://127.0.0.1:5317`. */
  boardUrl: string;
  mode: HandoffMode;
  /** The session was started by the board and is already linked to the task. */
  linkedThread?: boolean;
}

/** Backlog and plan-less tasks still need a plan, so they default to planning together. */
export function defaultHandoffMode(task: Pick<TaskSummary, "status" | "progress">): HandoffMode {
  return task.status === "backlog" || task.progress.total === 0 ? "plan" : "work";
}

export function taskBoardUrl(boardUrl: string, taskId: string): string {
  return `${boardUrl.replace(/\/+$/, "")}/?task=${encodeURIComponent(taskId)}`;
}

/**
 * Short pointer to a task for starting a session on it ad hoc (merge conflicts, a follow-up). Unlike
 * taskHandoffPrompt it prescribes no workflow; the uuid works across projects where `#N` would not.
 */
export function taskReferenceLine({ task, boardUrl }: Omit<HandoffPromptInput, "mode" | "linkedThread">): string {
  return [
    `#${task.number} "${task.title}"`,
    `Board: ${taskBoardUrl(boardUrl, task.id)}`,
    `Call get_task("${task.id}") on the ${BRAND.id} MCP server, then continue from the current step.`,
  ].join("\n");
}

/**
 * Prompt that hands a task to an agent session (pasted into any harness, or sent as a T3 thread's first
 * message). It points at the task instead of copying it, so the agent reads the live plan and notes.
 */
export function taskHandoffPrompt({ task, boardUrl, mode, linkedThread = false }: HandoffPromptInput): string {
  const ref = `#${task.number} "${task.title}"`;
  const getTask = `Call get_task("${task.id}") on the ${BRAND.id} MCP server`;
  const lines =
    mode === "plan"
      ? [
          `Let's plan ${ref} from the ${BRAND.id} task board together.`,
          `Board: ${taskBoardUrl(boardUrl, task.id)}`,
          "",
          "This has no plan yet. I want to shape the plan with you before any code is written.",
          `1. ${getTask} to read the task, then explore the relevant code.`,
          "2. Ask me clarifying questions about scope, approach and anything ambiguous.",
          "3. Propose a plan: phases of 3-8 concrete, verifiable steps, plus the key decisions for the plan context.",
          "4. Once I agree, save it with set_plan and move the task to planned with move_task.",
          "Don't implement anything yet.",
        ]
      : [
          `Let's work on ${ref} from the ${BRAND.id} task board.`,
          `Board: ${taskBoardUrl(boardUrl, task.id)}`,
          "",
          `${getTask} first: it has the description, plan, current step and latest handover notes.`,
          `Then follow the ${BRAND.id} skill: write a plan with set_plan if there isn't one, pick up from the current step, keep steps current with update_step, link any PR you open, and finish with an add_note handover.`,
        ];
  lines.push(
    "",
    linkedThread
      ? "This thread is already linked to the task; don't link it again."
      : "Link the task to its Jira issue with link if it has one, and, if you're running in T3 Code, to this " +
          "thread with link(t3Thread: {environmentId, threadId}) from t3_environment_read and t3_thread_configuration.",
  );
  return lines.join("\n");
}
