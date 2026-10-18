import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  BUILTIN_PLAN_SKILL_BODY,
  BUILTIN_PLAN_SKILL_NAME,
  BUILTIN_REVIEW_SKILL_BODY,
  BUILTIN_REVIEW_SKILL_NAME,
  checkCustomDefinition,
  CUSTOM_PROMPT_MAX,
  editableTargetKey,
  SuggestChangeInput,
  type EditablePrompt,
  type EditablePromptText,
  type EditableTarget,
  type PlanSkillRef,
  type Suggestion,
  type SuggestionList,
  type SuggestionView,
} from "@repo/contracts";
import { discoverSkills } from "../skills.ts";
import { nowIso } from "../db/database.ts";
import { AppError, notFound } from "../errors.ts";
import type { Core } from "./core.ts";
import type { CustomAutomationsService } from "./customAutomations.ts";
import type { NotificationsService } from "./notifications.ts";
import type { ProjectsService, SettingsService } from "./types.ts";

// Suggested changes (docs/features/suggestions.md): agents propose rewrites of prompts and skills the user can edit,
// and only the user's accept writes anything.

/** How many decided suggestions the list keeps showing below the open ones. */
const DECIDED_SHOWN = 30;

/** Where a built-in skill is saved when the user accepts a change to it, under the user's home folder. */
const FORK_ROOT = ".claude/skills";

/** A short hash of a text: what an agent read, passed back so a change only lands on that text. */
export const promptHash = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

const BUILTINS = {
  review: {
    name: BUILTIN_REVIEW_SKILL_NAME,
    body: BUILTIN_REVIEW_SKILL_BODY,
    title: "Built-in review skill",
    description:
      "Independent code review of a task on the user's task board before its pull request is opened. Your own copy of the board's built-in review skill.",
  },
  plan: {
    name: BUILTIN_PLAN_SKILL_NAME,
    body: BUILTIN_PLAN_SKILL_BODY,
    title: "Built-in planning skill",
    description:
      "Planning tasks on the user's task board with the user. Your own copy of the board's built-in planning skill.",
  },
} as const;

export interface SuggestionsService {
  /** What agents may propose changes to: the skills the board's settings and custom automations use, and their prompts. */
  editable(): EditablePrompt[];
  /** One editable prompt with its current text and hash. NOT_FOUND for a key `editable` doesn't list. */
  read(key: string): EditablePromptText;
  /**
   * Records an agent's proposed change, replacing any open one for the same target, and notifies the user. CONFLICT
   * when the text changed since the agent read it, VALIDATION when the change is empty or can't be saved there.
   */
  suggest(input: SuggestChangeInput, actor: string): { suggestion: Suggestion; replaced: Suggestion | null };
  list(): SuggestionList;
  get(id: string): Suggestion;
  /**
   * Applies an open suggestion if its target still has the text the agent read, else marks it stale (returned with
   * that status, not thrown). A built-in skill is saved as the user's own global skill, and Settings switch to it.
   */
  accept(id: string, actor: string): Suggestion;
  reject(id: string, actor: string): Suggestion;
}

export function createSuggestionsService(
  core: Core,
  deps: {
    settings: SettingsService;
    projects: ProjectsService;
    customAutomations: CustomAutomationsService;
    notifications: NotificationsService;
    /** The user's home folder: where global skills are found and built-in ones are saved. */
    userHome: string;
  },
): SuggestionsService {
  const { repos } = core;

  /** Every editable target, keyed, with where each is used. Read fresh each time: settings and files change. */
  const targets = (): Map<string, EditablePrompt> => {
    const found = new Map<string, EditablePrompt>();
    const add = (
      target: EditableTarget,
      title: string,
      usedBy: string,
      extra: { path?: string; inRepo?: boolean } = {},
    ) => {
      const key = editableTargetKey(target);
      const known = found.get(key);
      if (known) {
        if (!known.usedBy.includes(usedBy)) known.usedBy.push(usedBy);
        return;
      }
      found.set(key, {
        key,
        target,
        title,
        usedBy: [usedBy],
        path: extra.path ?? null,
        inRepo: extra.inRepo ?? false,
        builtin: target.kind === "builtin",
      });
    };
    const addSkillRef = (which: "review" | "plan", ref: PlanSkillRef, usedBy: string) => {
      if (ref.source === "builtin") {
        add({ kind: "builtin", skill: which }, BUILTINS[which].title, usedBy);
        // Settings take any path over REST; only a skill file is something to rewrite.
      } else if (basename(ref.path) === "SKILL.md") {
        add({ kind: "skill", path: ref.path }, `Skill ${ref.name}`, usedBy, {
          path: ref.path,
          inRepo: ref.source === "project",
        });
      }
    };

    const settings = deps.settings.get();
    addSkillRef("review", settings.reviewSkill, "Review skill (board)");
    addSkillRef("plan", settings.planSkill, "Planning skill (board)");
    const projects = deps.projects.list();
    for (const project of projects) {
      if (project.reviewSkill) addSkillRef("review", project.reviewSkill, `Review skill of project ${project.title}`);
      if (project.planSkill) addSkillRef("plan", project.planSkill, `Planning skill of project ${project.title}`);
    }
    for (const custom of deps.customAutomations.list()) {
      if (custom.action.kind !== "agent") continue;
      const usedBy = `Custom automation ${custom.name}`;
      add({ kind: "automation", automationId: custom.id }, `Prompt of custom automation ${custom.name}`, usedBy);
      const skillName = custom.action.skill;
      if (!skillName) continue;
      // The skill is named, not located: look where the agent would find it, in the projects the automation covers.
      const roots = projects
        .filter((p) => custom.filters.projectIds.length === 0 || custom.filters.projectIds.includes(p.id))
        .map((p) => p.workspaceRoot);
      const skills = [null, ...roots].flatMap((workspaceRoot) =>
        discoverSkills({ homeDir: deps.userHome, workspaceRoot }),
      );
      for (const skill of skills.filter((s) => s.name === skillName)) {
        add({ kind: "skill", path: skill.path }, `Skill ${skill.name}`, `Skill of custom automation ${custom.name}`, {
          path: skill.path,
          inRepo: skill.source === "project",
        });
      }
    }
    return found;
  };

  const resolve = (key: string): EditablePrompt => {
    const target = targets().get(key.trim());
    if (!target) throw notFound("Editable prompt", key);
    return target;
  };

  const textOf = (prompt: EditablePrompt): string => {
    const { target } = prompt;
    switch (target.kind) {
      case "builtin":
        return BUILTINS[target.skill].body;
      case "automation": {
        const custom = deps.customAutomations.get(target.automationId);
        if (custom.action.kind !== "agent") throw notFound("Editable prompt", prompt.key);
        return custom.action.prompt;
      }
      case "skill":
        try {
          return readFileSync(target.path, "utf8");
        } catch {
          throw new AppError("NOT_FOUND", `Can't read ${target.path}`);
        }
    }
  };

  const read = (key: string): EditablePromptText => {
    const prompt = resolve(key);
    const text = textOf(prompt);
    return { ...prompt, text, hash: promptHash(text) };
  };

  const get = (id: string): Suggestion => {
    const found = repos.suggestions.get(id);
    if (!found) throw notFound("Suggestion", id);
    return found;
  };

  /** Closes a suggestion with a status, and tells open browsers. */
  const close = (
    suggestion: Suggestion,
    status: Suggestion["status"],
    actor: string,
    outcome: string | null,
  ): Suggestion =>
    core.write((fx) => {
      const next: Suggestion = { ...suggestion, status, resolvedAt: nowIso(), resolvedBy: actor, outcome };
      repos.suggestions.update(next);
      fx.suggestions();
      return next;
    });

  const open = (id: string): Suggestion => {
    const suggestion = get(id);
    if (suggestion.status !== "open") throw new AppError("CONFLICT", `This suggestion is already ${suggestion.status}`);
    return suggestion;
  };

  /** Keeps the target's line endings, so a file with CRLF doesn't change on every line. */
  const sameLineEndings = (current: string, proposed: string): string =>
    current.includes("\r\n") && !proposed.includes("\r\n") ? proposed.replace(/\n/g, "\r\n") : proposed;

  /** A free folder for a fork of a built-in skill: `<name>-custom`, then `-2`, `-3`… */
  const forkFolder = (name: string): { name: string; dir: string } => {
    for (let n = 1; ; n++) {
      const folder = n === 1 ? `${name}-custom` : `${name}-custom-${n}`;
      const dir = join(deps.userHome, FORK_ROOT, folder);
      if (!existsSync(dir)) return { name: folder, dir };
    }
  };

  /** Saves a built-in skill with the change as a global skill and points every setting that used the built-in at it. */
  const fork = (which: "review" | "plan", body: string): string => {
    const builtin = BUILTINS[which];
    const { name, dir } = forkFolder(builtin.name);
    const path = join(dir, "SKILL.md");
    mkdirSync(dir, { recursive: true });
    const text = `---\nname: ${name}\ndescription: ${builtin.description}\n---\n\n${body.trim()}\n`;
    writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
    const ref = { source: "global" as const, name, path };
    try {
      core.write(() => {
        const field = which === "review" ? "reviewSkill" : "planSkill";
        if (deps.settings.get()[field].source === "builtin") deps.settings.update({ [field]: ref });
        for (const project of deps.projects.list()) {
          if (project[field]?.source === "builtin") deps.projects.update(project.id, { [field]: ref });
        }
      });
    } catch (error) {
      // Nothing points at it, so don't leave a skill the user never chose (and the next try would take `-2`).
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return path;
  };

  /** Writes the change to its target and says what it did. */
  const apply = (prompt: EditablePrompt, current: string, proposed: string): string => {
    const { target } = prompt;
    switch (target.kind) {
      case "skill":
        writeFileSync(target.path, sameLineEndings(current, proposed), "utf8");
        return prompt.inRepo
          ? `Wrote ${target.path}. It is in a project's repository: commit the change there.`
          : `Wrote ${target.path}.`;
      case "automation": {
        const custom = deps.customAutomations.get(target.automationId);
        if (custom.action.kind !== "agent") throw notFound("Editable prompt", prompt.key);
        deps.customAutomations.update(custom.id, { action: { ...custom.action, prompt: proposed.trim() } });
        return `Updated the prompt of custom automation ${custom.name}.`;
      }
      case "builtin":
        return `Saved as your own skill at ${fork(target.skill, proposed)} and switched Settings to it.`;
    }
  };

  /** Why `proposed` can't be saved to the target, or null. */
  const problemWith = (prompt: EditablePrompt, current: string, proposed: string): string | null => {
    // Line endings don't count: accepting keeps the target's, and the diff the user sees ignores them.
    const normal = (text: string) => text.replace(/\r\n/g, "\n").trim();
    if (normal(proposed) === normal(current)) return "The proposed text is the same as the current text";
    if (prompt.target.kind !== "automation") return null;
    const custom = deps.customAutomations.get(prompt.target.automationId);
    if (custom.action.kind !== "agent") return null;
    const next = proposed.trim();
    if (next.length > CUSTOM_PROMPT_MAX)
      return `A custom automation's prompt is at most ${CUSTOM_PROMPT_MAX} characters`;
    return checkCustomDefinition({ ...custom, action: { ...custom.action, prompt: next } });
  };

  const view = (suggestion: Suggestion, known: Map<string, EditablePrompt>): SuggestionView => {
    const prompt = known.get(suggestion.targetKey);
    let current: SuggestionView["current"] = null;
    if (suggestion.status === "open") {
      try {
        current =
          prompt && promptHash(textOf(prompt)) === suggestion.baseHash ? "same" : prompt ? "changed" : "missing";
      } catch {
        current = "missing";
      }
    }
    return {
      ...suggestion,
      current,
      inRepo: prompt?.inRepo ?? false,
      builtin: suggestion.target.kind === "builtin",
    };
  };

  return {
    editable: () => [...targets().values()],

    read,

    suggest(input, actor) {
      const { target: key, baseHash, proposed, rationale, evidence } = SuggestChangeInput.parse(input);
      const prompt = resolve(key);
      const current = textOf(prompt);
      if (promptHash(current) !== baseHash.trim()) {
        throw new AppError(
          "CONFLICT",
          `${prompt.title} changed since you read it (hash ${promptHash(current)}, not ${baseHash.trim()})`,
        );
      }
      const problem = problemWith(prompt, current, proposed);
      if (problem) throw new AppError("VALIDATION", problem);
      return core.write((fx) => {
        const now = nowIso();
        const previous = repos.suggestions.openFor(prompt.key);
        const replaced = previous
          ? close(previous, "superseded", actor, "Replaced by a newer suggestion for the same target.")
          : null;
        const suggestion: Suggestion = {
          id: randomUUID(),
          targetKey: prompt.key,
          target: prompt.target,
          title: prompt.title,
          baseText: current,
          baseHash: promptHash(current),
          proposed,
          rationale,
          evidence,
          status: "open",
          actor,
          createdAt: now,
          resolvedAt: null,
          resolvedBy: null,
          outcome: null,
        };
        repos.suggestions.insert(suggestion);
        fx.suggestions();
        const firstLine = rationale.split("\n")[0]!.trim();
        deps.notifications.notify({
          kind: "suggestion",
          title: `Suggested change to ${prompt.title}`,
          body: `${actor}: ${firstLine.length > 200 ? `${firstLine.slice(0, 199)}…` : firstLine}`,
          dedupeKey: `suggestion:${suggestion.id}`,
        });
        return { suggestion, replaced };
      });
    },

    list() {
      const known = targets();
      return {
        items: repos.suggestions.list(DECIDED_SHOWN).map((s) => view(s, known)),
        open: repos.suggestions.openCount(),
      };
    },

    get,

    accept(id, actor) {
      const suggestion = open(id);
      let prompt: EditablePrompt;
      let current: string;
      try {
        prompt = resolve(suggestion.targetKey);
        current = textOf(prompt);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "NOT_FOUND") throw error;
        return close(suggestion, "stale", actor, "Its target is no longer in use or can't be read.");
      }
      if (promptHash(current) !== suggestion.baseHash) {
        return close(
          suggestion,
          "stale",
          actor,
          "The text changed after the agent read it, so the change wasn't applied.",
        );
      }
      return core.write(() => close(suggestion, "accepted", actor, apply(prompt, current, suggestion.proposed)));
    },

    reject(id, actor) {
      return close(open(id), "rejected", actor, null);
    },
  };
}
