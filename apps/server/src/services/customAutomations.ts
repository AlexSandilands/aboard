import { randomUUID } from "node:crypto";
import {
  bundleToDefinition,
  checkCustomDefinition,
  CUSTOM_NAME_MAX,
  ImportAutomationInput,
  parseAutomationBundle,
  customAutomationKey,
  epicArmKey,
  CreateCustomAutomationInput,
  normalizeLabels,
  TaskStatus,
  UpdateCustomAutomationInput,
  type BundleSkill,
  type CustomAutomation,
  type CustomDefinition,
  type ImportedAutomation,
  type InstalledSkill,
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
  /**
   * Saves an automation from a shared file, switched off like any new one: its inputs and slots filled in as given,
   * restricted to `projectIds`, under a free name ("Name (2)" when taken). The skill in the file is written with
   * `installSkill` only when the importer asked for it, and the automation names the name it got. Throws VALIDATION
   * for a file that isn't one, is from a newer version or doesn't make a definition that can run.
   */
  importBundle(input: ImportAutomationInput, installSkill?: (skill: BundleSkill) => InstalledSkill): ImportedAutomation;
  /** A changed trigger or filters arm it again, so events before the change don't fire. */
  update(id: string, input: UpdateCustomAutomationInput): CustomAutomation;
  /** Its switches go with it; its runs stay as history. */
  delete(id: string): void;
  /**
   * Ignores events before now in these scopes (project ids, or `epicArmKey(epicId)`): the automation was just
   * switched on there, or Autopilot resumed. Other scopes keep events they haven't acted on yet (held for quiet hours
   * or a cap).
   */
  rearm(id: string, scopeKeys: readonly string[]): void;
  /**
   * These epics now have a setting of their own, so their tasks no longer read the project's arming time. Carry it
   * over to the epic (the later of the project's and any the epic has), so an epic that was already on keeps the
   * same floor: neither older events (from before the project was switched on) nor newer (dropping held ones).
   */
  inheritEpicArming(id: string, epicIds: readonly string[]): void;
  /**
   * When each of these tasks or epics last changed scope: moved project, moved epic, or was archived or unarchived. Events before
   * then happened outside the scope the automation is looking at now.
   */
  scopeChangedAt(ids: readonly string[]): Map<string, string>;
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

  /** Saves a checked definition as a new automation, armed from now. */
  const insert = (def: CustomDefinition): CustomAutomation =>
    core.write((fx) => {
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

  /** The name, or "Name (2)", "Name (3)" ... when taken, cut to fit. */
  const freeName = (name: string): string => {
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? "" : ` (${n})`;
      const candidate = `${name.slice(0, CUSTOM_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
      if (!repos.autopilotCustom.byName(candidate)) return candidate;
    }
  };

  return {
    list: () => repos.autopilotCustom.all(),

    get,

    create: (input) => insert(CreateCustomAutomationInput.parse(input)),

    importBundle(input, installSkill) {
      const { bundle: file, inputs, slots, projectIds, installSkill: wantSkill } = ImportAutomationInput.parse(input);
      const parsed = parseAutomationBundle(file);
      if (!parsed.ok) throw new AppError("VALIDATION", parsed.error);
      const { bundle } = parsed;
      const fill = { inputs, slots, projectIds };
      const named = (skill?: string | null) =>
        CreateCustomAutomationInput.parse({
          ...bundleToDefinition(bundle, { ...fill, ...(skill === undefined ? {} : { skill }) }),
          name: freeName(bundle.name),
        });
      // Check everything before writing a skill, so a file that can't run leaves nothing behind.
      checked(named(bundle.skill?.name));
      const installed = bundle.skill && wantSkill && installSkill ? installSkill(bundle.skill) : null;
      return { automation: insert(named(installed?.name)), skill: installed };
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
        // A schedule has no task, so epics have no say: drop their switches rather than leave them hidden, to come back
        // if the trigger changes again.
        if (def.trigger.kind === "schedule") {
          const key = customAutomationKey(id);
          for (const s of repos.autopilotSettings.all()) {
            if (s.scopeKind === "epic" && s.automation === key) repos.autopilotSettings.delete("epic", s.scopeId, key);
          }
        }
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

    rearm(id, scopeKeys) {
      if (scopeKeys.length === 0) return;
      core.write((fx) => {
        const current = repos.autopilotCustom.get(id);
        if (!current) return;
        const now = nowIso();
        const armedProjects = { ...current.armedProjects };
        for (const key of scopeKeys) armedProjects[key] = now;
        repos.autopilotCustom.update({ ...current, armedProjects });
        fx.autopilot();
      });
    },

    inheritEpicArming(id, epicIds) {
      core.write(() => {
        const current = repos.autopilotCustom.get(id);
        if (!current) return;
        const armedProjects = { ...current.armedProjects };
        let changed = false;
        for (const epicId of epicIds) {
          const epic = repos.tasks.get(epicId);
          const inherited = epic ? armedProjects[epic.projectId] : undefined;
          const own = armedProjects[epicArmKey(epicId)];
          if (inherited && (!own || Date.parse(inherited) > Date.parse(own))) {
            armedProjects[epicArmKey(epicId)] = inherited;
            changed = true;
          }
        }
        if (changed) repos.autopilotCustom.update({ ...current, armedProjects });
      });
    },

    scopeChangedAt(ids) {
      return new Map(
        // `archived` matters for an epic: once archived it no longer counts, and its tasks follow the project.
        repos.events
          .latestOfType(ids, ["epic_changed", "moved_project", "unarchived", "archived"])
          .map((e) => [e.taskId, e.at]),
      );
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
