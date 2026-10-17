import { BRAND } from "./brand.ts";
import { modelTierDescription, type ModelTiers } from "./modelTiers.ts";
import type { Project, TaskSummary } from "./schemas.ts";

/**
 * "work" picks the task up; "plan" asks the agent to shape the plan with the user first; "orchestrate" (epics
 * only) has the agent start the epic's tasks in other sessions and see them through.
 */
export type HandoffMode = "work" | "plan" | "orchestrate";

export interface HandoffPromptInput {
  task: Pick<TaskSummary, "id" | "number" | "title"> &
    Partial<Pick<TaskSummary, "suggestedModel" | "kind" | "blocked">>;
  /** Board origin, e.g. `http://127.0.0.1:5317`. */
  boardUrl: string;
  mode: HandoffMode;
  /** The session was started by the board and is already linked to the task. */
  linkedThread?: boolean;
  /** A Claude Code or Copilot CLI session the board started and linked to the task (see sessionLaunch.ts). */
  linkedSession?: boolean;
  /** Names the task's suggested tier in a copied work prompt; without it the line shows the bare tier. */
  modelTiers?: ModelTiers;
  /**
   * A work prompt for a subagent started by an epic's orchestrator: it can't ask the user or run its own
   * review loop, so it reports back instead.
   */
  subagent?: boolean;
}

/** Epics are orchestrated. Backlog and plan-less tasks still need a plan, so they default to planning together. */
export function defaultHandoffMode(
  task: Pick<TaskSummary, "status" | "progress"> & Partial<Pick<TaskSummary, "kind">>,
): HandoffMode {
  if (task.kind === "epic") return "orchestrate";
  return task.status === "backlog" || task.progress.total === 0 ? "plan" : "work";
}

/** Why a mode doesn't fit a task, or null when it does: epics are only orchestrated, and only work prompts go to subagents. */
export function handoffModeError(
  task: Pick<TaskSummary, "number"> & Partial<Pick<TaskSummary, "kind" | "progress">>,
  mode: HandoffMode,
  subagent = false,
): string | null {
  const epic = task.kind === "epic";
  if (epic && mode !== "orchestrate") {
    return `#${task.number} is an epic: its prompt is mode "orchestrate". Hand off its tasks with their own prompts.`;
  }
  if (!epic && mode === "orchestrate") return `#${task.number} isn't an epic; only epics are orchestrated`;
  if (subagent && mode !== "work") {
    return "Only work prompts go to subagents: a subagent can't plan with the user or orchestrate. Draft unplanned tasks' plans yourself.";
  }
  // The user approves a plan before its task starts; a subagent can't ask them.
  if (subagent && task.progress?.total === 0) {
    return `#${task.number} has no plan yet. Draft one, get the user's approval and save it with set_plan before starting a subagent on it.`;
  }
  return null;
}

export function taskBoardUrl(boardUrl: string, taskId: string): string {
  return `${boardUrl.replace(/\/+$/, "")}/?task=${encodeURIComponent(taskId)}`;
}

/**
 * Short pointer to a task for starting a session on it ad hoc (merge conflicts, a follow-up). Unlike
 * taskHandoffPrompt it prescribes no workflow; the uuid works across projects where `#N` would not.
 */
export function taskReferenceLine({
  task,
  boardUrl,
}: Omit<HandoffPromptInput, "mode" | "linkedThread" | "modelTiers">): string {
  return [
    `#${task.number} "${task.title}"`,
    `Board: ${taskBoardUrl(boardUrl, task.id)}`,
    `Call get_task("${task.id}") on the ${BRAND.id} MCP server, then continue from the current step.`,
  ].join("\n");
}

/**
 * "Suggested model: standard (Sonnet 5.5): reason. ..." for a copied work prompt, or null when the task has no
 * suggestion. A board-started thread already runs on the model picked in the dialog, so callers skip it there.
 */
export function suggestedModelLine(
  task: Partial<Pick<TaskSummary, "suggestedModel">>,
  modelTiers: ModelTiers | undefined,
  advice = "Switch your session's model if it differs.",
): string | null {
  const suggestion = task.suggestedModel;
  if (!suggestion) return null;
  const description = modelTiers ? modelTierDescription(modelTiers, suggestion.tier) : null;
  const name = description ? `${suggestion.tier} (${description})` : suggestion.tier;
  const reason = suggestion.reason ? `: ${suggestion.reason.replace(/[.\s]+$/, "")}` : "";
  return `Suggested model: ${name}${reason}. ${advice}`;
}

/**
 * Prompt that hands a task to an agent session (pasted into any harness, or sent as a T3 thread's first
 * message). It points at the task instead of copying it, so the agent reads the live plan and notes.
 */
export function taskHandoffPrompt({
  task,
  boardUrl,
  mode,
  linkedThread = false,
  linkedSession = false,
  modelTiers,
  subagent = false,
}: HandoffPromptInput): string {
  const ref = `#${task.number} "${task.title}"`;
  const getTask = `Call get_task("${task.id}") on the ${BRAND.id} MCP server`;
  if (mode === "orchestrate") return orchestratePrompt(task, boardUrl, linkedThread);
  if (subagent) return subagentPrompt(task, boardUrl);
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
          "4. Once I agree, save it with set_plan and move the task to planned with move_task. If the result asks about the Autopilot flag, ask me whether to flag the task and set it with update_task only once I've answered.",
          "Don't implement anything yet.",
        ]
      : [
          `Let's work on ${ref} from the ${BRAND.id} task board.`,
          `Board: ${taskBoardUrl(boardUrl, task.id)}`,
          "",
          `${getTask} first: it has the description, plan, current step and latest handover notes.`,
          `Then follow the ${BRAND.id} skill: write a plan with set_plan if there isn't one, pick up from the current step, keep steps current with update_step (mark each in_progress when you start it and done the moment it finishes, never all at the end of a phase), link any PR you open, and finish with an add_note handover.`,
          "If a plan result asks about the Autopilot flag, ask me whether to flag the task and set it with update_task only once I've answered. You can flag tasks but never change Autopilot's settings.",
          ...(task.blocked
            ? [
                `This task is blocked: get_task lists what it waits on under "Blocked by". Don't start it until those are Done; tell me what it waits on instead.`,
              ]
            : []),
        ];
  // Planning sessions ignore the suggestion: it is about implementing, and planning is often a stronger model.
  const model = mode === "work" && !linkedThread && !linkedSession ? suggestedModelLine(task, modelTiers) : null;
  if (model) lines.push("", model);
  if (linkedSession) {
    lines.push(
      "",
      "The board started this session and already linked it to the task; don't link it again. Link the task to its " +
        "Jira issue with link if it has one.",
    );
    return lines.join("\n");
  }
  lines.push(
    "",
    linkedThread
      ? "This thread is already linked to the task; don't link it again."
      : "Link the task to its Jira issue with link if it has one, and, if you're running in T3 Code, to this " +
          "thread with link(t3Thread: {environmentId, threadId}) from t3_environment_read and t3_thread_configuration.",
    "In Claude Code or Copilot CLI, also link your own session with link(agentSession: {harness, sessionId, cwd}, " +
      `label: "${mode === "plan" ? "Planning" : "Implementing"} #${task.number}"), the id from $CLAUDE_CODE_SESSION_ID or ` +
      "$COPILOT_AGENT_SESSION_ID, so it can be reopened from the board under that name (unless you're told the board linked it for you).",
  );
  return lines.join("\n");
}

/**
 * The work prompt for a subagent an orchestrator started. A subagent can't talk to the user and (in most harnesses)
 * can't start subagents of its own, so it stops at questions and at an open review round and reports back.
 */
function subagentPrompt(task: HandoffPromptInput["task"], boardUrl: string): string {
  const ref = `#${task.number} "${task.title}"`;
  return [
    `Work on ${ref} from the ${BRAND.id} task board. You are a subagent: the session that started you is orchestrating this task's epic and reads your report.`,
    `Board: ${taskBoardUrl(boardUrl, task.id)}`,
    "",
    `Call get_task("${task.id}") on the ${BRAND.id} MCP server first: it has the description, plan, current step and latest handover notes.`,
    `Then follow the ${BRAND.id} skill: pick up from the current step, keep steps current with update_step (mark each in_progress when you start it and done the moment it finishes, never all at the end of a phase) and work in the git worktree or branch you were given.`,
    "You can't ask the user anything. If you need an answer, mark the step blocked with a note saying what you need, then stop and report back. Don't set the task's Autopilot flag: that is the user's call.",
    "When the work is done, move_task to review. If the result says a review round is open, don't run the review loop and don't open a pull request, even though the result describes the loop and a self-review: stop and report back that round's number, as the orchestrator runs the review. If no round opens, open the pull request and link it.",
    "Leave an add_note handover on the task, and end your reply with a short report: what you did, the task's status and anything the orchestrator has to act on.",
    "",
    "Link the task to its Jira issue with link if it has one. Don't link a T3 thread: you run inside the orchestrator's session.",
  ].join("\n");
}

/**
 * The epic prompt: start the epic's tasks in other sessions, by the first route the harness supports, and see them
 * through. Harnesses are named only as examples, so it reads right in any of them.
 */
function orchestratePrompt(task: HandoffPromptInput["task"], boardUrl: string, linkedThread: boolean): string {
  const ref = `#${task.number}`;
  const overview = `epic_overview("${task.id}")`;
  return [
    `Let's run the epic #${task.number} "${task.title}" from the ${BRAND.id} task board: start its tasks and see them through to review.`,
    `Board: ${taskBoardUrl(boardUrl, task.id)}`,
    "",
    `1. Call ${overview} on the ${BRAND.id} MCP server: it lists the epic's tasks with their status, plan progress, current step and sessions. get_task("${task.id}") adds the epic's description.`,
    "2. Tasks without a plan (in Backlog): read each with get_task and explore the code, then draft a plan for each. Show me the drafts together, and once I approve save each with set_plan (with suggestedModel) and move_task it to planned. Don't start a task before its plan is approved.",
    '3. Work out which tasks can run in parallel and which must wait for another (one builds on another, or they change the same files). Leave out tasks that are done, in review or already have a session working on them, and tasks that are blocked (epic_overview shows "blocked by #N"): start those once what blocks them is Done. Tell me the order before starting anything.',
    "4. Start each task by the first route that works here:",
    "   - T3 Code threads, if epic_overview says T3 Code is available: start_task_thread(task) for each. Each gets its own worktree (pass baseRef when a task builds on another's branch), runs its own review loop, and its live status shows in epic_overview.",
    "   - Subagents, if you can start them (Claude Code's Agent tool, Copilot CLI's subagents, or your harness's equivalent): one per task, with get_handoff_prompt(task, subagent: true) as its prompt. Start it on the model of the task's suggested tier if you can choose one. Give each its own git worktree and branch when they run in parallel (your harness's worktree isolation, or git worktree add), otherwise run them one at a time.",
    "   - Otherwise, give me get_handoff_prompt(task) for each, and I'll paste them into new sessions.",
    `5. Keep track with ${overview}: progress, current step, blocked steps, review rounds and each task's last note. Answer a blocked step yourself if you can, else ask me. To tell a session something, use message_task_thread for a T3 thread, message a subagent directly if your harness allows it, else add_note on its task, which a session reads on its next get_task.`,
    "6. A subagent stops when its move to Review opens a review round and reports the round. Run the loop for it. First read the task with get_task: if its latest round was already submitted (the board's own reviewer can take a round nobody picked up) and left blocking or major findings open, start with the fixes below. Otherwise call start_review(task) for the open round's reviewer brief and give it to a fresh reviewer subagent working in the task's worktree; once it has submitted, have an implementer subagent in the task's worktree fix the open findings and mark each with resolve_finding. When the implementer has resolved the last blocking or major finding the board opens the next round itself: call start_review(task) for its brief and give it to a new reviewer. When the loop ends, have the implementer open the pull request and link it. If start_review says the round is already being reviewed, the board's own reviewer has it: check back with get_task. T3 threads and sessions I started run their own review loop.",
    `7. Don't set_plan, move or review the epic itself: its status follows its tasks. Finish with add_note on ${ref}: which tasks started by which route, where each is, and what's left.`,
    "",
    linkedThread
      ? "This thread is already linked to the epic; don't link it again."
      : `If you're running in T3 Code, link this thread to ${ref} with link(t3Thread: {environmentId, threadId}) from t3_environment_read and t3_thread_configuration.`,
  ].join("\n");
}

/**
 * The project-level hand-off, "Suggest epics": an agent groups the project's open tasks into epics with the user.
 * It only groups; planning and starting the tasks is each epic's own hand-off.
 */
export function suggestEpicsPrompt({
  project,
  boardUrl,
}: {
  project: Pick<Project, "id" | "title">;
  /** Board origin, e.g. `http://127.0.0.1:5317`. */
  boardUrl: string;
}): string {
  return [
    `Let's group the open work in the ${project.title} project on the ${BRAND.id} task board into epics.`,
    `Board: ${boardUrl.replace(/\/+$/, "")}/`,
    "",
    `1. Call board_overview(projectId: "${project.id}") on the ${BRAND.id} MCP server: it lists the project's open tasks, which epic each is in, and its open epics. Read a task with get_task when its title doesn't say enough.`,
    "2. Propose epics: groups of tasks that together make one larger feature or change. Give each a title, a one-line description and its tasks, and say which tasks belong in an epic that already exists. Leave out tasks that stand alone (not everything needs an epic), and leave tasks already in an epic where they are unless you think one is misplaced; then say so and why.",
    "3. Wait for me to agree or change the groups.",
    `4. Then create each new epic with create_epic(projectId: "${project.id}", title, description, tasks: ["#4", "#5"]), and move tasks into existing epics with update_task(task, epic: "#N").`,
    "Don't plan, start or move any task: this is only about grouping. Finish with a short list of the epics and their tasks.",
  ].join("\n");
}
