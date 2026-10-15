import { z } from "zod";
import { CloseTaskInput, TaskResolution, TaskStatus, type LinkInput, type T3ThreadRef } from "@repo/contracts";
import { AppError } from "../../errors.ts";
import { resolutionText, statusLabel } from "../format.ts";
import { openRoundInstructions } from "./reviews.ts";
import {
  actorField,
  hasProjectRef,
  labelsField,
  planFromArgs,
  planInputFields,
  projectFields,
  projectRef,
  requireProjectRef,
  run,
  t3ThreadField,
  taskField,
  taskResult,
  textResult,
  type ToolRegistrar,
} from "../shared.ts";

const PLAN_REQUIRED_HINT =
  "Fix: call set_plan for this task (phases with concrete steps, or a markdown checklist), then retry move_task. " +
  "Only Ideas may exist without a plan. If the work was already delivered by another task, is a duplicate, or " +
  "won't be done, use close_task instead; it needs no plan.";

const linksField = z
  .array(z.string().min(1))
  .optional()
  .describe("Jira keys (ABC-123), PR URLs or URLs to attach. Jira keys in the title are linked automatically.");

function linkInputs(args: { links?: string[] | undefined; t3Thread?: T3ThreadRef | undefined }): LinkInput[] {
  return [...(args.links ?? []).map((value) => ({ value })), ...(args.t3Thread ? [{ t3Thread: args.t3Thread }] : [])];
}

/** Task lifecycle tools: create_idea, create_task, move_task, close_task, update_task, delete_task, add_note. */
export const registerTaskTools: ToolRegistrar = (server, { services, actor }) => {
  server.registerTool(
    "create_idea",
    {
      title: "Capture an idea",
      description:
        "Capture an idea in the Ideas column with one call. Ideas are cheap and need no plan: when something " +
        "worth doing comes up mid-task (a refactor, a bug you noticed, a follow-up), log it here and carry on " +
        "with your current work instead of getting derailed. Pass workspacePath (your cwd); the project is " +
        "created automatically if the board doesn't know it yet. Pass the Jira key in links if there is one, and " +
        "t3Thread when running inside T3 Code.",
      inputSchema: {
        title: z.string().min(1).describe("Short imperative title."),
        description: z
          .string()
          .optional()
          .describe("Markdown: what and why, enough context for someone picking it up later."),
        ...projectFields,
        links: linksField,
        labels: labelsField.optional(),
        t3Thread: t3ThreadField.optional(),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        requireProjectRef(args);
        const project = services.projects.resolve(projectRef(args), { autoCreate: true });
        const links = linkInputs(args);
        const task = services.tasks.create({
          projectId: project.id,
          title: args.title,
          ...(args.description ? { description: args.description } : {}),
          ...(links.length ? { links } : {}),
          ...(args.labels?.length ? { labels: args.labels } : {}),
          actor: actor(args.actor),
        });
        return textResult(`Captured idea #${task.number} "${task.title}" in ${project.title}.`);
      }),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create a planned task",
      description:
        "Create a task you are about to work on, with its plan, in one call. Lands in Planned. A plan is required: " +
        "either structured `phases` or a `markdown` checklist. A good plan has 1-4 phases, each with 3-8 concrete, " +
        "verifiable steps ('Add links table migration', not 'Do backend'). Optionally attach links (PR URLs, Jira " +
        "keys, URLs; link the Jira issue now, not at PR time) and, when running inside T3 Code, t3Thread so the user " +
        "can jump back to your thread. Tag it with labels for the kind of work (ui, backend, ...). " +
        "For something you are not doing now, use create_idea instead.",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional().describe("Markdown: what and why."),
        ...projectFields,
        ...planInputFields,
        links: linksField,
        labels: labelsField.optional(),
        t3Thread: t3ThreadField.optional(),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        requireProjectRef(args);
        const plan = planFromArgs(args);
        if (!plan) {
          throw new AppError(
            "VALIDATION",
            "create_task needs a plan (phases or markdown). Use create_idea for unplanned work.",
          );
        }
        const project = services.projects.resolve(projectRef(args), { autoCreate: true });
        const links = linkInputs(args);
        const task = services.tasks.create({
          projectId: project.id,
          title: args.title,
          ...(args.description ? { description: args.description } : {}),
          plan,
          ...(links.length ? { links } : {}),
          ...(args.labels?.length ? { labels: args.labels } : {}),
          actor: actor(args.actor),
        });
        return taskResult(services, task.id, `Created task #${task.number} in ${project.title}.`);
      }),
  );

  server.registerTool(
    "move_task",
    {
      title: "Move task to a status",
      description:
        "Change a task's status: idea -> planned -> in_progress -> review -> done (any direction is allowed). " +
        "Move to in_progress when you start implementing (and link your T3 thread if the task doesn't have it yet), to review when the work is done, and to done " +
        "when merged or verified. Leaving Ideas requires a plan; if you get PLAN_REQUIRED, call set_plan first. " +
        "With auto-review on, moving to review opens a local review round and the result tells you how to run " +
        "the review loop; finish it before opening the PR. Otherwise link the PR before moving to review. " +
        "beforeTask/afterTask optionally position it within the column.",
      inputSchema: {
        task: taskField,
        status: TaskStatus,
        beforeTask: z.string().optional().describe("Place before this task (same project and status)."),
        afterTask: z.string().optional().describe("Place after this task (same project and status)."),
        actor: actorField,
      },
    },
    (args) =>
      run(
        () => {
          const id = services.tasks.resolveId(args.task);
          const summary = services.tasks.move(
            id,
            {
              status: args.status,
              ...(args.beforeTask ? { beforeId: services.tasks.resolveId(args.beforeTask) } : {}),
              ...(args.afterTask ? { afterId: services.tasks.resolveId(args.afterTask) } : {}),
            },
            actor(args.actor),
          );
          // Entering Review with every PR already merged completes the task straight away.
          const moved =
            summary.status === args.status
              ? `Moved #${summary.number} to ${statusLabel(summary.status)}.`
              : `Moved #${summary.number} to ${statusLabel(args.status)}; its PRs are already merged, so it went on to ${statusLabel(summary.status)}.`;
          const review = summary.status === "review" ? openRoundInstructions(services, id) : null;
          return taskResult(services, id, review ? `${moved}\n\n${review}` : moved);
        },
        { PLAN_REQUIRED: PLAN_REQUIRED_HINT },
      ),
  );

  server.registerTool(
    "close_task",
    {
      title: "Close a task as done elsewhere, duplicate or won't do",
      description:
        "Close a task without doing it here: resolution 'completed' when another task already delivered it, " +
        "'duplicate' when another task covers the same thing, 'wont_do' when it is no longer wanted. Moves it to " +
        "Done with no plan needed and records the link, so the other task shows it also resolved this one. Prefer " +
        "this to archiving. completed/duplicate need byTask; wont_do must not have one. Moving the task out of " +
        "Done later reopens it and clears the resolution.",
      inputSchema: {
        task: taskField,
        resolution: TaskResolution,
        byTask: z.string().optional().describe('The task that delivered or duplicates this one: "#42", "42" or uuid.'),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        const input = CloseTaskInput.parse({ resolution: args.resolution, byTask: args.byTask });
        const id = services.tasks.resolveId(args.task);
        const byTaskId = input.byTask ? services.tasks.resolveId(input.byTask) : undefined;
        const task = services.tasks.close(
          id,
          { resolution: input.resolution, ...(byTaskId ? { byTaskId } : {}) },
          actor(args.actor),
        );
        return taskResult(services, id, `Closed #${task.number} as ${resolutionText(task) ?? task.resolution}.`);
      }),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task fields",
      description:
        "Edit a task's title, description, plan context or labels, or archive/unarchive it. To move the task to a different " +
        "project pass moveToProjectId or moveToWorkspacePath (the target project must already exist). " +
        "For plan steps use set_plan/add_steps/update_step; for status use move_task.",
      inputSchema: {
        task: taskField,
        title: z.string().min(1).optional(),
        description: z.string().optional().describe("Replaces the description (markdown)."),
        planContext: z.string().optional().describe("Replaces the plan context (markdown)."),
        moveToProjectId: z
          .string()
          .optional()
          .describe("Moves the task to this project. Omit unless you mean to move it."),
        moveToWorkspacePath: z
          .string()
          .optional()
          .describe("Moves the task to the existing project for this workspace path. Omit unless you mean to move it."),
        archived: z.boolean().optional(),
        autoReview: z
          .boolean()
          .nullable()
          .optional()
          .describe("Turn local review on or off for this task; null follows the board's setting."),
        labels: labelsField.optional().describe("Replaces the whole label list; [] clears it."),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        const id = services.tasks.resolveId(args.task);
        const moveRef = { projectId: args.moveToProjectId, workspacePath: args.moveToWorkspacePath };
        const projectId = hasProjectRef(moveRef)
          ? services.projects.resolve(projectRef(moveRef), { autoCreate: false }).id
          : undefined;
        const task = services.tasks.update(
          id,
          {
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.planContext !== undefined ? { planContext: args.planContext } : {}),
            ...(projectId ? { projectId } : {}),
            ...(args.archived !== undefined ? { archived: args.archived } : {}),
            ...(args.autoReview !== undefined ? { autoReview: args.autoReview } : {}),
            ...(args.labels !== undefined ? { labels: args.labels } : {}),
          },
          actor(args.actor),
        );
        return taskResult(services, task.id, `Updated #${task.number}.`);
      }),
  );

  server.registerTool(
    "delete_task",
    {
      title: "Permanently delete an archived task",
      description:
        "Permanently delete a task with its plan, links and activity log. This cannot be undone. The task must be " +
        "archived first (update_task with archived: true), so deleting is always a deliberate second step. Only " +
        "delete when the user asks for it; to close finished or unwanted work use close_task or move_task instead. " +
        "Tasks that were closed against this one keep their resolution but lose the link to it.",
      inputSchema: {
        task: taskField,
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        const id = services.tasks.resolveId(args.task);
        const { number, title } = services.tasks.summary(id);
        services.tasks.delete(id, actor(args.actor));
        return textResult(`Deleted #${number} "${title}" permanently.`);
      }),
  );

  server.registerTool(
    "add_note",
    {
      title: "Add a progress/handover note",
      description:
        "Append a free-form note to the task's activity log. Use it at the end of a session as a handover: what " +
        "you did, what's left, gotchas, and the exact next action, so the next agent (or you, later) can resume " +
        "from get_task. Also good for decisions and discoveries worth keeping.",
      inputSchema: {
        task: taskField,
        text: z.string().min(1).describe("Markdown note."),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        const id = services.tasks.resolveId(args.task);
        services.tasks.addNote(id, args.text, actor(args.actor));
        const summary = services.tasks.summary(id);
        return textResult(`Note added to #${summary.number}.`);
      }),
  );
};
