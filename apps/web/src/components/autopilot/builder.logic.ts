import {
  bundleToDefinition,
  CreateCustomAutomationInput,
  describeCustomTrigger,
  normalizeLabels,
  type AutomationBundle,
  type BundleFill,
  type Project,
  type TaskSummary,
} from "@repo/contracts";
import { SCRIPT_LANGUAGES } from "./scripts.logic";
import {
  customFormToInput,
  formFromCustom,
  parseAllowedTools,
  PR_EVENTS,
  STATUSES,
  triggerOf,
  type CustomForm,
} from "./customAutomations.logic";

// The step-through builder for a custom automation (docs/features/autopilot.md#custom-automations): one form, shown a
// step at a time, so moving back and forth keeps everything typed.

export const BUILDER_STEPS = ["When", "Do", "Details", "Where", "Review & try"] as const;
export type BuilderStep = 0 | 1 | 2 | 3 | 4;
export const REVIEW_STEP: BuilderStep = 4;

/** Stands in for a name not asked for yet, so the earlier steps' checks don't stop on it. */
const NAME_PLACEHOLDER = "Untitled";

/**
 * What to fix before leaving a step, or null. Each step checks only what it shows, and assumes the steps before it
 * pass: Details checks the action without the name or filters, Where adds the filters, Review checks the whole thing.
 */
export function stepProblem(form: CustomForm, step: BuilderStep): string | null {
  switch (step) {
    case 0: {
      const trigger = triggerOf(form);
      return typeof trigger === "string" ? trigger : null;
    }
    case 1:
      return null;
    case 2: {
      const result = customFormToInput({
        ...form,
        name: form.name.trim() || NAME_PLACEHOLDER,
        labels: "",
        projectIds: [],
        epicId: "",
      });
      return result.ok ? null : result.error;
    }
    case 3: {
      const result = customFormToInput({ ...form, name: form.name.trim() || NAME_PLACEHOLDER });
      return result.ok ? null : result.error;
    }
    case 4: {
      const result = customFormToInput(form);
      return result.ok ? null : result.error;
    }
  }
}

/** The first step with something to fix, so Save can go straight there; null when it can be saved. */
export function firstProblem(form: CustomForm): { step: BuilderStep; error: string } | null {
  for (const step of [0, 1, 2, 3, 4] as const) {
    const error = stepProblem(form, step);
    if (error) return { step, error };
  }
  return null;
}

const statusLabel = (value: string) => STATUSES.find((s) => s.value === value)?.label ?? value;

/** A name to start from, said from the trigger and the action: "Changes requested → agent". */
export function suggestedName(form: CustomForm): string {
  const when = (() => {
    switch (form.triggerKind) {
      case "status_change":
        return `Into ${statusLabel(form.to)}`;
      case "pr_event":
        return `PR ${PR_EVENTS.find((e) => e.value === form.prEvent)?.label.toLowerCase() ?? "event"}`;
      case "stale":
        return `Stuck in ${statusLabel(form.staleStatus)}`;
      case "blocker_finished":
        return "Unblocked";
      case "schedule":
        return form.scheduleKind === "weekly" ? `Daily at ${form.time}` : `Every ${form.every} ${form.unit}`;
    }
  })();
  const what =
    form.actionKind === "agent"
      ? form.checkOn && form.triggerKind === "schedule"
        ? "check, then agent"
        : "agent"
      : form.actionKind === "shell"
        ? "command"
        : `${SCRIPT_LANGUAGES.find((l) => l.value === form.language)?.label ?? ""} script`.trim();
  return `${when} → ${what}`;
}

/** A prompt's or command's first line, cut to about 60 characters. */
function gist(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

const languageLabel = (value: string) => SCRIPT_LANGUAGES.find((l) => l.value === value)?.label ?? value;

/** "a, b and c". */
function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * The automation as one sentence, as far as it is filled in: when, what, and where. Read on every step, so it says
 * something sensible before the prompt is written or while a number is half-typed.
 */
export function formSentence(
  form: CustomForm,
  projects: readonly Pick<Project, "id" | "title">[],
  epics: readonly Pick<TaskSummary, "id" | "number" | "title">[] = [],
): string {
  const trigger = triggerOf(form);
  const when = typeof trigger === "string" ? "When it is triggered" : describeCustomTrigger(trigger);
  const checking = form.actionKind === "agent" && form.triggerKind === "schedule" && form.checkOn;
  const what = (() => {
    switch (form.actionKind) {
      case "agent": {
        const prompt = gist(form.prompt);
        const ask = prompt ? `ask an agent: “${prompt}”` : "ask an agent";
        return checking
          ? `run a ${languageLabel(form.checkLanguage)} check script and, for each item it prints, ${ask}`
          : ask;
      }
      case "shell": {
        const command = gist(form.command);
        return command ? `run \`${command}\`` : "run a command";
      }
      case "script":
        return `run a ${languageLabel(form.language)} script`;
    }
  })();
  const named = projects.filter((p) => form.projectIds.includes(p.id)).map((p) => p.title);
  const where = named.length > 0 ? `in ${listPhrase(named)}` : "in every project it's switched on in";
  const narrowed: string[] = [];
  if (form.triggerKind !== "schedule") {
    const labels = form.labels
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
    if (labels.length > 0) narrowed.push(`on tasks labelled ${labels.join(" or ")}`);
    const epic = epics.find((e) => e.id === form.epicId);
    if (epic) narrowed.push(`in #${epic.number} ${epic.title}`);
  }
  const end = /[.!?…”`]$/.test(what) ? "" : ".";
  return `${when}, ${what}${end} It runs ${[where, ...narrowed].join(", ")}.`;
}

/** What the last step lists under "Right now this would run for". */
export type RightNow =
  /** A task sitting too long: the tasks already past it, which it would act on once switched on. */
  | { kind: "tasks"; tasks: TaskSummary[]; more: number }
  /** An event trigger: nothing has happened since it was switched on, so nothing yet. */
  | { kind: "events" }
  /** A schedule: each project it is on in, at the next time. */
  | { kind: "schedule"; projects: string[] };

const RIGHT_NOW_SHOWN = 5;

/**
 * Which tasks it would act on if it were switched on now. Only a "sits too long" trigger has any: the others act on
 * what happens after it is on (it is armed when switched on), and a schedule runs once per project.
 */
export function rightNow(
  form: CustomForm,
  tasks: readonly TaskSummary[],
  projects: readonly Pick<Project, "id" | "title">[],
  now: Date,
): RightNow {
  const inScope = projects.filter((p) => form.projectIds.length === 0 || form.projectIds.includes(p.id));
  if (form.triggerKind === "schedule") return { kind: "schedule", projects: inScope.map((p) => p.title) };
  const trigger = triggerOf(form);
  if (typeof trigger === "string" || trigger.kind !== "stale") return { kind: "events" };
  let labels: string[] = [];
  try {
    labels = normalizeLabels(form.labels.split(",").filter((l) => l.trim()));
  } catch {
    // Labels that don't parse narrow nothing here: the step reports them.
  }
  const cutoff = now.getTime() - trigger.hours * 3_600_000;
  const projectIds = new Set(inScope.map((p) => p.id));
  const due = tasks
    .filter(
      (t) =>
        t.kind === "task" &&
        t.archivedAt === null &&
        projectIds.has(t.projectId) &&
        t.status === trigger.status &&
        Date.parse(t.statusChangedAt) <= cutoff &&
        (labels.length === 0 || labels.some((l) => t.labels.includes(l))) &&
        (!form.epicId || t.parent?.id === form.epicId),
    )
    .sort((a, b) => a.statusChangedAt.localeCompare(b.statusChangedAt));
  return { kind: "tasks", tasks: due.slice(0, RIGHT_NOW_SHOWN), more: Math.max(0, due.length - RIGHT_NOW_SHOWN) };
}

/** How long a task has been in its column, "52 h" or "3 d". */
export function timeInColumn(task: Pick<TaskSummary, "statusChangedAt">, now: Date): string {
  const hours = Math.floor((now.getTime() - Date.parse(task.statusChangedAt)) / 3_600_000);
  return hours < 72 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

/**
 * Whether More options should start open: something behind it is set, so hiding it would hide part of what the
 * automation does (a check script, allowed tools, a skill ...).
 */
export function hasMoreOptions(form: CustomForm): boolean {
  if (form.inputs.length > 0) return true;
  if (form.actionKind !== "agent") return false;
  return (
    form.skill.trim() !== "" ||
    parseAllowedTools(form.allowedTools).length > 0 ||
    form.slots.length > 0 ||
    (form.onPrBranch && form.triggerKind !== "schedule") ||
    (form.checkOn && form.triggerKind === "schedule") ||
    (typeof form.model === "object" && form.model !== null)
  );
}

/** Whether what the form would save runs a script: a script action, or a schedule's check. */
export const formRunsScript = (form: CustomForm): boolean =>
  form.actionKind === "script" || (form.actionKind === "agent" && form.triggerKind === "schedule" && form.checkOn);

/** What More options holds for this trigger and action, for its closed header. */
export function moreOptionsSummary(form: CustomForm): string {
  if (form.actionKind !== "agent") return "inputs";
  return [
    "model",
    "skill",
    "allowed tools",
    "inputs",
    "required tools",
    form.triggerKind === "schedule" ? "check script" : "PR branch",
  ].join(", ");
}

/**
 * The builder's form for a shared file or an agent's draft, for "Edit first": the definition as it would be imported
 * with what the reader filled in so far. A skill the file carries isn't installed this way, so the action names the
 * skill only if the reader already has it.
 */
export function formFromBundle(bundle: AutomationBundle, fill: BundleFill = {}): CustomForm {
  const def = CreateCustomAutomationInput.parse(bundleToDefinition(bundle, fill));
  return formFromCustom(def);
}
