import { z } from "zod";
import { defineAutomation, type Candidate } from "../types.ts";

export const AUTOPILOT_UNBLOCK_DEPENDENTS = "unblock_dependents";

/** How long after its last blocker finished a dependent still counts as just unblocked. */
const RECENT_MS = 86_400_000;

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
  check: ({ services, projects, now }) =>
    projects.flatMap(({ project }): Candidate[] => {
      const summaries = services.tasks.summaries({ projectId: project.id });
      const byId = new Map(summaries.map((t) => [t.id, t]));
      const since = now.getTime() - RECENT_MS;
      return summaries.flatMap((t): Candidate[] => {
        if (
          t.kind === "epic" ||
          t.archivedAt !== null ||
          t.status === "done" ||
          t.blockedBy.length === 0 ||
          t.blocked
        ) {
          return [];
        }
        // Blockers in other projects aren't in the map.
        const blockers = t.blockedBy.map((b) => byId.get(b.id) ?? services.tasks.summary(b.id));
        const lastDoneAt = blockers
          .map((b) => b.statusChangedAt)
          .sort()
          .at(-1)!;
        // About something that just happened: not blockers finished long ago (when the automation is first switched
        // on, or a Done task is attached as a blocker).
        if (Date.parse(lastDoneAt) < since) return [];
        const names = blockers.map((b) => `#${b.number}${b.resolution === "wont_do" ? " (won't do)" : ""}`).join(", ");
        return [
          {
            dedupeKey: `unblock:${t.id}:${lastDoneAt}`,
            summary: `tell you #${t.number} is unblocked (${names} finished)`,
            taskId: t.id,
            data: { names },
          },
        ];
      });
    }),
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
