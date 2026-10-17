import { z } from "zod";
import {
  CloseTaskInput,
  TaskResolution,
  templateHasPlan,
  TaskStatusInput,
  type LinkInput,
  type T3ThreadRef,
} from "@repo/contracts";
import { AppError } from "../../errors.ts";
import type { Services } from "../../services/types.ts";
import { resolutionText, statusLabel } from "../format.ts";
import { openRoundInstructions } from "./reviews.ts";
import {
  actorField,
  autopilotField,
  autopilotValue,
  priorityField,
  blockedByField,
  deliveryField,
  epicField,
  findProject,
  hasProjectRef,
  labelsField,
  suggestedModelField,
  templateField,
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
  type ProjectRefArgs,
  type ToolRegistrar,
} from "../shared.ts";

const PLAN_REQUIRED_HINT =
  "Fix: call set_plan for this task (phases with concrete steps, or a markdown checklist), then retry move_task. " +
  "Only Backlog tasks may exist without a plan. If the work was already delivered by another task, is a duplicate, or " +
  "won't be done, use close_task instead; it needs no plan.";

const linksField = z
  .array(z.string().min(1))
  .optional()
  .describe("Jira keys (ABC-123), PR URLs or URLs to attach. Jira keys in the title are linked automatically.");

function linkInputs(args: { links?: string[] | undefined; t3Thread?: T3ThreadRef | undefined }): LinkInput[] {
  return [...(args.links ?? []).map((value) => ({ value })), ...(args.t3Thread ? [{ t3Thread: args.t3Thread }] : [])];
}

/**
 * The template an agent named, found before a project is auto-created so a typo doesn't leave one behind. A project
 * that doesn't exist yet has no templates of its own, only the board-wide ones. Also checks what the service would
 * refuse later (no title anywhere, or a planned task with no plan), for the same reason.
 */
function templateFor(
  services: Services,
  args: ProjectRefArgs & { template?: string | undefined; title?: string | undefined },
  opts: { needsPlan?: boolean; hasPlan?: boolean } = {},
) {
  const template = args.template
    ? services.templates.resolve(args.template, findProject(services, args)?.id ?? "")
    : null;
  if (!args.title && !template?.titlePattern) {
    throw new AppError(
      "VALIDATION",
      template ? `Pass a title: template "${template.name}" has no title pattern.` : "Pass a title.",
    );
  }
  if (opts.needsPlan && !opts.hasPlan && !(template && templateHasPlan(template))) {
    throw new AppError(
      "VALIDATION",
      template
        ? `Template "${template.name}" has no plan; pass a plan (phases or markdown), or use add_to_backlog.`
        : "create_task needs a plan (phases or markdown), or a template that has one. Use add_to_backlog for unplanned work.",
    );
  }
  return template;
}

/**
 * Task lifecycle tools: add_to_backlog, create_task, create_epic, move_task, close_task, update_task, delete_task,
 * add_note.
 */
export const registerTaskTools: ToolRegistrar = (server, { services, ctx, actor }) => {
  server.registerTool(
    "add_to_backlog",
    {
      title: "Add a task to the backlog",
      description:
        "Add a task to the Backlog column with one call: an idea, a known to-do, a Jira ticket or GitHub issue " +
        "to pick up later. Backlog tasks are cheap and need no plan: when something worth doing comes up mid-task " +
        "(a refactor, a bug you noticed, a follow-up), log it here and carry on with your current work instead of " +
        "getting derailed. Pass workspacePath (your cwd); the project is " +
        "created automatically if the board doesn't know it yet. Pass the Jira key in links if there is one, " +
        "epic when it is part of a larger feature, blockedBy when other tasks must finish first, and t3Thread when " +
        "running inside T3 Code. Set autopilot only if the user has said whether Autopilot may start it, and priority " +
        "only if the user has asked for it. Pass " +
        "template (a name from list_templates, such as Bug or Spike) to start from the user's template: its " +
        "description, labels and plan are copied, and the task stays in Backlog.",
      inputSchema: {
        title: z
          .string()
          .min(1)
          .optional()
          .describe("Short imperative title. Optional when the template has a title pattern."),
        description: z
          .string()
          .optional()
          .describe("Markdown: what and why, enough context for someone picking it up later."),
        ...projectFields,
        epic: epicField.optional(),
        template: templateField.optional(),
        blockedBy: blockedByField.optional(),
        links: linksField,
        labels: labelsField.optional(),
        autopilot: autopilotField.optional(),
        priority: priorityField.optional(),
        t3Thread: t3ThreadField.optional(),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        requireProjectRef(args);
        const template = templateFor(services, args);
        const project = services.projects.resolve(projectRef(args), { autoCreate: true });
        const links = linkInputs(args);
        const task = services.tasks.create({
          projectId: project.id,
          ...(args.title ? { title: args.title } : {}),
          ...(args.description ? { description: args.description } : {}),
          ...(args.epic ? { epicId: args.epic } : {}),
          ...(template ? { template: template.id } : {}),
          ...(args.blockedBy?.length ? { blockedBy: args.blockedBy } : {}),
          ...(links.length ? { links } : {}),
          ...(args.labels?.length ? { labels: args.labels } : {}),
          ...(args.autopilot ? { autopilot: autopilotValue(args.autopilot) } : {}),
          ...(args.priority ? { priority: true } : {}),
          actor: actor(args.actor),
        });
        const where = task.parent ? ` in epic #${task.parent.number}` : "";
        const plan = task.progress.total ? ` with its ${task.progress.total}-step plan` : "";
        const from = template ? ` from template ${template.name}${plan}` : "";
        return textResult(`Added #${task.number} "${task.title}" to Backlog in ${project.title}${where}${from}.`);
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
        "can jump back to your thread. Tag it with labels for the kind of work (ui, backend, ...) and set " +
        "suggestedModel to the tier its implementation needs, epic when it is part of a larger feature, and " +
        "blockedBy when other tasks must be Done first. When the result asks about the Autopilot flag, ask the user " +
        "before setting autopilot; set priority only if the user has asked for it. With template (a name from list_templates, such as Bug or Spike) the plan is " +
        "optional: the template's plan is copied, and a plan you give replaces it. " +
        "For something you are not doing now, use add_to_backlog instead.",
      inputSchema: {
        title: z
          .string()
          .min(1)
          .optional()
          .describe("Short imperative title. Optional when the template has a title pattern."),
        description: z.string().optional().describe("Markdown: what and why."),
        ...projectFields,
        epic: epicField.optional(),
        template: templateField.optional(),
        blockedBy: blockedByField.optional(),
        ...planInputFields,
        links: linksField,
        labels: labelsField.optional(),
        autopilot: autopilotField.optional(),
        priority: priorityField.optional(),
        t3Thread: t3ThreadField.optional(),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        requireProjectRef(args);
        const plan = planFromArgs(args);
        const template = templateFor(services, args, { needsPlan: true, hasPlan: plan !== null });
        const project = services.projects.resolve(projectRef(args), { autoCreate: true });
        const links = linkInputs(args);
        const task = services.tasks.create({
          projectId: project.id,
          ...(args.title ? { title: args.title } : {}),
          ...(args.description ? { description: args.description } : {}),
          ...(args.epic ? { epicId: args.epic } : {}),
          ...(template ? { template: template.id, status: "planned" as const } : {}),
          ...(args.blockedBy?.length ? { blockedBy: args.blockedBy } : {}),
          ...(plan ? { plan } : {}),
          ...(links.length ? { links } : {}),
          ...(args.labels?.length ? { labels: args.labels } : {}),
          ...(args.autopilot ? { autopilot: autopilotValue(args.autopilot) } : {}),
          ...(args.priority ? { priority: true } : {}),
          actor: actor(args.actor),
        });
        return taskResult(services, task.id, `Created task #${task.number} in ${project.title}.`, {
          planningHints: true,
        });
      }),
  );

  server.registerTool(
    "create_epic",
    {
      title: "Create an epic",
      description:
        "Create an epic: a large feature that groups several tasks in one project, shown as a band across the " +
        "columns its tasks are in. An epic has no plan and no column of its own: its tasks carry the plans, and its " +
        "status follows them (the furthest-back open task sets it; Done once they all are). Pass tasks to put " +
        'existing tasks in it now; add new ones later with create_task or add_to_backlog (epic: "#N"). Epics don\'t ' +
        "nest. Link the T3 thread that will coordinate it with t3Thread. Pass delivery only once the user has chosen " +
        "how its tasks are delivered (pull requests to main, or an integration branch).",
      inputSchema: {
        title: z.string().min(1).describe("Short name for the feature."),
        description: z.string().optional().describe("Markdown: the goal, scope and how the tasks fit together."),
        ...projectFields,
        tasks: z
          .array(z.string().min(1))
          .optional()
          .describe('Existing tasks to put in the epic: "#42", "42" or uuids, all in the same project.'),
        links: linksField,
        labels: labelsField.optional(),
        t3Thread: t3ThreadField.optional(),
        delivery: deliveryField.optional(),
        actor: actorField,
      },
    },
    (args) =>
      run(async () => {
        requireProjectRef(args);
        const project = services.projects.resolve(projectRef(args), { autoCreate: true });
        // Check every task first, so a bad reference doesn't leave a half-filled epic behind.
        const children = (args.tasks ?? []).map((ref) => services.tasks.summary(services.tasks.resolveId(ref)));
        for (const child of children) {
          if (child.kind === "epic") throw new AppError("VALIDATION", `#${child.number} is an epic; epics don't nest`);
          if (child.projectId !== project.id) {
            throw new AppError(
              "VALIDATION",
              `#${child.number} is in another project; an epic's tasks share its project`,
            );
          }
          if (child.parent) {
            throw new AppError(
              "VALIDATION",
              `#${child.number} is already in epic #${child.parent.number}. To move it, call update_task(task, epic) after creating this epic.`,
            );
          }
        }
        const links = linkInputs(args);
        const epic = services.tasks.createEpic(
          {
            projectId: project.id,
            title: args.title,
            ...(args.description ? { description: args.description } : {}),
            ...(links.length ? { links } : {}),
            ...(args.labels?.length ? { labels: args.labels } : {}),
          },
          children.map((c) => c.id),
          actor(args.actor),
        );
        const added = children.length ? ` with ${children.map((c) => `#${c.number}`).join(", ")}` : "";
        const headline = `Created epic #${epic.number} in ${project.title}${added}.`;
        if (args.delivery) {
          try {
            await ctx.integrations.setEpicDelivery(epic.id, args.delivery, actor(args.actor));
          } catch (error) {
            // The epic exists either way; say why its delivery didn't change rather than fail the whole call.
            const why = error instanceof AppError ? error.message : String(error);
            return taskResult(services, epic.id, `${headline} Its delivery wasn't set: ${why}`, { deliveryHint: true });
          }
        }
        return taskResult(services, epic.id, headline, { deliveryHint: true });
      }),
  );

  server.registerTool(
    "move_task",
    {
      title: "Move task to a status",
      description:
        "Change a task's status: backlog -> planned -> in_progress -> review -> done (any direction is allowed). " +
        "Move to in_progress when you start implementing (and link your T3 thread if the task doesn't have it yet), to review when the work is done, and to done " +
        "when merged or verified. Mark every plan step done (or skipped) before moving on to review or done; the result lists any still open. Leaving Backlog requires a plan; if you get PLAN_REQUIRED, call set_plan first. " +
        "With auto-review on, moving to review opens a local review round and the result tells you how to run " +
        "the review loop; finish it before opening the PR (a PR opened earlier is reviewed on GitHub too), then always open the PR and link it, even if findings are still open at the round limit (list them in the PR description), or push to the PR already linked. Otherwise link the PR before moving to review. " +
        "beforeTask/afterTask optionally position it within the column.",
      inputSchema: {
        task: taskField,
        status: TaskStatusInput,
        beforeTask: z.string().optional().describe("Place before this task (same project and status)."),
        afterTask: z.string().optional().describe("Place after this task (same project and status)."),
        actor: actorField,
      },
    },
    (args) =>
      run(
        () => {
          const id = services.tasks.resolveId(args.task);
          const wasDone = services.tasks.detail(id).status === "done";
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
          // The PR was opened before the loop (the old order): it can be reviewed on GitHub while the loop runs.
          const early =
            review && summary.links.some((l) => l.kind === "pr")
              ? "A pull request is already linked. Finish the local review loop below first, and push every fix to that PR; don't open another. Until the loop ends, Autopilot holds off its own review of the PR."
              : null;
          return taskResult(services, id, review ? [moved, early, review].filter(Boolean).join("\n\n") : moved, {
            closing: summary.status === "done" && !wasDone,
          });
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
        "Edit a task's title, description, plan context, labels, suggested model or Autopilot flag, or archive/unarchive it. " +
        "The Autopilot flag lets the board start the task by itself, so set it only after the user has said so. To move the task to a different " +
        "project pass moveToProjectId or moveToWorkspacePath (the target project must already exist); that takes " +
        "it out of its epic unless you also pass an epic there. Pass epic to put the task in an epic (or move it " +
        "to another), or epic: null to take it out. Pass addBlockedBy / removeBlockedBy to set or clear the tasks " +
        "that must be Done before this one (it is blocked while any blocker isn't Done). On an epic, delivery sets how " +
        "its tasks are delivered; set it only once the user has chosen. " +
        "For plan steps use set_plan/update_plan/add_steps/update_step; for status use move_task.",
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
        archived: z
          .boolean()
          .optional()
          .describe(
            "Archives or unarchives the task. An epic needs no open tasks to be archived; it takes its Done tasks " +
              "along, and unarchiving it brings back the ones archived with it. Unarchiving a task whose epic is " +
              "archived unarchives the epic too (as does reopening it with move_task).",
          ),
        autoReview: z
          .boolean()
          .nullable()
          .optional()
          .describe("Turn local review on or off for this task; null follows the board's setting."),
        labels: labelsField.optional().describe("Replaces the whole label list; [] clears it."),
        suggestedModel: suggestedModelField.nullable().optional().describe("null clears it."),
        autopilot: autopilotField.optional(),
        priority: priorityField.optional(),
        epic: epicField.nullable().optional().describe('The epic to put it in ("#12"); null takes it out.'),
        addBlockedBy: blockedByField.optional().describe("Tasks to add as blockers of this one."),
        removeBlockedBy: blockedByField.optional().describe("Blockers to remove; one that isn't a blocker is ignored."),
        delivery: deliveryField.optional().describe(`Epics only. ${deliveryField.description}`),
        actor: actorField,
      },
    },
    (args) =>
      run(async () => {
        const id = services.tasks.resolveId(args.task);
        if (args.delivery !== undefined && services.tasks.summary(id).kind !== "epic") {
          throw new AppError("VALIDATION", "delivery is set on an epic, not on a task: pass the epic.");
        }
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
            ...(args.suggestedModel !== undefined ? { suggestedModel: args.suggestedModel } : {}),
            ...(args.autopilot !== undefined ? { autopilot: autopilotValue(args.autopilot) } : {}),
            ...(args.priority !== undefined ? { priority: args.priority } : {}),
            ...(args.epic !== undefined ? { epicId: args.epic } : {}),
            ...(args.addBlockedBy?.length ? { addBlockedBy: args.addBlockedBy } : {}),
            ...(args.removeBlockedBy?.length ? { removeBlockedBy: args.removeBlockedBy } : {}),
          },
          actor(args.actor),
        );
        // After the other fields, so a refused switch (git, or tasks already started) leaves them saved and says why.
        if (args.delivery !== undefined) await ctx.integrations.setEpicDelivery(id, args.delivery, actor(args.actor));
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
