import { z } from "zod";
import { defineAutomation, type Candidate } from "../types.ts";

export const AUTOPILOT_AUTO_ARCHIVE = "auto_archive";

const DAY_MS = 86_400_000;

/**
 * Archives tasks that have sat in Done for a while, so the column stays readable. Needs no agent, and archives
 * rather than deletes. The dedupe key carries `statusChangedAt`: a task someone unarchives stays unarchived until
 * it leaves Done and comes back.
 */
export const autoArchive = defineAutomation({
  key: AUTOPILOT_AUTO_ARCHIVE,
  title: "Auto-archive Done",
  description: "Archives tasks that have been in Done for more than the set number of days.",
  needsAgent: false,
  // It skips tasks in an epic, so an epic's switch would change nothing.
  epicScope: false,
  schema: z.object({ days: z.number().int().min(1).default(14) }),
  fields: [{ key: "days", label: "Days in Done", kind: "number", min: 1, step: 1, unit: "days" }],
  defaults: { days: 14 },
  check: ({ services, projects, now }) =>
    projects.flatMap(({ project, config }): Candidate[] => {
      const cutoff = now.getTime() - config.days * DAY_MS;
      return (
        services.tasks
          .summaries({ projectId: project.id, status: "done" })
          // Epics archive with their own rules. An epic's tasks stay too: archived children leave its roll-up, which
          // would send a finished epic back to Backlog. A card with an unmerged PR still has work attached.
          .filter((t) => t.kind !== "epic" && t.parent === null && Date.parse(t.statusChangedAt) < cutoff)
          .filter(
            (t) =>
              !t.links.some(
                (l) => l.kind === "pr" && (l.snapshot === null || ["open", "draft"].includes(l.snapshot.state)),
              ),
          )
          .map((t) => ({
            dedupeKey: `archive:${t.id}:${t.statusChangedAt}`,
            summary: `archive #${t.number} after ${config.days} days in Done`,
            taskId: t.id,
          }))
      );
    }),
  act: (candidate, { services, config, actor }) => {
    services.tasks.update(candidate.taskId!, { archived: true }, actor);
    services.tasks.addNote(candidate.taskId!, `Archived by Autopilot after ${config.days} days in Done`, actor);
    return { summary: `Archived after ${config.days} days in Done` };
  },
});
