import { randomUUID } from "node:crypto";
import {
  actionScripts,
  AUTOMATION_DRAFT_TTL_DAYS,
  AUTOMATION_DRAFTS_MAX,
  ApplyAutomationDraftInput,
  bundleToDefinition,
  checkAutomationDraft,
  DraftAutomationInput,
  checkCustomDefinition,
  CUSTOM_NAME_MAX,
  ImportAutomationInput,
  parseAutomationBundle,
  customAutomationId,
  customAutomationKey,
  epicArmKey,
  CreateCustomAutomationInput,
  normalizeLabels,
  TaskStatus,
  UpdateCustomAutomationInput,
  type AutomationDraft,
  type AutomationVariable,
  type BundleSkill,
  variableHasValue,
  variablesNamedBy,
  type CustomAutomation,
  type CustomDefinition,
  type ImportedAutomation,
  type InstalledSkill,
  type TaskSummary,
  type TestScriptInput,
  type TestScriptResult,
} from "@repo/contracts";
import { nowIso } from "../db/database.ts";
import { AppError, notFound } from "../errors.ts";
import type { RepoUrls } from "../integrations/gitRemote.ts";
import type { RunScript } from "../integrations/scriptRunner.ts";
import type { Core } from "./core.ts";
import type { NotificationsService } from "./notifications.ts";
import { createTestScript } from "./testScript.ts";

/**
 * The automations the user defines (docs/features/autopilot.md#custom-automations). Each is a catalogue entry
 * `custom:<id>`; its switches are ordinary Autopilot settings. Edited over REST only; over MCP an agent can only
 * draft one, which the user imports.
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
  /**
   * Keeps an automation an agent drafted for the user to review and import (docs/features/autopilot.md#drafts). Saves
   * no automation: only the user's import does. Throws VALIDATION listing every problem, so the agent can fix them all.
   */
  draft(input: DraftAutomationInput, createdBy: string): AutomationDraft;
  /** The drafts waiting, newest first; expired ones are left out. */
  drafts(): AutomationDraft[];
  /** Throws NOT_FOUND once it has expired or was imported or dismissed. */
  getDraft(id: string): AutomationDraft;
  dismissDraft(id: string): void;
  /**
   * Applies a draft that replaces a custom automation: the automation takes the draft's definition in place, keeping
   * its id, switches, projects, epic and run history. Inputs and slots keep their current values unless given. Deletes
   * the draft. Throws VALIDATION for a draft that makes a new automation or changes a script not confirmed, NOT_FOUND
   * when the draft or its automation is gone.
   */
  applyDraft(
    id: string,
    input: ApplyAutomationDraftInput,
    installSkill?: (skill: BundleSkill) => InstalledSkill,
  ): ImportedAutomation;
  /** A changed trigger or filters arm it again, so events before the change don't fire. */
  update(id: string, input: UpdateCustomAutomationInput): CustomAutomation;
  /** Its switches go with it; its runs stay as history. */
  delete(id: string): void;
  /**
   * Runs a draft script once, now, in a project's folder (it really executes: nothing about it is a dry run) and says
   * what it did. Nothing is saved. Throws NOT_FOUND for an unknown project or task, VALIDATION for a project with no
   * folder, CONFLICT while another test is running.
   */
  testScript(input: TestScriptInput): Promise<TestScriptResult>;
  /**
   * Ignores events before now in these scopes (project ids, or `epicArmKey(epicId)`): the automation was just
   * switched on there, or Autopilot resumed. Other scopes keep events they haven't acted on yet (held for quiet hours
   * or a cap).
   */
  rearm(id: string, scopeKeys: readonly string[]): void;
  /**
   * Variables changed: each automation that names one starts afresh in the projects (and their epics with an arming
   * of their own) that lacked one of its variables before and have them all now, so what happened while a value was
   * missing doesn't all fire at once. `before` and `after` are each project's effective variables.
   */
  rearmWhereFilled(
    before: ReadonlyMap<string, Record<string, string>>,
    after: ReadonlyMap<string, Record<string, string>>,
  ): void;
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

export function createCustomAutomationsService(
  core: Core,
  deps: {
    runScript: RunScript;
    taskSummary: (id: string) => TaskSummary;
    repoUrl: RepoUrls;
    boardVariables: () => readonly AutomationVariable[];
    notifications?: NotificationsService;
    /** The built-in automations, so a draft that tries to replace one is told it can't. */
    builtIn?: () => readonly { key: string; title: string }[];
  },
): CustomAutomationsService {
  const { repos } = core;
  const testScript = createTestScript({
    runScript: deps.runScript,
    project: (id) => repos.projects.get(id),
    task: deps.taskSummary,
    repoUrl: deps.repoUrl,
    boardVariables: deps.boardVariables,
  });

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

  /**
   * Saves a checked definition as a new automation, armed from now, in Preview for the board: it records what it
   * would do until the user turns it on (docs/features/autopilot.md#preview).
   */
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
      repos.autopilotSettings.upsert({
        scopeKind: "board",
        scopeId: null,
        automation: customAutomationKey(custom.id),
        mode: "preview",
        config: {},
        lastOnMode: "preview",
        updatedAt: now,
      });
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

  const unexpired = (draft: AutomationDraft | null): draft is AutomationDraft =>
    draft !== null && Date.parse(draft.expiresAt) > core.now().getTime();

  const getDraft = (id: string): AutomationDraft => {
    const draft = repos.autopilotDrafts.get(id);
    if (!unexpired(draft)) {
      throw new AppError("NOT_FOUND", "This draft is gone: it was imported or dismissed, or it expired");
    }
    return draft;
  };

  /** The custom automation a draft's `replaces` names: by id, `custom:<id>` key or name. Refuses a built-in one. */
  const replaced = (ref: string): CustomAutomation => {
    const id = customAutomationId(ref) ?? ref;
    const found = repos.autopilotCustom.get(id) ?? repos.autopilotCustom.byName(ref);
    if (found) return found;
    const builtIn = deps.builtIn?.().find((a) => a.key === ref || a.title.toLowerCase() === ref.toLowerCase());
    if (builtIn) {
      throw new AppError(
        "VALIDATION",
        `replaces names ${builtIn.title}, a built-in automation: a draft can only replace a custom one. Tell the user which of its settings to change instead.`,
      );
    }
    throw new AppError(
      "NOT_FOUND",
      `replaces: no custom automation "${ref}". Pass the id of a custom automation (custom:<id>) or its exact name, or leave replaces out to draft a new one.`,
    );
  };

  const service: CustomAutomationsService = {
    list: () => repos.autopilotCustom.all(),

    testScript,

    get,

    create: (input) => insert(CreateCustomAutomationInput.parse(input)),

    importBundle(input, installSkill) {
      const {
        bundle: file,
        inputs,
        slots,
        projectIds,
        installSkill: wantSkill,
        confirmScript,
        draftId,
      } = ImportAutomationInput.parse(input);
      const parsed = parseAutomationBundle(file);
      if (!parsed.ok) throw new AppError("VALIDATION", parsed.error);
      const { bundle } = parsed;
      // Here, not in the route, so nothing that imports can skip it: a script is someone else's code, run as the user.
      if (!confirmScript && actionScripts(bundle.action).length > 0) {
        throw new AppError(
          "VALIDATION",
          "This file runs a script on your machine as you. Read it and confirm (confirmScript) to import it",
        );
      }
      const fill = { inputs, slots, projectIds };
      const named = (skill?: string | null) =>
        CreateCustomAutomationInput.parse({
          ...bundleToDefinition(bundle, { ...fill, ...(skill === undefined ? {} : { skill }) }),
          name: freeName(bundle.name),
        });
      // Check everything before writing a skill, so a file that can't run leaves nothing behind.
      checked(named(bundle.skill?.name));
      const installed = bundle.skill && wantSkill && installSkill ? installSkill(bundle.skill) : null;
      const automation = insert(named(installed?.name));
      if (draftId) {
        core.write((fx) => {
          if (repos.autopilotDrafts.delete(draftId)) fx.autopilot();
        });
      }
      return { automation, skill: installed };
    },

    draft(input, createdBy) {
      const { automation, note, replaces } = DraftAutomationInput.parse(input);
      const target = replaces ? replaced(replaces) : null;
      const checkedDraft = checkAutomationDraft(automation);
      if (!checkedDraft.ok) {
        const { errors } = checkedDraft;
        throw new AppError(
          "VALIDATION",
          errors.length === 1
            ? `The automation can't be drafted: ${errors[0]}`
            : `The automation can't be drafted, ${errors.length} problems:\n${errors.map((e) => `- ${e}`).join("\n")}`,
        );
      }
      return core.write((fx) => {
        const now = core.now();
        const draft: AutomationDraft = {
          id: randomUUID(),
          bundle: checkedDraft.bundle,
          note,
          replaces: target?.id ?? null,
          createdBy,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + AUTOMATION_DRAFT_TTL_DAYS * 86_400_000).toISOString(),
        };
        repos.autopilotDrafts.insert(draft);
        // Pruned here rather than on a timer: nothing is added without passing through, and reads skip expired rows.
        repos.autopilotDrafts.prune(draft.createdAt, AUTOMATION_DRAFTS_MAX);
        deps.notifications?.notify({
          kind: "automation_draft",
          title: target ? `Change proposed to ${target.name}` : `Automation drafted: ${draft.bundle.name}`,
          body: target
            ? `${createdBy} proposed a change for you to review. Nothing changes until you apply it.`
            : `${createdBy} drafted it for you to review. Nothing runs until you import it.`,
          dedupeKey: `automation_draft:${draft.id}`,
        });
        fx.autopilot();
        return draft;
      });
    },

    drafts: () => repos.autopilotDrafts.all().filter(unexpired),

    getDraft,

    dismissDraft(id) {
      core.write((fx) => {
        getDraft(id);
        repos.autopilotDrafts.delete(id);
        fx.autopilot();
      });
    },

    applyDraft(id, input, installSkill) {
      const { inputs, slots, installSkill: wantSkill, confirmScript } = ApplyAutomationDraftInput.parse(input);
      const draft = getDraft(id);
      if (!draft.replaces) {
        throw new AppError("VALIDATION", "This draft is a new automation, not a change: import it instead");
      }
      const current = repos.autopilotCustom.get(draft.replaces);
      if (!current) {
        throw new AppError(
          "NOT_FOUND",
          "The automation this draft changes was deleted. Dismiss the draft, or ask for a new one",
        );
      }
      const { bundle } = draft;
      // Here, not in the route, so nothing can skip it: a changed script is someone else's code, run as the user.
      const scripts = actionScripts(bundle.action);
      const scriptsChanged = JSON.stringify(scripts) !== JSON.stringify(actionScripts(current.action));
      if (scripts.length > 0 && scriptsChanged && !confirmScript) {
        throw new AppError(
          "VALIDATION",
          "This change runs a new script on your machine as you. Read it and confirm (confirmScript) to apply it",
        );
      }
      const currentInputs = new Map(current.action.inputs.map((i) => [i.name, i.value]));
      const currentSlots = new Map(
        current.action.kind === "agent" ? current.action.slots.map((s) => [s.name, s.tools]) : [],
      );
      const fill = {
        inputs: Object.fromEntries(
          bundle.inputs.flatMap((i) => {
            const value = inputs[i.name] ?? currentInputs.get(i.name);
            return value === undefined ? [] : [[i.name, value]];
          }),
        ),
        slots: Object.fromEntries(bundle.slots.map((s) => [s.name, slots[s.name] ?? currentSlots.get(s.name) ?? []])),
        // Where it runs is the user's, not the draft's: a file carries no projects or epic.
        projectIds: current.filters.projectIds,
      };
      const define = (skill?: string | null) => {
        const def = CreateCustomAutomationInput.parse(
          bundleToDefinition(bundle, { ...fill, ...(skill === undefined ? {} : { skill }) }),
        );
        return { ...def, filters: { ...def.filters, epicId: current.filters.epicId } };
      };
      // A skill the draft carries is written only with consent, and never over one of the user's (installSkill keeps a
      // taken name apart). Without it the automation keeps naming its own skill when the draft names the same one, and
      // names none for a skill it would have needed the draft's copy of, as an import does.
      const keepSkill = current.action.kind === "agent" && bundle.skill?.name === current.action.skill;
      // Check everything before writing a skill, so a change that can't be saved leaves nothing behind.
      checked(define(bundle.skill?.name), current.id);
      const installed = bundle.skill && wantSkill && installSkill ? installSkill(bundle.skill) : null;
      const def = define(installed ? installed.name : keepSkill ? bundle.skill!.name : undefined);
      const automation = service.update(current.id, def);
      core.write((fx) => {
        if (repos.autopilotDrafts.delete(draft.id)) fx.autopilot();
      });
      return { automation, skill: installed };
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
        // on. Nor when it needs other variables: projects it skipped for lack of one would act on everything held.
        const rearmed =
          JSON.stringify(def.trigger) !== JSON.stringify(current.trigger) ||
          JSON.stringify(def.filters) !== JSON.stringify(current.filters) ||
          JSON.stringify(variablesNamedBy(def.action)) !== JSON.stringify(variablesNamedBy(current.action));
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

    rearmWhereFilled(before, after) {
      for (const custom of repos.autopilotCustom.all()) {
        const named = variablesNamedBy(custom.action);
        if (named.length === 0) continue;
        const filled = [...after].flatMap(([projectId, vars]) =>
          named.some((n) => !variableHasValue(before.get(projectId) ?? {}, n)) &&
          named.every((n) => variableHasValue(vars, n))
            ? [projectId]
            : [],
        );
        if (filled.length === 0) continue;
        // An epic with a setting or arming of its own reads its own time instead of the project's, so it starts afresh too.
        const key = customAutomationKey(custom.id);
        const epicIds = new Set([
          ...repos.autopilotSettings
            .all()
            .filter((s) => s.scopeKind === "epic" && s.automation === key && s.scopeId)
            .map((s) => s.scopeId!),
          ...Object.keys(custom.armedProjects)
            .filter((k) => k.startsWith(epicArmKey("")))
            .map((k) => k.slice(epicArmKey("").length)),
        ]);
        const epics = [...epicIds].filter((epicId) => {
          const epic = repos.tasks.get(epicId);
          return epic !== null && filled.includes(epic.projectId);
        });
        service.rearm(custom.id, [...filled, ...epics.map(epicArmKey)]);
      }
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
  return service;
}
