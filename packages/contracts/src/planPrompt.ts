import { z } from "zod";
import { AgentHarness } from "./agentSessions.ts";
import { BRAND } from "./brand.ts";
import type { PlanSkillRef } from "./reviews.ts";
import type { Project, TaskSummary } from "./schemas.ts";
import { CliModel } from "./sessionLaunch.ts";
import { StartT3ThreadInput } from "./t3Launch.ts";

/**
 * Body of the board's built-in planning skill. `skills/aboard-plan/SKILL.md` ships the same text with
 * frontmatter (a test keeps them identical); it lives here so the bundled server can hand it to agents
 * without reading files from the repo.
 */
export const BUILTIN_PLAN_SKILL_BODY = `# Planning tasks

You are planning tasks from the user's task board with them, before any code is written. Each task leaves
with a plan the user agreed to: phases of concrete steps, the key decisions, a suggested model tier and
labels. Don't implement anything.

## For each task

1. **Read it.** \`get_task\` for the description, links, images and any notes. Open pasted images.
2. **Research.** Explore the code the task touches: where the change goes, what already exists that it can
   reuse, the project's conventions (AGENTS.md, CLAUDE.md, docs) and what could make it harder than it looks.
3. **Find the questions.** List what you can't settle from the code: scope, behaviour the user has to choose,
   trade-offs between approaches. Recommend an answer for each. Skip questions with an obvious default; say
   which default you took instead.
4. **Draft the plan.** Phases of 3-8 concrete, verifiable steps each ("Add links table migration", not
   "Backend"), testing as its own steps. Put the approach, key decisions and the files involved in the plan
   context. Pick the suggested model tier (light, standard or deep) with a one-line reason, and 1-3 labels,
   preferring ones the board already uses (\`board_overview\` lists them). Note any task it depends on.

## Simple and complex tasks

Sort the tasks first. A task is **simple** when its approach is obvious and it has no open questions (a copy
change, a one-file fix, a mechanical edit). Everything else is **complex**.

- Simple tasks go together: draft all of them, show them as one set, and let the user approve the set at once
  or pick out the ones to change.
- Complex tasks go one at a time: research, draft, ask, agree, save, then the next.

Tell the user the order before you start: the simple set first or last, then each complex task.

## Print, then ask

Some apps collapse everything but the last message of a turn once it ends, and question dialogs vanish once
answered. So the plan must never live only in a dialog or in the middle of a turn:

1. **Print the plan first**, in full, as its own message: what you found, then the draft plan (phases and
   steps, context, tier and labels). For a set of simple tasks, a table: task, the plan in a line, tier,
   labels.
2. **Only then ask**, with your harness's question dialog if it has one (AskUserQuestion in Claude Code), or as
   plain questions otherwise. Never open a dialog before the plan text is printed, and never put the plan
   only inside a dialog or its option previews.
3. **After saving, restate what was saved** as the last message of the turn: the final plan, or a compact
   table of it for a set, plus anything still open. Make every tool call before that message, and don't end
   on a short acknowledgement that pushes the plan out of view.

## Saving

Once the user agrees to a task's plan:

1. \`set_plan(task, phases, context, suggestedModel: {tier, reason})\`.
2. If the task has no labels, apply the agreed ones with \`update_task(task, labels)\`.
3. Record dependencies on other tasks with \`update_task(task, addBlockedBy)\`.
4. If it is in Backlog, \`move_task(task, "planned")\`. A task already in progress without a plan stays where it is.
5. If the result says the Autopilot flag isn't set, ask the user whether to flag the task (one question can
   cover a whole set), and set it with \`update_task(task, autopilot: "on" | "off")\` only once they answer.
   Never set it on your own.

Tasks the user wants to drop or merge into another: \`close_task\` with \`wont_do\` or \`duplicate\`, once they
say so. A task that turns out too large: suggest splitting it, and with the user's agreement add the parts
with \`add_to_backlog\` (or make an epic with \`create_epic\`).

## Finishing

End with a table of every task: its plan in a line, tier, labels, Autopilot flag and status, and anything
left undecided. Add an \`add_note\` to any task you couldn't finish planning, saying where it got to.
`;

type PlanTaskRef = Pick<TaskSummary, "id" | "number" | "title">;

export interface PlanTasksPromptInput {
  project: Pick<Project, "id" | "title">;
  tasks: ReadonlyArray<PlanTaskRef>;
  skill: PlanSkillRef;
  /** Board origin, e.g. `http://127.0.0.1:5317`. */
  boardUrl: string;
  /** The session was started by the board and is already linked to every task. */
  linked?: boolean;
}

/** "#3, #4 and #7". */
export const taskNumberList = (tasks: ReadonlyArray<Pick<TaskSummary, "number">>): string => {
  const refs = tasks.map((task) => `#${task.number}`);
  return refs.length <= 1 ? (refs[0] ?? "") : `${refs.slice(0, -1).join(", ")} and ${refs.at(-1)}`;
};

/** The label a planning session is linked under: "Planning #3, #4, #7". */
export const planningSessionLabel = (tasks: ReadonlyArray<Pick<TaskSummary, "number">>): string =>
  `Planning ${tasks.map((task) => `#${task.number}`).join(", ")}`;

const planSkillLines = (skill: PlanSkillRef): string[] =>
  skill.source === "builtin"
    ? ["How to plan:", "", BUILTIN_PLAN_SKILL_BODY.trim()]
    : [`How to plan: read the skill "${skill.name}" at ${skill.path} and follow it.`];

/**
 * The bulk planning hand-off: an agent walks the user through writing a plan for each of several tasks. Sent as a
 * T3 thread's first message, copied, or given to a terminal session as its first prompt.
 */
export function planTasksPrompt({ project, tasks, skill, boardUrl, linked = false }: PlanTasksPromptInput): string {
  const origin = boardUrl.replace(/\/+$/, "");
  const label = planningSessionLabel(tasks);
  return [
    `Let's plan ${tasks.length === 1 ? "a task" : `${tasks.length} tasks`} in the ${project.title} project on the ${BRAND.id} task board together.`,
    `Board: ${origin}/`,
    "",
    ...tasks.map((task) => `- #${task.number} "${task.title}": get_task("${task.id}")`),
    "",
    `Read each with get_task on the ${BRAND.id} MCP server, then shape a plan for each with me and save it. Don't implement anything.`,
    "",
    linked
      ? "The board started this session and already linked it to every task; don't link it again."
      : "If you're running in T3 Code, link this thread to every task with link(task, t3Thread: {environmentId, threadId}) " +
        "from t3_environment_read and t3_thread_configuration. In Claude Code or Copilot CLI, link your own session to " +
        `every task with link(task, agentSession: {harness, sessionId, cwd}, label: "${label}"), the id from ` +
        "$CLAUDE_CODE_SESSION_ID or $COPILOT_AGENT_SESSION_ID (unless you're told the board linked it for you).",
    "",
    ...planSkillLines(skill),
  ].join("\n");
}

/**
 * The first message of a board-started planning session when the full prompt can't go on the command line: it
 * fetches the full prompt over MCP instead. Built from task numbers alone, which every shell can take.
 */
export const planTasksShortPrompt = (tasks: ReadonlyArray<Pick<TaskSummary, "number">>): string =>
  `Let's plan ${taskNumberList(tasks)} from the ${BRAND.id} task board: call get_handoff_prompt(tasks: ` +
  `[${tasks.map((task) => `"#${task.number}"`).join(", ")}], mode: "plan") on the ${BRAND.id} MCP server first and ` +
  "follow it. The board started this session and already linked it to every task; don't link it again.";

/**
 * Why a task can't go into a bulk planning session, or null when it can: open tasks still in Backlog or without a
 * plan, never an epic (its tasks carry the plans).
 */
export function planTaskProblem(
  task: Pick<TaskSummary, "number" | "kind" | "archivedAt" | "status" | "progress"> &
    Partial<Pick<TaskSummary, "manual">>,
): string | null {
  if (task.kind === "epic") return `#${task.number} is an epic: plan its tasks instead`;
  if (task.manual) return `#${task.number} is a manual task, which needs no plan`;
  if (task.archivedAt) return `#${task.number} is archived`;
  if (task.status === "done") return `#${task.number} is done`;
  if (task.status !== "backlog" && task.progress.total > 0) return `#${task.number} already has a plan`;
  return null;
}

/** The most tasks one planning session takes. */
export const MAX_PLAN_TASKS = 50;

/** The tasks a bulk planning session is about: references (`#N` or ids) in one project, in the order given. */
export const PlanTaskIds = z.array(z.string().trim().min(1)).min(1).max(MAX_PLAN_TASKS);

/** `POST /api/projects/:id/plan-thread`: a T3 thread that plans several tasks, linked to each. */
export const StartPlanningThreadInput = StartT3ThreadInput.extend({ taskIds: PlanTaskIds });
export type StartPlanningThreadInput = z.infer<typeof StartPlanningThreadInput>;

/**
 * `POST /api/projects/:id/plan-session`: a Claude Code or Copilot CLI session that plans several tasks. It runs in
 * the project's checkout, as planning writes no code.
 */
export const StartPlanningSessionInput = z.object({
  harness: AgentHarness,
  prompt: z.string().trim().min(1).max(100_000),
  /** Null runs the CLI's own default. */
  model: CliModel.nullable(),
  taskIds: PlanTaskIds,
});
export type StartPlanningSessionInput = z.infer<typeof StartPlanningSessionInput>;
