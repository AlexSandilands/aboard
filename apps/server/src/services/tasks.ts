import { resolutionNeedsTask, type TaskDetail, type TaskSummary } from "@repo/contracts";
import { randomUUID } from "node:crypto";
import { nowIso } from "../db/database.ts";
import type { TaskRecord } from "../db/repos/tasks.ts";
import { AppError, notFound, planRequired } from "../errors.ts";
import { positionAmong, type Core } from "./core.ts";
import type { PlansModule } from "./plans.ts";
import { assembleSummaries, taskRef, type AssembledTask } from "./summaries.ts";
import type { CloseInput, LinksService, ProjectsService, TaskQuery, TasksService } from "./types.ts";

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

  /** Validates the resolution/by-task pairing for `close` and returns the by-task, if any. */
  const closingTask = (task: TaskRecord, input: CloseInput): TaskRecord | null => {
    if (!resolutionNeedsTask(input.resolution)) {
      if (input.byTaskId) throw new AppError("VALIDATION", "A task closed as won't do cannot point at another task");
      return null;
    }
    if (!input.byTaskId) {
      throw new AppError("VALIDATION", `Closing as ${input.resolution} needs the task that delivered it`);
    }
    const by = record(input.byTaskId);
    if (by.id === task.id) throw new AppError("VALIDATION", "A task cannot be resolved by itself");
    // Two tasks closed against each other would leave neither as the one that holds the work.
    if (by.resolvedByTaskId === task.id) {
      throw new AppError("VALIDATION", `#${by.number} is already closed against #${task.number}; reopen it first`);
    }
    return by;
  };

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
        resolves: repos.tasks
          .resolvedBy([id])
          .flatMap((t) => (t.resolution ? [{ ...taskRef(t)!, resolution: t.resolution }] : [])),
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
          resolution: null,
          resolvedByTaskId: null,
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
          // Cards of tasks this one resolved show its title, and so does the "Also resolved" list of its resolver.
          for (const resolved of repos.tasks.resolvedBy([id])) fx.task(resolved.id);
          if (current.resolvedByTaskId) fx.detail(current.resolvedByTaskId);
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

    move(id, input, actor, because) {
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
        // Reopening a closed task drops its resolution, so it reads as open work again.
        const reopened = statusChanged && current.resolution !== null;
        repos.tasks.update({
          ...current,
          status,
          position: positionAmong(lane, input),
          updatedAt: now,
          statusChangedAt: statusChanged ? now : current.statusChangedAt,
          ...(reopened ? { resolution: null, resolvedByTaskId: null } : {}),
        });
        if (reopened && current.resolvedByTaskId) fx.detail(current.resolvedByTaskId);
        if (statusChanged) {
          fx.log(id, actor, "status_changed", {
            ...because,
            from: current.status,
            to: status,
            ...(reopened ? { clearedResolution: current.resolution } : {}),
          });
        } else fx.task(id);
      });
      return service.summary(id);
    },

    close(id, input: CloseInput, actor) {
      core.write((fx) => {
        const current = record(id);
        const by = closingTask(current, input);
        const now = nowIso();
        const statusChanged = current.status !== "done";
        repos.tasks.update({
          ...current,
          status: "done",
          position: statusChanged ? endOfLane({ ...current, status: "done" }) : current.position,
          updatedAt: now,
          statusChangedAt: statusChanged ? now : current.statusChangedAt,
          resolution: input.resolution,
          resolvedByTaskId: by?.id ?? null,
        });
        fx.log(id, actor, "closed", {
          resolution: input.resolution,
          from: current.status,
          ...(by ? { byTask: by.number } : {}),
        });
        if (by) fx.detail(by.id);
        if (current.resolvedByTaskId && current.resolvedByTaskId !== by?.id) fx.detail(current.resolvedByTaskId);
      });
      return service.detail(id);
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

    delete(id, actor) {
      core.write((fx) => {
        const task = record(id);
        if (task.archivedAt === null) {
          throw new AppError(
            "VALIDATION",
            `Archive #${task.number} before deleting it; only archived tasks can be deleted`,
          );
        }
        // Tasks closed against this one keep their resolution; their log records what they pointed at.
        for (const resolved of repos.tasks.resolvedBy([id])) {
          fx.log(resolved.id, actor, "resolver_deleted", { number: task.number, title: task.title });
        }
        if (task.resolvedByTaskId) fx.detail(task.resolvedByTaskId);
        repos.tasks.delete(id);
        fx.taskDeleted(id);
      });
    },
  };

  return { service, record };
}
