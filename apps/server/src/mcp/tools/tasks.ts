import { z } from "zod";
import { TaskStatus, type LinkInput } from "@repo/contracts";
import { AppError } from "../../errors.ts";
import { statusLabel } from "../format.ts";
import {
  actorField,
  hasProjectRef,
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
  "Only Ideas may exist without a plan.";

/** Task lifecycle tools: create_idea, create_task, move_task, update_task, add_note. */
export const registerTaskTools: ToolRegistrar = (server, { services, actor }) => {
  server.registerTool(
    "create_idea",
    {
      title: "Capture an idea",
      description:
        "Capture an idea in the Ideas column with one call. Ideas are cheap and need no plan: when something " +
        "worth doing comes up mid-task (a refactor, a bug you noticed, a follow-up), log it here and carry on " +
        "with your current work instead of getting derailed. Pass workspacePath (your cwd); the project is " +
        "created automatically if the board doesn't know it yet.",
      inputSchema: {
        title: z.string().min(1).describe("Short imperative title."),
        description: z
          .string()
          .optional()
          .describe("Markdown: what and why, enough context for someone picking it up later."),
        ...projectFields,
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        requireProjectRef(args);
        const project = services.projects.resolve(projectRef(args), { autoCreate: true });
        const task = services.tasks.create({
          projectId: project.id,
          title: args.title,
          ...(args.description ? { description: args.description } : {}),
          actor: actor(args.actor),
        });
        return textResult(`Captured idea #${task.number} "${task.title}" in ${project.title}.`, {
          taskId: task.id,
          number: task.number,
          status: task.status,
          projectId: project.id,
        });
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
        "keys, URLs) and, when running inside T3 Code, t3Thread so the user can jump back to your thread. " +
        "For something you are not doing now, use create_idea instead.",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional().describe("Markdown: what and why."),
        ...projectFields,
        ...planInputFields,
        links: z.array(z.string().min(1)).optional().describe("PR URLs, Jira keys (ABC-123) or URLs to attach."),
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
        const links: LinkInput[] = [
          ...(args.links ?? []).map((value) => ({ value })),
          ...(args.t3Thread ? [{ t3Thread: args.t3Thread }] : []),
        ];
        const task = services.tasks.create({
          projectId: project.id,
          title: args.title,
          ...(args.description ? { description: args.description } : {}),
          plan,
          ...(links.length ? { links } : {}),
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
        "Move to in_progress when you start implementing, to review when a PR is up (link it first), and to done " +
        "when merged or verified. Leaving Ideas requires a plan; if you get PLAN_REQUIRED, call set_plan first. " +
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
          return taskResult(services, id, `Moved #${summary.number} to ${statusLabel(summary.status)}.`);
        },
        { PLAN_REQUIRED: PLAN_REQUIRED_HINT },
      ),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task fields",
      description:
        "Edit a task's title, description or plan context, or archive/unarchive it. To move the task to a different " +
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
          },
          actor(args.actor),
        );
        return taskResult(services, task.id, `Updated #${task.number}.`);
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
        return textResult(`Note added to #${summary.number}.`, { taskId: id, number: summary.number });
      }),
  );
};
