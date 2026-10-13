import type { TaskDetail, TaskSummary } from "@taskboard/contracts";
import { randomUUID } from "node:crypto";
import { nowIso } from "../db/database.ts";
import type { TaskRecord } from "../db/repos/tasks.ts";
import { AppError, notFound, planRequired } from "../errors.ts";
import { positionAmong, type Core } from "./core.ts";
import type { PlansModule } from "./plans.ts";
import { assembleSummaries, type AssembledTask } from "./summaries.ts";
import type { LinksService, ProjectsService, TaskQuery, TasksService } from "./types.ts";

const DETAIL_EVENT_LIMIT = 100;

/** Case-insensitive text match over title, description, "#number" and Jira keys. */
export function matchesQuery({ record, summary }: AssembledTask, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const number = /^#?(\d+)$/.exec(q);
  if (number && Number(number[1]) === record.number) return true;
  const haystack = [
    record.title,
    record.description ?? "",
    `#${record.number}`,
    ...summary.links.flatMap((l) => (l.kind === "jira" ? [l.ref.key] : [])),
  ];
  return haystack.some((text) => text.toLowerCase().includes(q));
}

/** Task cards: creation, updates, moves between columns, notes. */
export function createTasksService(
  core: Core,
  deps: { projects: ProjectsService; plans: () => PlansModule; links: () => LinksService },
): { service: TasksService; record: (id: string) => TaskRecord } {
  const { repos } = core;

  const record = (id: string): TaskRecord => {
    const task = repos.tasks.get(id);
    if (!task) throw notFound("Task", id);
    return task;
  };

  const assembleOne = (id: string): AssembledTask => assembleSummaries(repos, [record(id)]).get(id)!;

  const endOfLane = (task: Pick<TaskRecord, "id" | "projectId" | "status">): string =>
    positionAmong(
      repos.tasks.lane(task.projectId, task.status).filter((t) => t.id !== task.id),
      {},
    );

  const service: TasksService = {
    summaries(query: TaskQuery = {}): TaskSummary[] {
      const records = repos.tasks.list(query);
      return [...assembleSummaries(repos, records).values()]
        .filter((t) => !query.query || matchesQuery(t, query.query))
        .filter((t) => !query.attentionOnly || t.summary.attention.length > 0)
        .map((t) => t.summary);
    },

    summary: (id) => assembleOne(id).summary,

    detail(id): TaskDetail {
      const { record: task, summary, phases } = assembleOne(id);
      return {
        ...summary,
        description: task.description,
        planContext: task.planContext,
        phases,
        events: repos.events.recent(id, DETAIL_EVENT_LIMIT),
      };
    },

    resolveId(ref) {
      const trimmed = ref.trim();
      const number = /^#?(\d+)$/.exec(trimmed);
      const task = number ? repos.tasks.byNumber(Number(number[1])) : repos.tasks.get(trimmed);
      if (!task) throw notFound("Task", trimmed);
      return task.id;
    },

    create(input) {
      const id = core.write((fx) => {
        const project = deps.projects.get(input.projectId);
        const actor = input.actor ?? "user";
        const hasSteps = (input.plan?.phases ?? []).some((p) => p.steps.length > 0);
        const now = nowIso();
        const status = hasSteps ? "planned" : "idea";
        const task: TaskRecord = {
          id: randomUUID(),
          number: repos.tasks.nextNumber(),
          projectId: project.id,
          title: input.title,
          description: input.description ?? null,
          planContext: null,
          status,
          position: positionAmong(repos.tasks.lane(project.id, status), {}),
          archivedAt: null,
          createdBy: actor,
          createdAt: now,
          updatedAt: now,
          statusChangedAt: now,
        };
        repos.tasks.insert(task);
        fx.log(task.id, actor, "created", { status });
        if (input.plan) deps.plans().replacePlan(task, input.plan, actor, fx);
        for (const link of input.links ?? []) deps.links().add(task.id, link, actor);
        return task.id;
      });
      return service.detail(id);
    },

    update(id, input, actor) {
      core.write((fx) => {
        const current = record(id);
        const now = nowIso();
        const next: TaskRecord = { ...current, updatedAt: now };
        const changed: string[] = [];
        if (input.title !== undefined && input.title !== current.title) {
          next.title = input.title;
          changed.push("title");
        }
        if (input.description !== undefined && input.description !== current.description) {
          next.description = input.description;
          changed.push("description");
        }
        if (input.planContext !== undefined && input.planContext !== current.planContext) {
          next.planContext = input.planContext;
          changed.push("planContext");
        }
        if (input.projectId !== undefined && input.projectId !== current.projectId) {
          const project = deps.projects.get(input.projectId);
          next.projectId = project.id;
          next.position = endOfLane(next);
          fx.log(id, actor, "moved_project", { from: current.projectId, to: project.id });
        }
        if (input.archived !== undefined && input.archived !== (current.archivedAt !== null)) {
          next.archivedAt = input.archived ? now : null;
          if (!input.archived) next.position = endOfLane(next);
          fx.log(id, actor, input.archived ? "archived" : "unarchived");
        }
        repos.tasks.update(next);
        if (changed.length > 0) fx.log(id, actor, "updated", { fields: changed });
        fx.task(id);
      });
      return service.detail(id);
    },

    move(id, input, actor) {
      core.write((fx) => {
        const current = record(id);
        const status = input.status ?? current.status;
        const statusChanged = status !== current.status;
        if (statusChanged && status !== "idea" && repos.plans.countSteps(id) === 0) {
          throw planRequired(current.number);
        }
        if (!statusChanged && !input.beforeId && !input.afterId) return;
        if (input.beforeId === id || input.afterId === id) {
          throw new AppError("VALIDATION", "A task cannot be placed relative to itself");
        }
        const lane = repos.tasks.lane(current.projectId, status).filter((t) => t.id !== id);
        const now = nowIso();
        repos.tasks.update({
          ...current,
          status,
          position: positionAmong(lane, input),
          updatedAt: now,
          statusChangedAt: statusChanged ? now : current.statusChangedAt,
        });
        if (statusChanged) fx.log(id, actor, "status_changed", { from: current.status, to: status });
        else fx.task(id);
      });
      return service.summary(id);
    },

    addNote(id, text, actor) {
      const body = text.trim();
      if (!body) throw new AppError("VALIDATION", "Note text must not be empty");
      return core.write((fx) => {
        const task = record(id);
        const now = nowIso();
        repos.tasks.update({ ...task, updatedAt: now });
        fx.task(id);
        return repos.events.append(id, now, actor, "note", { text: body });
      });
    },
  };

  return { service, record };
}
