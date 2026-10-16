import {
  deriveEpicRollup,
  deriveEpicStatus,
  findJiraKeys,
  normalizeLabel,
  parseIssueSource,
  renderTemplateText,
  resolutionNeedsTask,
  templateHasPlan,
  type PlanInput,
  type TaskDetail,
  type TaskSummary,
} from "@repo/contracts";
import { randomUUID } from "node:crypto";
import { nowIso } from "../db/database.ts";
import type { Repos } from "../db/repos/index.ts";
import type { TaskRecord } from "../db/repos/tasks.ts";
import { AppError, notFound, planRequired } from "../errors.ts";
import { positionAmong, type Core, type Effects } from "./core.ts";
import { withSuggestedModel, type PlansModule } from "./plans.ts";
import { assembleSummaries, taskRef, type AssembledTask } from "./summaries.ts";
import type { ImportsModule } from "./imports.ts";
import type { LabelsModule } from "./labels.ts";
import type { LinksModule } from "./links.ts";
import type { RelationsModule } from "./relations.ts";
import type {
  CloseInput,
  ProjectsService,
  ReviewsService,
  SettingsService,
  TaskQuery,
  TasksService,
  TemplatesService,
} from "./types.ts";

const DETAIL_EVENT_LIMIT = 100;
const EPIC_AUTOPILOT_MESSAGE = "An epic isn't started by Autopilot; flag its tasks instead";

/** Case-insensitive text match over title, description, "#number", Jira keys and labels. */
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
    ...summary.labels,
  ];
  return haystack.some((text) => text.toLowerCase().includes(q));
}

/**
 * Re-derives an epic's status from its children (see deriveEpicStatus) and marks its card changed, since the
 * roll-up may have moved. Call inside the write after any change to a child's status, epic, project or archive
 * state. A no-op for an id that isn't an epic.
 */
export function syncEpicStatus(repos: Repos, epicId: string, actor: string, fx: Effects): void {
  const epic = repos.tasks.get(epicId);
  if (!epic || epic.kind !== "epic") return;
  fx.task(epicId);
  const children = repos.tasks.childrenOf([epicId]).filter((c) => c.archivedAt === null);
  const status = deriveEpicStatus(deriveEpicRollup(children));
  if (status === epic.status) return;
  const now = nowIso();
  const lane = repos.tasks.lane(epic.projectId, status).filter((t) => t.id !== epic.id);
  repos.tasks.update({ ...epic, status, position: positionAmong(lane, {}), updatedAt: now, statusChangedAt: now });
  fx.log(epicId, actor, "status_changed", { from: epic.status, to: status, fromChildren: true });
}

/** Task cards: creation, updates, moves between columns, notes. */
export function createTasksService(
  core: Core,
  deps: {
    projects: ProjectsService;
    plans: () => PlansModule;
    links: () => LinksModule;
    reviews: () => ReviewsService;
    labels: LabelsModule;
    settings: SettingsService;
    imports: () => ImportsModule;
    templates: TemplatesService;
    relations: () => RelationsModule;
  },
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

  // A key in the title is a strong signal, so it is linked outright. Keys in a description are only
  // hinted at (mcp/format.ts), since prose there gives too many false positives. links.add is idempotent.
  const linkTitleKeys = (taskId: string, title: string, actor: string): void => {
    for (const key of findJiraKeys(title)) deps.links().service.add(taskId, { value: key }, actor);
  };

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

  /** The epic `ref` names, checked as a home for a task in `projectId`. */
  const epicFor = (ref: string, projectId: string): TaskRecord => {
    const epic = record(service.resolveId(ref));
    if (epic.kind !== "epic") throw new AppError("VALIDATION", `#${epic.number} is not an epic`);
    if (epic.archivedAt !== null)
      throw new AppError("VALIDATION", `Epic #${epic.number} is archived; unarchive it first`);
    if (epic.projectId !== projectId) {
      throw new AppError(
        "VALIDATION",
        `Epic #${epic.number} is in another project; a task and its epic share a project`,
      );
    }
    return epic;
  };

  const syncEpic = (epicId: string, actor: string, fx: Effects): void => syncEpicStatus(repos, epicId, actor, fx);

  /** Logs a task joining or leaving an epic on both sides. The caller saves the task and syncs both epics. */
  const logEpicChange = (
    task: TaskRecord,
    from: TaskRecord | null,
    to: TaskRecord | null,
    actor: string,
    fx: Effects,
  ) => {
    fx.log(task.id, actor, "epic_changed", { from: from?.number ?? null, to: to?.number ?? null });
    if (from) fx.log(from.id, actor, "child_removed", { task: task.number, title: task.title });
    if (to) fx.log(to.id, actor, "child_added", { task: task.number, title: task.title });
  };

  const service: TasksService = {
    summaries(query: TaskQuery = {}): TaskSummary[] {
      const records = repos.tasks.list(query);
      // A filter, not a label list: no cap, and a term that normalises to nothing just matches nothing.
      const labels = query.labels?.length ? query.labels.map(normalizeLabel) : null;
      return [...assembleSummaries(repos, records).values()]
        .filter((t) => !query.query || matchesQuery(t, query.query))
        .filter((t) => !labels || t.summary.labels.some((l) => labels.includes(l)))
        .filter((t) => !query.attentionOnly || t.summary.attention.length > 0)
        .filter((t) => !query.epicId || t.record.parentId === query.epicId)
        .map((t) => t.summary);
    },

    summary: (id) => assembleOne(id).summary,

    detail(id): TaskDetail {
      const { record: task, summary, phases, reviews } = assembleOne(id);
      return {
        ...summary,
        description: task.description,
        planContext: task.planContext,
        phases,
        events: repos.events.recent(id, DETAIL_EVENT_LIMIT),
        children:
          task.kind === "epic"
            ? [...assembleSummaries(repos, repos.tasks.childrenOf([id])).values()].map((c) => c.summary)
            : [],
        resolves: repos.tasks
          .resolvedBy([id])
          .flatMap((t) => (t.resolution ? [{ ...taskRef(t)!, resolution: t.resolution }] : [])),
        reviews,
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
        const kind = input.kind ?? "task";
        if (kind === "epic" && input.plan) {
          throw new AppError("VALIDATION", "An epic has no plan; create its child tasks with plans instead");
        }
        if (kind === "epic" && input.epicId) throw new AppError("VALIDATION", "Epics don't nest; an epic has no epic");
        if (kind === "epic" && input.autopilot != null) throw new AppError("VALIDATION", EPIC_AUTOPILOT_MESSAGE);
        if (kind === "epic" && input.sourceUrl) {
          throw new AppError("VALIDATION", "An epic can't be imported from an issue; give it a title");
        }
        if (kind === "epic" && input.template) {
          throw new AppError("VALIDATION", "An epic can't be made from a template; its tasks can");
        }
        const epic = input.epicId ? epicFor(input.epicId, project.id) : null;
        const source = input.sourceUrl ? parseIssueSource(input.sourceUrl, deps.settings.get()) : null;
        if (input.sourceUrl && !source) {
          throw new AppError("VALIDATION", `Not a Jira issue key or URL, or a GitHub issue URL: ${input.sourceUrl}`);
        }
        if (source && input.plan)
          throw new AppError("VALIDATION", "A task imported from an issue can't start with a plan");
        const template = input.template ? deps.templates.resolve(input.template, project.id) : null;
        const templatePlan = template && !input.plan && templateHasPlan(template);
        if (source && templatePlan) {
          throw new AppError(
            "VALIDATION",
            `Template "${template.name}" has a plan, and a task imported from an issue can't start with one`,
          );
        }
        // What the template fills in is rendered once, here, and copied: the task never reads the template again.
        const context = { date: new Date(), project: project.title };
        const fromPattern = template ? renderTemplateText(template.titlePattern, context).trim() : "";
        const title = input.title ?? source?.placeholder ?? (fromPattern || undefined);
        if (!title) {
          throw new AppError(
            "VALIDATION",
            template
              ? `A task needs a title; template "${template.name}" has no title pattern`
              : "A task needs a title",
          );
        }
        // An imported task takes its description from the issue, and only while it is still empty.
        // A description given, even a blank one, is explicit: blank means none, not "use the template's".
        const description =
          input.description !== undefined
            ? input.description.trim()
              ? input.description
              : undefined
            : source || !template?.description
              ? undefined
              : renderTemplateText(template.description, context);
        const plan: PlanInput | undefined =
          input.plan ??
          (templatePlan
            ? {
                ...(template.planContext ? { context: template.planContext } : {}),
                ...(template.suggestedTier ? { suggestedModel: { tier: template.suggestedTier } } : {}),
                phases: template.phases.map((phase) => ({
                  title: phase.title,
                  steps: phase.steps.map((step) => ({
                    title: step.title,
                    ...(step.notes ? { notes: step.notes } : {}),
                  })),
                })),
              }
            : undefined);
        const hasSteps = (plan?.phases ?? []).some((p) => p.steps.length > 0);
        const now = nowIso();
        const status = input.status ?? (input.plan && hasSteps ? "planned" : "backlog");
        if (status === "planned" && !hasSteps) {
          throw new AppError(
            "VALIDATION",
            "A planned task needs a plan; give one, or start from a template that has one",
          );
        }
        const task: TaskRecord = {
          id: randomUUID(),
          number: repos.tasks.nextNumber(),
          projectId: project.id,
          kind,
          parentId: epic?.id ?? null,
          title,
          description: description ?? null,
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
          autoReview: null,
          autopilot: input.autopilot ?? null,
          suggestedModel: null,
          templateId: template?.id ?? null,
        };
        repos.tasks.insert(task);
        fx.log(task.id, actor, "created", {
          status,
          ...(template ? { template: template.name } : {}),
          ...(kind === "epic" ? { kind } : {}),
          ...(epic ? { epic: epic.number } : {}),
        });
        if (epic) {
          fx.log(epic.id, actor, "child_added", { task: task.number, title: task.title });
          syncEpic(epic.id, actor, fx);
        }
        const labels = input.labels ?? template?.labels;
        if (labels?.length) deps.labels.setIn(task.id, labels, actor, fx);
        if (plan) deps.plans().replacePlan(task, plan, actor, fx);
        if (input.blockedBy?.length) deps.relations().addBlockersIn(task.id, input.blockedBy, actor, fx);
        if (source) {
          deps.links().service.add(task.id, { value: source.url }, actor);
          deps.imports().beginIn(task.id, source, input.sourceUrl!, fx);
        }
        for (const link of input.links ?? []) deps.links().service.add(task.id, link, actor);
        linkTitleKeys(task.id, task.title, actor);
        return task.id;
      });
      return service.detail(id);
    },

    createEpic(input, taskIds, actor) {
      // One write, so a task that can't join doesn't leave a half-filled epic behind.
      const id = core.write(() => {
        const epic = service.create({ ...input, kind: "epic", actor });
        for (const taskId of taskIds) service.update(taskId, { epicId: epic.id }, actor);
        return epic.id;
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
          // An epic's tasks show its title on their cards and in their panels.
          if (current.kind === "epic") for (const child of repos.tasks.childrenOf([id])) fx.task(child.id);
        }
        if (input.description !== undefined && input.description !== current.description) {
          next.description = input.description;
          changed.push("description");
        }
        if (input.planContext !== undefined && input.planContext !== current.planContext) {
          next.planContext = input.planContext;
          changed.push("planContext");
        }
        if (input.autoReview !== undefined && input.autoReview !== current.autoReview) {
          next.autoReview = input.autoReview;
          changed.push("autoReview");
        }
        if (current.kind === "epic" && input.autopilot != null)
          throw new AppError("VALIDATION", EPIC_AUTOPILOT_MESSAGE);
        if (input.autopilot !== undefined && input.autopilot !== current.autopilot) {
          next.autopilot = input.autopilot;
          changed.push("autopilot");
        }
        const movedProject = input.projectId !== undefined && input.projectId !== current.projectId;
        if (movedProject) {
          const project = deps.projects.get(input.projectId!);
          next.projectId = project.id;
          next.position = endOfLane(next);
          fx.log(id, actor, "moved_project", { from: current.projectId, to: project.id });
        }
        if (input.epicId && current.kind === "epic") {
          throw new AppError("VALIDATION", "Epics don't nest; an epic has no epic");
        }
        // A task and its epic share a project, so a task moved elsewhere leaves its epic unless given one there.
        const parentId =
          input.epicId !== undefined
            ? input.epicId && epicFor(input.epicId, next.projectId).id
            : movedProject
              ? null
              : current.parentId;
        if (parentId !== current.parentId) {
          next.parentId = parentId;
          const from = current.parentId ? record(current.parentId) : null;
          logEpicChange(next, from, parentId ? record(parentId) : null, actor, fx);
        }
        if (input.archived !== undefined && input.archived !== (current.archivedAt !== null)) {
          // An archived epic leaves the board, so its open tasks would show loose while still claiming it.
          if (input.archived && current.kind === "epic") {
            const open = repos.tasks.childrenOf([id]).filter((c) => c.archivedAt === null && c.status !== "done");
            if (open.length > 0) {
              throw new AppError(
                "VALIDATION",
                `Epic #${current.number} still has open tasks (${open.map((c) => `#${c.number}`).join(", ")}). ` +
                  "Finish, close or archive them, or take them out of the epic, before archiving it.",
              );
            }
          }
          next.archivedAt = input.archived ? now : null;
          if (!input.archived) next.position = endOfLane(next);
          fx.log(id, actor, input.archived ? "archived" : "unarchived");
        }
        repos.tasks.update(withSuggestedModel(next, input.suggestedModel, actor, fx));
        // An epic takes its children along, since they must share its project.
        if (movedProject && current.kind === "epic") {
          for (const child of repos.tasks.childrenOf([id])) {
            repos.tasks.update({
              ...child,
              projectId: next.projectId,
              position: endOfLane({ ...child, projectId: next.projectId }),
              updatedAt: now,
            });
            fx.log(child.id, actor, "moved_project", {
              from: current.projectId,
              to: next.projectId,
              withEpic: current.number,
            });
          }
        }
        const archivedChanged = next.archivedAt !== current.archivedAt;
        if (current.parentId && (current.parentId !== next.parentId || archivedChanged)) {
          syncEpic(current.parentId, actor, fx);
        }
        if (next.parentId && (next.parentId !== current.parentId || archivedChanged))
          syncEpic(next.parentId, actor, fx);
        if (input.labels !== undefined) deps.labels.setIn(id, input.labels, actor, fx);
        // Removals first, so one call can swap a blocker.
        if (input.removeBlockedBy?.length) deps.relations().removeBlockersIn(id, input.removeBlockedBy, actor, fx);
        if (input.addBlockedBy?.length) deps.relations().addBlockersIn(id, input.addBlockedBy, actor, fx);
        if (changed.length > 0) fx.log(id, actor, "updated", { fields: changed });
        if (changed.includes("title")) linkTitleKeys(id, next.title, actor);
        fx.task(id);
      });
      return service.detail(id);
    },

    move(id, input, actor, because) {
      core.write((fx) => {
        const current = record(id);
        const status = input.status ?? current.status;
        const statusChanged = status !== current.status;
        if (statusChanged && current.kind === "epic") {
          throw new AppError(
            "VALIDATION",
            `#${current.number} is an epic; its status follows its child tasks, so move those instead`,
          );
        }
        if (statusChanged && status !== "backlog" && repos.plans.countSteps(id) === 0) {
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
          // A merge seen before the task reached Review was used up then; finish it now. Coming back from Done
          // is a deliberate reopen, so it stays put. The follow-up is its own move, logged as "github".
          if (status === "review" && current.status !== "done") deps.links().completeIfPrsDone(id);
          // Still in Review (not completed by a merged PR just now): with auto-review on, a reviewer is due.
          if (status === "review" && record(id).status === "review" && deps.reviews().effectiveAutoReview(id)) {
            deps.reviews().openRoundIn(id, { trigger: "move", actor }, fx);
          }
          if (current.parentId) syncEpic(current.parentId, actor, fx);
        } else fx.task(id);
      });
      return service.summary(id);
    },

    close(id, input: CloseInput, actor) {
      core.write((fx) => {
        const current = record(id);
        if (current.kind === "epic") {
          throw new AppError("VALIDATION", `#${current.number} is an epic; it is done once its child tasks are`);
        }
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
        if (current.parentId) syncEpic(current.parentId, actor, fx);
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
        // Its children stay as loose tasks (parent_id is SET NULL); their log records which epic they were in.
        for (const child of repos.tasks.childrenOf([id])) {
          fx.log(child.id, actor, "epic_changed", { from: task.number, to: null, epicDeleted: true });
        }
        // Tasks it blocks, or that block it, drop the relation with it; their logs say what went.
        deps.relations().noteDeletionIn(task, actor, fx);
        repos.tasks.delete(id);
        fx.taskDeleted(id);
        if (task.parentId) {
          fx.log(task.parentId, actor, "child_removed", { task: task.number, title: task.title, deleted: true });
          syncEpic(task.parentId, actor, fx);
        }
      });
    },
  };

  return { service, record };
}
