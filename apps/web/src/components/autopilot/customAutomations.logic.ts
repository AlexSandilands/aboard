import {
  checkCustomDefinition,
  CreateCustomAutomationInput,
  customAgentPrompt,
  customAgentToolsNote,
  CUSTOM_MINUTES_MAX,
  CUSTOM_MINUTES_MIN,
  customTaskMatches,
  customValues,
  describeScriptRun,
  describeShellRun,
  normalizeLabels,
  TestScriptInput,
  type AutomationInputType,
  type CreateCustomAutomationInput as CreateInput,
  type CustomAutomation,
  type CustomPrEvent,
  type CustomScriptLanguage,
  type CustomTrigger,
  type ModelTier,
  type Project,
  type TaskStatus,
  type TaskSummary,
  type TestScriptInput as TestInput,
} from "@repo/contracts";
import { isStarter, scriptStarter, type ScriptRole } from "./scripts.logic";

const NL = String.fromCharCode(10);

/** A declared input as the editor holds it: the value as typed. */
export interface FormInput {
  name: string;
  label: string;
  type: AutomationInputType;
  value: string;
  /** Kept as saved, so exporting can still say what the author started from. */
  default: string;
}

/** A required tool slot as the editor holds it: its tools as typed, one per line. */
export interface FormSlot {
  name: string;
  label: string;
  description: string;
  tools: string;
}

/** A custom automation as the editor holds it: numbers as typed, every kind's fields kept while switching. */
export interface CustomForm {
  name: string;
  triggerKind: CustomTrigger["kind"];
  to: TaskStatus;
  /** "" is any column. */
  from: TaskStatus | "";
  prEvent: CustomPrEvent;
  scheduleKind: "weekly" | "interval";
  /** 0 is Sunday. */
  days: number[];
  time: string;
  /** The interval's length as typed, in `unit`s. */
  every: string;
  unit: "minutes" | "hours";
  staleStatus: TaskStatus;
  staleHours: string;
  projectIds: string[];
  /** Comma-separated, as typed. */
  labels: string;
  /** "" is any (or no) epic. */
  epicId: string;
  actionKind: "agent" | "shell" | "script";
  prompt: string;
  skill: string;
  /** "" takes the task's tier (a schedule has none, so the default one). */
  tier: ModelTier | "";
  onPrBranch: boolean;
  /** One tool or server per line, as typed. */
  allowedTools: string;
  inputs: FormInput[];
  slots: FormSlot[];
  /** An agent's check script (a schedule's only): whether it has one, and its language, body and timeout as typed. */
  checkOn: boolean;
  checkLanguage: CustomScriptLanguage;
  checkBody: string;
  checkTimeoutSeconds: string;
  /** Whether the check's items are untrusted, so their agents run read-only. */
  untrustedItems: boolean;
  command: string;
  /** A script action's language and body; `timeoutSeconds` is shared with a shell command's. */
  language: CustomScriptLanguage;
  body: string;
  timeoutSeconds: string;
}

export const TRIGGER_KINDS: ReadonlyArray<{ value: CustomTrigger["kind"]; label: string }> = [
  { value: "status_change", label: "A task changes column" },
  { value: "pr_event", label: "Something happens on a pull request" },
  { value: "stale", label: "A task sits in a column too long" },
  { value: "blocker_finished", label: "A task's last blocker finishes" },
  { value: "schedule", label: "On a schedule" },
];

export const PR_EVENTS: ReadonlyArray<{ value: CustomPrEvent; label: string }> = [
  { value: "linked", label: "Linked to the task" },
  { value: "new_head", label: "Gets new commits" },
  { value: "checks_failing", label: "Checks fail" },
  { value: "conflict", label: "Has a merge conflict" },
  { value: "merged", label: "Is merged" },
];

export const STATUSES: ReadonlyArray<{ value: TaskStatus; label: string }> = [
  { value: "backlog", label: "Backlog" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "review", label: "Review" },
  { value: "done", label: "Done" },
];

export function emptyCustomForm(): CustomForm {
  return {
    name: "",
    triggerKind: "status_change",
    to: "review",
    from: "",
    prEvent: "checks_failing",
    scheduleKind: "weekly",
    days: [1, 2, 3, 4, 5],
    time: "09:00",
    every: "6",
    unit: "hours",
    staleStatus: "in_progress",
    staleHours: "48",
    projectIds: [],
    labels: "",
    epicId: "",
    actionKind: "agent",
    prompt: "",
    skill: "",
    tier: "",
    onPrBranch: false,
    allowedTools: "",
    inputs: [],
    slots: [],
    checkOn: false,
    checkLanguage: "node",
    checkBody: "",
    checkTimeoutSeconds: "300",
    untrustedItems: true,
    command: "",
    language: "node",
    body: "",
    timeoutSeconds: "300",
  };
}

export function formFromCustom(custom: CustomAutomation): CustomForm {
  const form: CustomForm = {
    ...emptyCustomForm(),
    name: custom.name,
    triggerKind: custom.trigger.kind,
    projectIds: custom.filters.projectIds,
    labels: custom.filters.labels.join(", "),
    epicId: custom.filters.epicId ?? "",
    actionKind: custom.action.kind,
  };
  const t = custom.trigger;
  if (t.kind === "status_change") Object.assign(form, { to: t.to, from: t.from ?? "" });
  if (t.kind === "pr_event") form.prEvent = t.event;
  if (t.kind === "stale") Object.assign(form, { staleStatus: t.status, staleHours: String(t.hours) });
  if (t.kind === "schedule") {
    if (t.schedule.kind === "weekly") {
      Object.assign(form, { days: t.schedule.days, time: t.schedule.time });
    } else {
      form.scheduleKind = "interval";
      if (t.schedule.kind === "hourly") Object.assign(form, { every: String(t.schedule.everyHours), unit: "hours" });
      else Object.assign(form, { every: String(t.schedule.everyMinutes), unit: "minutes" });
    }
  }
  const a = custom.action;
  if (a.kind === "agent") {
    Object.assign(form, {
      prompt: a.prompt,
      skill: a.skill,
      tier: a.tier ?? "",
      onPrBranch: a.onPrBranch,
      allowedTools: a.allowedTools.join("\n"),
      inputs: a.inputs.map(({ name, label, type, value, default: fallback }) => ({
        name,
        label,
        type,
        value,
        default: fallback,
      })),
      slots: a.slots.map(({ name, label, description, tools }) => ({
        name,
        label,
        description,
        tools: tools.join("\n"),
      })),
      untrustedItems: a.untrustedItems,
      ...(a.check
        ? {
            checkOn: true,
            checkLanguage: a.check.language,
            checkBody: a.check.body,
            checkTimeoutSeconds: String(a.check.timeoutSeconds),
          }
        : {}),
    });
  } else if (a.kind === "script") {
    Object.assign(form, { language: a.language, body: a.body, timeoutSeconds: String(a.timeoutSeconds) });
  } else {
    Object.assign(form, { command: a.command, timeoutSeconds: String(a.timeoutSeconds) });
  }
  return form;
}

/** The tools typed in the field, one per line (a rule's specifier can hold a comma), blanks dropped. */
export const parseAllowedTools = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter(Boolean);

const wholeNumber = (value: string): number | null => (/^\d+$/.test(value.trim()) ? Number(value) : null);

function triggerOf(form: CustomForm): CustomTrigger | string {
  switch (form.triggerKind) {
    case "status_change":
      return { kind: "status_change", to: form.to, from: form.from || null };
    case "pr_event":
      return { kind: "pr_event", event: form.prEvent };
    case "blocker_finished":
      return { kind: "blocker_finished" };
    case "stale": {
      const hours = wholeNumber(form.staleHours);
      if (hours === null || hours < 1) return "Enter how many hours, a whole number";
      return { kind: "stale", status: form.staleStatus, hours };
    }
    case "schedule": {
      if (form.scheduleKind === "interval") {
        const every = wholeNumber(form.every);
        if (form.unit === "minutes") {
          if (every === null || every < CUSTOM_MINUTES_MIN || every > CUSTOM_MINUTES_MAX) {
            return `Run every ${CUSTOM_MINUTES_MIN} to ${CUSTOM_MINUTES_MAX} minutes`;
          }
          return { kind: "schedule", schedule: { kind: "minutes", everyMinutes: every } };
        }
        if (every === null || every < 1 || every > 24) return "Run every 1 to 24 hours";
        return { kind: "schedule", schedule: { kind: "hourly", everyHours: every } };
      }
      return { kind: "schedule", schedule: { kind: "weekly", days: form.days, time: form.time } };
    }
  }
}

/** The input to save, or what to fix: the schema's rules and the server's definition check, run here first. */
export function customFormToInput(form: CustomForm): { ok: true; input: CreateInput } | { ok: false; error: string } {
  const trigger = triggerOf(form);
  if (typeof trigger === "string") return { ok: false, error: trigger };
  const timeoutSeconds = wholeNumber(form.timeoutSeconds);
  if (form.actionKind !== "agent" && timeoutSeconds === null) {
    return { ok: false, error: "Enter a timeout in seconds, a whole number" };
  }
  // Only a schedule has a check, and the section is hidden for the others, so what was typed there is left out.
  const checking = form.actionKind === "agent" && form.triggerKind === "schedule" && form.checkOn;
  const checkTimeout = wholeNumber(form.checkTimeoutSeconds);
  if (checking && checkTimeout === null) {
    return { ok: false, error: "Enter the check's timeout in seconds, a whole number" };
  }
  let labels: string[];
  try {
    labels = normalizeLabels(form.labels.split(",").filter((l) => l.trim()));
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const parsed = CreateCustomAutomationInput.safeParse({
    name: form.name,
    trigger,
    filters: { projectIds: form.projectIds, labels, epicId: form.epicId || null },
    action:
      form.actionKind === "agent"
        ? {
            kind: "agent",
            prompt: form.prompt,
            skill: form.skill,
            tier: form.tier || null,
            // The switch is hidden on a schedule, which has no pull request.
            onPrBranch: form.triggerKind === "schedule" ? false : form.onPrBranch,
            allowedTools: parseAllowedTools(form.allowedTools),
            inputs: form.inputs,
            slots: form.slots.map((slot) => ({ ...slot, tools: parseAllowedTools(slot.tools) })),
            check: checking
              ? { language: form.checkLanguage, body: form.checkBody, timeoutSeconds: checkTimeout }
              : null,
            untrustedItems: form.untrustedItems,
          }
        : form.actionKind === "script"
          ? { kind: "script", language: form.language, body: form.body, timeoutSeconds }
          : { kind: "shell", command: form.command, timeoutSeconds },
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    if (issue.path.includes("allowedTools")) {
      const tool = issue.path.at(-1);
      const named = typeof tool === "number" ? ` "${parseAllowedTools(form.allowedTools)[tool] ?? ""}"` : "";
      return { ok: false, error: `Allowed tools:${named} ${issue.message}` };
    }
    // Declared inputs and slots are numbered as the editor lists them.
    for (const [key, what] of [
      ["inputs", "Input"],
      ["slots", "Tool slot"],
    ] as const) {
      const at = issue.path.indexOf(key);
      const n = at >= 0 ? issue.path[at + 1] : undefined;
      if (typeof n === "number") return { ok: false, error: `${what} ${n + 1}: ${issue.message}` };
    }
    const field = String(issue.path[issue.path.length - 1] ?? issue.path[0] ?? "");
    if (issue.path.includes("check")) {
      if (field === "body") return { ok: false, error: "Write the check script, or switch the check off" };
      if (field === "timeoutSeconds") return { ok: false, error: "The check's timeout is 1 to 3600 seconds" };
    }
    const what: Record<string, string> = {
      name: "Give it a name",
      prompt: "Write the prompt the agent starts with",
      command: "Write the command to run",
      days: "Pick at least one weekday",
      time: "Use a time like 09:00",
      timeoutSeconds: "The timeout is 1 to 3600 seconds",
      body: "Write the script to run",
    };
    return { ok: false, error: what[field] ?? issue.message };
  }
  const problem = checkCustomDefinition(parsed.data);
  return problem ? { ok: false, error: problem } : { ok: true, input: parsed.data };
}

/** The form with another kind of action picked: a script with nothing written yet starts from its language's starter. */
export function withActionKind(form: CustomForm, actionKind: CustomForm["actionKind"]): CustomForm {
  const seed = actionKind === "script" && form.body.trim() === "";
  return { ...form, actionKind, ...(seed ? { body: scriptStarter(form.language, "action") } : {}) };
}

/** The form with the check switched on or off: switching it on with nothing written starts from the starter. */
export function withCheck(form: CustomForm, checkOn: boolean): CustomForm {
  const seed = checkOn && form.checkBody.trim() === "";
  return { ...form, checkOn, ...(seed ? { checkBody: scriptStarter(form.checkLanguage, "check") } : {}) };
}

/**
 * The form with a script's language changed. Text the user hasn't touched (still some language's starter) follows the
 * language, so the example matches; anything they wrote is left as it is.
 */
export function withLanguage(form: CustomForm, role: ScriptRole, language: CustomScriptLanguage): CustomForm {
  if (role === "check") {
    const checkBody = isStarter(form.checkBody, "check") ? scriptStarter(language, "check") : form.checkBody;
    return { ...form, checkLanguage: language, checkBody };
  }
  return { ...form, language, body: isStarter(form.body, "action") ? scriptStarter(language, "action") : form.body };
}

/**
 * What a test run of the form's action script (or check) sends: the script as typed, and what the run needs to read
 * the way a real one would. A task, for an action only, gives it that task's values.
 */
export function testScriptRequest(
  form: CustomForm,
  role: ScriptRole,
  projectId: string,
  taskId: string | null = null,
): { ok: true; input: TestInput } | { ok: false; error: string } {
  const check = role === "check";
  const timeout = wholeNumber(check ? form.checkTimeoutSeconds : form.timeoutSeconds);
  if (timeout === null) return { ok: false, error: "Enter a timeout in seconds, a whole number" };
  const parsed = TestScriptInput.safeParse({
    projectId,
    role,
    taskId: check ? null : taskId,
    name: form.name,
    inputs: Object.fromEntries(form.inputs.filter((i) => i.name).map((i) => [i.name, i.value])),
    prompt: check ? form.prompt : "",
    skill: check ? form.skill : "",
    script: check
      ? { language: form.checkLanguage, body: form.checkBody, timeoutSeconds: timeout }
      : { language: form.language, body: form.body, timeoutSeconds: timeout },
  });
  if (parsed.success) return { ok: true, input: parsed.data };
  const issue = parsed.error.issues[0]!;
  if (issue.path.at(-1) === "body") return { ok: false, error: "Write the script first" };
  if (issue.path.at(-1) === "timeoutSeconds") return { ok: false, error: "The timeout is 1 to 3600 seconds" };
  return { ok: false, error: issue.message };
}

export const blankInput = (): FormInput => ({ name: "", label: "", type: "text", value: "", default: "" });
export const blankSlot = (): FormSlot => ({ name: "", label: "", description: "", tools: "" });

/** The tool slots in the editor with no tools yet: the automation can't be switched on until they have. */
export const emptyFormSlots = (form: Pick<CustomForm, "slots">): FormSlot[] =>
  form.slots.filter((slot) => parseAllowedTools(slot.tools).length === 0);

/** A task to preview the action with: the newest one the filters let through, in a project they allow. */
export function sampleTask(input: Pick<CreateInput, "filters">, tasks: readonly TaskSummary[]): TaskSummary | null {
  const filters = { projectIds: [], labels: [], epicId: null, ...input.filters };
  const fits = tasks.filter(
    (t) =>
      (filters.projectIds.length === 0 || filters.projectIds.includes(t.projectId)) && customTaskMatches(filters, t),
  );
  return [...fits].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

/**
 * The sample task for what the form says so far, even while it can't be saved yet (a script being written has no valid
 * body): a test run of a task-triggered script is given it. None for a schedule, which has no task.
 */
export function formSampleTask(form: CustomForm, tasks: readonly TaskSummary[]): TaskSummary | null {
  if (form.triggerKind === "schedule") return null;
  let labels: string[] = [];
  try {
    labels = normalizeLabels(form.labels.split(",").filter((l) => l.trim()));
  } catch {
    // Labels typed so far that don't parse narrow nothing: the preview and save report them.
  }
  return sampleTask({ filters: { projectIds: form.projectIds, labels, epicId: form.epicId || null } }, tasks);
}

/**
 * What the action would run for the sample task (or, for a schedule, the first project in scope): the filled prompt,
 * or the command with its variables. The task's description isn't on the board, so the preview leaves it out.
 */
export function previewAction(
  input: CreateInput,
  task: TaskSummary | null,
  projects: readonly Project[],
): string | null {
  const project =
    projects.find((p) => p.id === task?.projectId) ??
    projects.find((p) => input.filters?.projectIds?.includes(p.id)) ??
    projects[0] ??
    null;
  const def = CreateCustomAutomationInput.parse(input);
  const scheduled = input.trigger.kind === "schedule";
  const values = customValues(def, project, scheduled ? null : task);
  if (def.action.kind === "shell") return describeShellRun(def.action.command, values);
  if (def.action.kind === "script") return describeScriptRun(def.action, values);
  if (!scheduled && !task) return null;
  const prompt = customAgentPrompt(def, values, scheduled ? null : task, null);
  const tools = customAgentToolsNote(def.action);
  return tools ? `${prompt}${NL}${NL}${tools}` : prompt;
}
