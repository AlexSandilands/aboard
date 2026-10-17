import {
  checkCustomDefinition,
  CreateCustomAutomationInput,
  customAgentPrompt,
  customTaskMatches,
  customValues,
  describeShellRun,
  normalizeLabels,
  type CreateCustomAutomationInput as CreateInput,
  type CustomAutomation,
  type CustomPrEvent,
  type CustomTrigger,
  type ModelTier,
  type Project,
  type TaskStatus,
  type TaskSummary,
} from "@repo/contracts";

/** A custom automation as the editor holds it: numbers as typed, every kind's fields kept while switching. */
export interface CustomForm {
  name: string;
  triggerKind: CustomTrigger["kind"];
  to: TaskStatus;
  /** "" is any column. */
  from: TaskStatus | "";
  prEvent: CustomPrEvent;
  scheduleKind: "weekly" | "hourly";
  /** 0 is Sunday. */
  days: number[];
  time: string;
  everyHours: string;
  staleStatus: TaskStatus;
  staleHours: string;
  projectIds: string[];
  /** Comma-separated, as typed. */
  labels: string;
  /** "" is any (or no) epic. */
  epicId: string;
  actionKind: "agent" | "shell";
  prompt: string;
  skill: string;
  /** "" takes the task's tier. */
  tier: ModelTier | "";
  onPrBranch: boolean;
  command: string;
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
    everyHours: "6",
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
    command: "",
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
    form.scheduleKind = t.schedule.kind;
    if (t.schedule.kind === "weekly") Object.assign(form, { days: t.schedule.days, time: t.schedule.time });
    else form.everyHours = String(t.schedule.everyHours);
  }
  const a = custom.action;
  if (a.kind === "agent") {
    Object.assign(form, { prompt: a.prompt, skill: a.skill, tier: a.tier ?? "", onPrBranch: a.onPrBranch });
  } else {
    Object.assign(form, { command: a.command, timeoutSeconds: String(a.timeoutSeconds) });
  }
  return form;
}

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
      if (form.scheduleKind === "hourly") {
        const everyHours = wholeNumber(form.everyHours);
        if (everyHours === null || everyHours < 1 || everyHours > 24) return "Run every 1 to 24 hours";
        return { kind: "schedule", schedule: { kind: "hourly", everyHours } };
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
  if (form.actionKind === "shell" && timeoutSeconds === null) {
    return { ok: false, error: "Enter a timeout in seconds, a whole number" };
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
            onPrBranch: form.onPrBranch,
          }
        : { kind: "shell", command: form.command, timeoutSeconds },
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field = String(issue.path[issue.path.length - 1] ?? issue.path[0] ?? "");
    const what: Record<string, string> = {
      name: "Give it a name",
      prompt: "Write the prompt the agent starts with",
      command: "Write the command to run",
      days: "Pick at least one weekday",
      time: "Use a time like 09:00",
      timeoutSeconds: "The timeout is 1 to 3600 seconds",
    };
    return { ok: false, error: what[field] ?? issue.message };
  }
  const problem = checkCustomDefinition(parsed.data);
  return problem ? { ok: false, error: problem } : { ok: true, input: parsed.data };
}

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
  const values = customValues(def, project, input.trigger.kind === "schedule" ? null : task);
  if (def.action.kind === "shell") return describeShellRun(def.action.command, values);
  return task ? customAgentPrompt(def, values, task, null) : null;
}
