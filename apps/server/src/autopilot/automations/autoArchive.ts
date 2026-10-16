import type { TaskSummary } from "@repo/contracts";
import { z } from "zod";
import { defineAutomation, type Candidate } from "../types.ts";

export const AUTOPILOT_AUTO_ARCHIVE = "auto_archive";

const DAY_MS = 86_400_000;

/** A PR that isn't finished (open, draft, or not read yet): the card still has work attached. */
const hasUnmergedPr = (t: Pick<TaskSummary, "links">): boolean =>
  t.links.some((l) => l.kind === "pr" && (l.snapshot === null || ["open", "draft"].includes(l.snapshot.state)));

const tasksOf = (n: number): string => `${n} task${n === 1 ? "" : "s"}`;

/**
 * Archives tasks that have sat in Done for a while, so the column stays readable. Needs no agent, and archives
 * rather than deletes. The dedupe key carries `statusChangedAt`: a task someone unarchives stays unarchived until
 * it leaves Done and comes back.
 *
 * A task in an epic is never archived on its own: archived children leave the epic's roll-up, which would send a
 * finished epic back to Backlog. Instead the epic is archived with its tasks once it has been Done that long. A
 * Done task whose epic is already archived (archived before epics took their tasks along) counts as loose.
 */
export const autoArchive = defineAutomation({
  key: AUTOPILOT_AUTO_ARCHIVE,
  title: "Auto-archive Done",
  description:
    "Archives tasks that have been in Done for more than the set number of days, and finished epics with their tasks.",
  needsAgent: false,
  epicScope: true,
  schema: z.object({ days: z.number().int().min(1).default(14) }),
  fields: [{ key: "days", label: "Days in Done", kind: "number", min: 1, step: 1, unit: "days" }],
  defaults: { days: 14 },
  check: ({ services, projects, now }) =>
    projects.flatMap(({ project, config }): Candidate[] => {
      const done = services.tasks.summaries({ projectId: project.id, status: "done" });
      const older = (t: TaskSummary, days: number) => Date.parse(t.statusChangedAt) < now.getTime() - days * DAY_MS;
      const epicArchived = new Map<string, boolean>();
      const inLiveEpic = (t: TaskSummary): boolean => {
        if (t.parent === null) return false;
        const id = t.parent.id;
        if (!epicArchived.has(id)) epicArchived.set(id, services.tasks.summary(id).archivedAt !== null);
        return !epicArchived.get(id);
      };
      const tasks = done
        .filter((t) => t.kind !== "epic" && !inLiveEpic(t) && older(t, config.days))
        .filter((t) => !hasUnmergedPr(t))
        .map((t): Candidate => ({
          dedupeKey: `archive:${t.id}:${t.statusChangedAt}`,
          summary: `archive #${t.number} after ${config.days} days in Done`,
          taskId: t.id,
        }));
      const epics = done
        .filter((t) => t.kind === "epic")
        .flatMap((epic): Candidate[] => {
          // The epic's own setting decides: it may have its own number of days, or be off while the project is on.
          const own = services.autopilot.resolve(autoArchive, project.id, epic.id);
          if (!own.enabled || !own.config) return [];
          const days = Number(own.config.days);
          // An epic in Done has every unarchived task Done (any resolution).
          const children = services.tasks.summaries({ projectId: project.id, epicId: epic.id });
          if (!older(epic, days) || hasUnmergedPr(epic) || children.some(hasUnmergedPr)) return [];
          return [
            {
              dedupeKey: `archive-epic:${epic.id}:${epic.statusChangedAt}`,
              summary: `archive #${epic.number} with its ${tasksOf(children.length)} after ${days} days in Done`,
              taskId: epic.id,
              data: { days },
            },
          ];
        });
      return [...tasks, ...epics];
    }),
  act: (candidate, { services, config, actor }) => {
    const id = candidate.taskId!;
    // Only epic candidates carry data.
    const epicDays = (candidate.data as { days: number } | undefined)?.days;
    if (epicDays !== undefined) {
      const count = services.tasks.archiveFinishedEpic(id, actor);
      const what = `with its ${tasksOf(count)} after ${epicDays} days in Done`;
      services.tasks.addNote(id, `Archived by Autopilot ${what}`, actor);
      return { summary: `Archived ${what}` };
    }
    services.tasks.update(id, { archived: true }, actor);
    services.tasks.addNote(id, `Archived by Autopilot after ${config.days} days in Done`, actor);
    return { summary: `Archived after ${config.days} days in Done` };
  },
});
