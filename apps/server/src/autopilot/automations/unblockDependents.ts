import { z } from "zod";
import { defineAutomation, type Candidate } from "../types.ts";

export const AUTOPILOT_UNBLOCK_DEPENDENTS = "unblock_dependents";

/**
 * Tells the user when a task's last unfinished blocker reaches Done. Needs no agent and starts nothing: a flagged
 * Planned dependent becomes eligible for Start planned tasks on its own once it is no longer blocked. The dedupe
 * key carries the latest `statusChangedAt` among the blockers, so reopening one and finishing it again re-notifies
 * while two blockers finishing together give one.
 */
export const unblockDependents = defineAutomation({
  key: AUTOPILOT_UNBLOCK_DEPENDENTS,
  title: "Unblock dependents",
  description: "Notifies you when the last task blocking another reaches Done.",
  needsAgent: false,
  schema: z.object({}),
  fields: [],
  defaults: {},
  check: ({ services, projects }) =>
    projects.flatMap(({ project }): Candidate[] =>
      services.tasks
        .summaries({ projectId: project.id })
        .filter(
          (t) =>
            t.kind !== "epic" && t.archivedAt === null && t.status !== "done" && t.blockedBy.length > 0 && !t.blocked,
        )
        .map((t) => {
          const blockers = t.blockedBy.map((b) => services.tasks.summary(b.id));
          const lastDoneAt = blockers
            .map((b) => b.statusChangedAt)
            .sort()
            .at(-1)!;
          const names = blockers.map((b) => `#${b.number}`).join(", ");
          return {
            dedupeKey: `unblock:${t.id}:${lastDoneAt}`,
            summary: `tell you #${t.number} is unblocked (${names} finished)`,
            taskId: t.id,
            data: { names },
          };
        }),
    ),
  act: (candidate, { services, actor }) => {
    const task = services.tasks.summary(candidate.taskId!);
    const { names } = candidate.data as { names: string };
    services.tasks.addNote(task.id, `Unblocked: ${names} finished`, actor);
    services.notifications.notify({
      kind: "autopilot_notice",
      taskId: task.id,
      title: `#${task.number} is unblocked`,
      body: `${names} finished, so “${task.title}” has nothing left blocking it.`,
      dedupeKey: candidate.dedupeKey,
    });
    return { summary: `Unblocked: ${names} finished` };
  },
});
