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

/** Plan tools: set_plan, add_steps, update_step. */
export const registerPlanTools: ToolRegistrar = (server, { services, actor }) => {
  server.registerTool(
    "set_plan",
    {
      title: "Set (replace) the plan",
      description:
        "Write or replace a task's plan before implementing. Give structured `phases` or a `markdown` checklist, plus " +
        "optional `context` (approach, decisions). A good plan has phases with 3-8 concrete, verifiable steps each. " +
        "When revising an existing plan, pass the phase/step ids from get_task to keep their statuses and notes; " +
        "steps you omit are deleted. A task needs a plan before it can leave Backlog. Set `suggestedModel` to the " +
        "tier the implementing session should use; omit it on a revision to keep the current one. If the task has " +
        "no labels, the result asks you to suggest some: propose 1-3 to the user and apply them with update_task " +
        "once they agree.",
      inputSchema: {
        task: taskField,
        ...planInputFields,
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        const id = services.tasks.resolveId(args.task);
        const plan = planFromArgs(args);
        if (!plan) throw new AppError("VALIDATION", "Pass phases or markdown.");
        const task = services.plans.setPlan(id, plan, actor(args.actor));
        return taskResult(services, task.id, `Plan set for #${task.number}.`, { planningHints: true });
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
        "`appendNotes` adds a paragraph (findings, commands run, file paths).",
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
