import { z } from "zod";
import { StepStatus } from "@repo/contracts";
import { AppError } from "../../errors.ts";
import {
  actorField,
  planFromArgs,
  planInputFields,
  run,
  taskField,
  taskResult,
  type ToolRegistrar,
} from "../shared.ts";

const stepField = z
  .string()
  .min(1)
  .describe('Step reference: the "phase.step" label from get_task (e.g. "2.3") or the step id.');

const SHOWN_DELETED = 15;

/** Plan tools: set_plan, update_plan, add_steps, update_step. */
export const registerPlanTools: ToolRegistrar = (server, { services, actor }) => {
  server.registerTool(
    "set_plan",
    {
      title: "Set (replace) the plan",
      description:
        "REPLACES the task's whole plan: every phase or step you don't pass back with its id is deleted, along with " +
        "its status and notes. To change an existing plan use update_plan (mark many steps done, edit notes, move " +
        "steps, rename phases), update_step (one step) or add_steps (append). Use set_plan to write the first plan or " +
        "to deliberately rewrite one: give structured `phases` or a `markdown` checklist, plus optional `context` " +
        "(approach, decisions). A good plan has phases with 3-8 concrete, verifiable steps each. When rewriting, pass " +
        "the phase/step ids from get_task to keep their statuses and notes. A call that would delete steps with " +
        "progress (any status but todo) or notes, or a whole phase while keeping other steps, is refused unless you " +
        "pass `allowDeletes: true`. A task needs a plan before it can leave Backlog. Set `suggestedModel` to the " +
        "tier the implementing session should use; omit it on a rewrite to keep the current one. If the task has " +
        "no labels, the result asks you to suggest some: propose 1-3 to the user and apply them with update_task " +
        "once they agree.",
      inputSchema: {
        task: taskField,
        ...planInputFields,
        allowDeletes: z
          .boolean()
          .optional()
          .describe(
            "Set true to let this call delete steps with progress (any status but todo) or notes, or whole phases while keeping other steps. Without it such a call is refused.",
          ),
        actor: actorField,
      },
    },
    (args) =>
      run(
        () => {
          const id = services.tasks.resolveId(args.task);
          const plan = planFromArgs(args);
          if (!plan) throw new AppError("VALIDATION", "Pass phases or markdown.");
          const deleted = services.plans.deletionsOf(id, plan);
          const task = services.plans.setPlan(id, plan, actor(args.actor), { protectStarted: !args.allowDeletes });
          const shown = deleted.slice(0, SHOWN_DELETED).map((d) => `${d.label} ${d.title}`);
          const more = deleted.length - shown.length;
          const dropped =
            deleted.length > 0
              ? `
Deleted ${deleted.length} step(s): ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`
              : "";
          return taskResult(services, task.id, `Plan set for #${task.number}.${dropped}`, { planningHints: true });
        },
        {
          CONFLICT:
            "set_plan replaces the whole plan. To change steps in place use update_plan (status, notes, titles, moves, " +
            "phase renames), update_step or add_steps. If you really mean to drop these steps, call set_plan again " +
            "with allowDeletes: true.",
        },
      ),
  );

  server.registerTool(
    "update_plan",
    {
      title: "Update the plan in place",
      description:
        "Change several steps and phases of an existing plan in one call, without touching anything else: mark steps " +
        "done, set or append notes, rename steps, move steps within or between phases, rename phases. Unlike set_plan " +
        "it never deletes. All references (the 'phase.step' labels from get_task, step ids, phase numbers) refer to " +
        "the plan as it was before the call, so a move in the same call doesn't renumber later labels. All-or-nothing: " +
        "if any reference or move is invalid nothing is changed.",
      inputSchema: {
        task: taskField,
        steps: z
          .array(
            z.object({
              step: stepField,
              status: StepStatus.optional(),
              title: z.string().min(1).optional(),
              notes: z.string().optional().describe("Replaces the step notes (markdown). Empty string clears them."),
              appendNotes: z.string().optional().describe("Appended to existing notes as a new paragraph."),
              move: z
                .object({
                  phase: z
                    .string()
                    .optional()
                    .describe('Phase number ("2") or phase id to move to (appended at the end).'),
                  before: z.string().optional().describe("Step ref to place this step directly before."),
                  after: z.string().optional().describe("Step ref to place this step directly after."),
                })
                .optional()
                .describe(
                  "Move the step. Pass phase, or before/after (the step goes to that step's phase), or phase with before/after.",
                ),
            }),
          )
          .optional()
          .describe("Steps to change. Each needs at least one change besides `step`."),
        phases: z
          .array(
            z.object({
              phase: z.string().min(1).describe('Phase number ("2") or phase id.'),
              title: z.string().min(1),
            }),
          )
          .optional()
          .describe("Phases to rename."),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        const id = services.tasks.resolveId(args.task);
        services.plans.updatePlan(
          id,
          {
            ...(args.steps
              ? {
                  steps: args.steps.map(({ notes, move, ...rest }) => ({
                    ...rest,
                    ...(notes !== undefined ? { notes: notes === "" ? null : notes } : {}),
                    ...(move ? { move } : {}),
                  })),
                }
              : {}),
            ...(args.phases ? { phases: args.phases } : {}),
          },
          actor(args.actor),
        );
        const counts = [
          ...(args.steps?.length ? [`${args.steps.length} step(s)`] : []),
          ...(args.phases?.length ? [`${args.phases.length} phase(s)`] : []),
        ].join(" and ");
        return taskResult(services, id, `Updated ${counts} in the plan.`);
      }),
  );

  server.registerTool(
    "add_steps",
    {
      title: "Append steps",
      description:
        "Append steps to an existing phase (by 1-based number or id), or to a new phase when `newPhase` is given. " +
        "Use it when you discover extra work mid-task instead of rewriting the whole plan.",
      inputSchema: {
        task: taskField,
        phase: z.string().optional().describe('Phase number ("2") or phase id. Defaults to the last phase.'),
        newPhase: z.string().optional().describe("Title of a new phase to create (appended) and add the steps to."),
        steps: z
          .array(z.object({ title: z.string().min(1), notes: z.string().optional(), status: StepStatus.optional() }))
          .min(1),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        const id = services.tasks.resolveId(args.task);
        const who = actor(args.actor);
        let phaseId: string;
        if (args.newPhase) {
          if (args.phase) throw new AppError("VALIDATION", "Pass either phase or newPhase, not both.");
          phaseId = services.plans.addPhase(id, args.newPhase, who).id;
        } else {
          const phases = services.tasks.detail(id).phases;
          const ref = args.phase?.trim();
          const found = !ref
            ? phases.at(-1)
            : /^\d+$/.test(ref)
              ? phases[Number(ref) - 1]
              : phases.find((p) => p.id === ref);
          if (!found) {
            throw new AppError(
              "NOT_FOUND",
              phases.length === 0
                ? "This task has no phases yet. Pass newPhase, or use set_plan."
                : `Phase not found: ${ref}`,
            );
          }
          phaseId = found.id;
        }
        services.plans.addSteps(
          phaseId,
          args.steps.map((s) => ({
            title: s.title,
            ...(s.notes !== undefined ? { notes: s.notes } : {}),
            ...(s.status ? { status: s.status } : {}),
          })),
          who,
        );
        return taskResult(services, id, `Added ${args.steps.length} step(s).`);
      }),
  );

  server.registerTool(
    "update_step",
    {
      title: "Update a plan step",
      description:
        "Keep the plan current as you work: mark a step in_progress when you start it and done the moment it's " +
        "finished (blocked with a note if stuck, skipped if no longer needed). `notes` replaces the step's notes; " +
        "`appendNotes` adds a paragraph (findings, commands run, file paths). To change several steps at once use " +
        "update_plan, never set_plan.",
      inputSchema: {
        task: taskField,
        step: stepField,
        status: StepStatus.optional(),
        title: z.string().min(1).optional(),
        notes: z.string().optional().describe("Replaces the step notes (markdown). Empty string clears them."),
        appendNotes: z.string().optional().describe("Appended to existing notes as a new paragraph."),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        const id = services.tasks.resolveId(args.task);
        const stepId = services.plans.resolveStepId(id, args.step);
        services.plans.updateStep(
          stepId,
          {
            ...(args.status ? { status: args.status } : {}),
            ...(args.title ? { title: args.title } : {}),
            ...(args.notes !== undefined ? { notes: args.notes === "" ? null : args.notes } : {}),
            ...(args.appendNotes ? { appendNotes: args.appendNotes } : {}),
          },
          actor(args.actor),
        );
        return taskResult(services, id, `Step ${args.step} updated${args.status ? ` to ${args.status}` : ""}.`);
      }),
  );
};
