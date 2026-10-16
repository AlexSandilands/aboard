import { randomUUID } from "node:crypto";
import {
  checkCustomDefinition,
  CreateCustomAutomationInput,
  normalizeLabels,
  TaskStatus,
  UpdateCustomAutomationInput,
  type CustomAutomation,
  type CustomDefinition,
} from "@repo/contracts";
import { nowIso } from "../db/database.ts";
import { AppError, notFound } from "../errors.ts";
import type { Core } from "./core.ts";

/**
 * The automations the user defines (docs/features/autopilot.md#custom-automations). Each is a catalogue entry
 * `custom:<id>`; its switches are ordinary Autopilot settings. Edited over REST only, never MCP.
 */
export interface CustomAutomationsService {
  /** Oldest first. */
  list(): CustomAutomation[];
  get(id: string): CustomAutomation;
  /** Throws VALIDATION for a definition that can't run, NOT_FOUND for an unknown project or epic, CONFLICT for a name taken. */
  create(input: CreateCustomAutomationInput): CustomAutomation;
  /** A changed trigger or filters arm it again, so events before the change don't fire. */
  update(id: string, input: UpdateCustomAutomationInput): CustomAutomation;
  /** Its switches go with it; its runs stay as history. */
  delete(id: string): void;
  /**
   * Ignores events before now in these projects: the automation was just switched on there, or Autopilot resumed.
   * Other projects keep events they haven't acted on yet (held for quiet hours or a cap).
   */
  rearm(id: string, projectIds: readonly string[]): void;
  /** The column each task last moved from, for status-change triggers with a `from`. */
  statusFrom(taskIds: readonly string[]): Map<string, TaskStatus | null>;
}

export function createCustomAutomationsService(core: Core): CustomAutomationsService {
  const { repos } = core;

  const get = (id: string): CustomAutomation => {
    const custom = repos.autopilotCustom.get(id);
    if (!custom) throw notFound("Custom automation", id);
    return custom;
  };

  /** Normalises and checks a definition, throwing what's wrong with it. */
  const checked = (def: CustomDefinition, selfId?: string): CustomDefinition => {
    let labels: string[];
    try {
      labels = normalizeLabels(def.filters.labels);
    } catch (error) {
      throw new AppError("VALIDATION", (error as Error).message);
    }
    const next = { ...def, filters: { ...def.filters, labels } };
    const problem = checkCustomDefinition(next);
    if (problem) throw new AppError("VALIDATION", problem);
    for (const projectId of next.filters.projectIds) {
      if (!repos.projects.get(projectId)) throw notFound("Project", projectId);
    }
    if (next.filters.epicId) {
      const epic = repos.tasks.get(next.filters.epicId);
      if (!epic || epic.kind !== "epic") throw notFound("Epic", next.filters.epicId);
    }
    const taken = repos.autopilotCustom.byName(next.name);
    if (taken && taken.id !== selfId) {
      throw new AppError("CONFLICT", `There is already a custom automation called "${taken.name}"`);
    }
    return next;
  };

  return {
    list: () => repos.autopilotCustom.all(),

    get,

    create(input) {
      const def = CreateCustomAutomationInput.parse(input);
      return core.write((fx) => {
        const now = nowIso();
        const custom: CustomAutomation = {
          id: randomUUID(),
          ...checked(def),
          armedAt: now,
          armedProjects: {},
          createdAt: now,
          updatedAt: now,
        };
        repos.autopilotCustom.insert(custom);
        fx.autopilot();
        return custom;
      });
    },

    update(id, input) {
      const patch = UpdateCustomAutomationInput.parse(input);
      return core.write((fx) => {
        const current = get(id);
        const def = checked(
          {
            name: patch.name ?? current.name,
            trigger: patch.trigger ?? current.trigger,
            filters: patch.filters ?? current.filters,
            action: patch.action ?? current.action,
          },
          id,
        );
        const now = nowIso();
        // Under another trigger, or over tasks it didn't cover, what happened before isn't what the user asked to act
        // on.
        const rearmed =
          JSON.stringify(def.trigger) !== JSON.stringify(current.trigger) ||
          JSON.stringify(def.filters) !== JSON.stringify(current.filters);
        const next: CustomAutomation = {
          ...current,
          ...def,
          ...(rearmed ? { armedAt: now, armedProjects: {} } : {}),
          updatedAt: now,
        };
        repos.autopilotCustom.update(next);
        fx.autopilot();
        return next;
      });
    },

    delete(id) {
      core.write((fx) => {
        get(id);
        // The table's trigger deletes its settings rows.
        repos.autopilotCustom.delete(id);
        fx.autopilot();
      });
    },

    rearm(id, projectIds) {
      if (projectIds.length === 0) return;
      core.write((fx) => {
        const current = repos.autopilotCustom.get(id);
        if (!current) return;
        const now = nowIso();
        const armedProjects = { ...current.armedProjects };
        for (const projectId of projectIds) armedProjects[projectId] = now;
        repos.autopilotCustom.update({ ...current, armedProjects });
        fx.autopilot();
      });
    },

    statusFrom(taskIds) {
      return new Map(
        // Closing a task moves it to Done with a `closed` event, which carries `from` too.
        repos.events.latestOfType(taskIds, ["status_changed", "closed"]).map((e) => {
          const from = TaskStatus.safeParse(e.payload.from);
          return [e.taskId, from.success ? from.data : null];
        }),
      );
    },
  };
}
