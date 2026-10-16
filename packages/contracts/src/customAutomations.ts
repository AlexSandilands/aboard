import { z } from "zod";
import { BRAND, brandEnv } from "./brand.ts";
import { ModelTier } from "./modelTiers.ts";
import { WeeklySchedule } from "./recurring.ts";
import { TaskStatus, type Project, type TaskLink, type TaskSummary } from "./schemas.ts";

// Custom automations: Autopilot automations the user defines (docs/features/autopilot.md#custom-automations). Each
// row is a catalogue entry `custom:<id>` with a trigger, filters and an action, switched per scope like the built-in
// ones. The template rendering and the shell environment are here so the settings form previews exactly what the
// server will run.

export const CUSTOM_AUTOMATION_PREFIX = "custom:";
export const CUSTOM_NAME_MAX = 80;
export const CUSTOM_PROMPT_MAX = 20_000;
export const CUSTOM_COMMAND_MAX = 4_000;
export const CUSTOM_TIMEOUT_MAX_SECONDS = 3_600;
export const CUSTOM_STALE_HOURS_MAX = 24 * 30;

/** The catalogue key of a custom automation. Stored in settings and runs. */
export const customAutomationKey = (id: string): string => `${CUSTOM_AUTOMATION_PREFIX}${id}`;

/** The custom automation's id in a catalogue key, or null for a built-in one. */
export const customAutomationId = (key: string): string | null =>
  key.startsWith(CUSTOM_AUTOMATION_PREFIX) ? key.slice(CUSTOM_AUTOMATION_PREFIX.length) : null;

export const CustomPrEvent = z.enum(["linked", "new_head", "checks_failing", "conflict", "merged"]);
export type CustomPrEvent = z.infer<typeof CustomPrEvent>;

/** Every N hours from local midnight (so 6 is 00:00, 06:00, 12:00 and 18:00). */
export const HourlySchedule = z.object({
  kind: z.literal("hourly"),
  everyHours: z.number().int().min(1).max(24),
});

export const CustomSchedule = z.discriminatedUnion("kind", [WeeklySchedule, HourlySchedule]);
export type CustomSchedule = z.infer<typeof CustomSchedule>;

/** What a custom automation watches for. Every kind but `schedule` is about one task. */
export const CustomTrigger = z.discriminatedUnion("kind", [
  /** A task moved into `to`, from `from` when set. */
  z.object({ kind: z.literal("status_change"), to: TaskStatus, from: TaskStatus.nullable().default(null) }),
  /** Something happened on a pull request linked to the task. */
  z.object({ kind: z.literal("pr_event"), event: CustomPrEvent }),
  /** A time; once per project in scope, with no task. */
  z.object({ kind: z.literal("schedule"), schedule: CustomSchedule }),
  /** A task has sat in `status` for `hours`. */
  z.object({
    kind: z.literal("stale"),
    status: TaskStatus.default("in_progress"),
    hours: z.number().int().min(1).max(CUSTOM_STALE_HOURS_MAX),
  }),
  /** The last unfinished task blocking this one finished. */
  z.object({ kind: z.literal("blocker_finished") }),
]);
export type CustomTrigger = z.infer<typeof CustomTrigger>;

/** Narrows a trigger to the tasks it applies to. Empty lists match everything. */
export const CustomFilters = z.object({
  projectIds: z.array(z.string().min(1)).default([]),
  /** Any of these labels (normalised). */
  labels: z.array(z.string().trim().min(1)).default([]),
  /** Only tasks in this epic. */
  epicId: z.string().min(1).nullable().default(null),
});
export type CustomFilters = z.infer<typeof CustomFilters>;

export const CustomAction = z.discriminatedUnion("kind", [
  /** An agent through Autopilot's runners, on the trigger's task. */
  z.object({
    kind: z.literal("agent"),
    /** With `{{…}}` placeholders (CUSTOM_PLACEHOLDERS). */
    prompt: z.string().trim().min(1).max(CUSTOM_PROMPT_MAX),
    /** A skill the agent is told to use, by name; blank for none. */
    skill: z.string().trim().max(200).default(""),
    /** The model tier; null takes the task's suggested tier. */
    tier: ModelTier.nullable().default(null),
    /** Work on the branch of the task's open pull request when it has one, instead of a new branch. */
    onPrBranch: z.boolean().default(false),
  }),
  /**
   * A command run by the platform shell in the project's folder. Task values reach it only as environment variables
   * (customShellEnv): the command is never filled in, so a task title can't inject anything.
   */
  z.object({
    kind: z.literal("shell"),
    command: z.string().trim().min(1).max(CUSTOM_COMMAND_MAX),
    timeoutSeconds: z.number().int().min(1).max(CUSTOM_TIMEOUT_MAX_SECONDS).default(300),
  }),
]);
export type CustomAction = z.infer<typeof CustomAction>;

const Definition = {
  name: z.string().trim().min(1).max(CUSTOM_NAME_MAX),
  trigger: CustomTrigger,
  filters: CustomFilters.default({ projectIds: [], labels: [], epicId: null }),
  action: CustomAction,
};

export const CustomAutomation = z.object({
  id: z.string(),
  ...Definition,
  /**
   * Events before this don't fire: set at creation, when the trigger changes, when the automation is switched on
   * somewhere and when Autopilot is resumed, so switching it on doesn't act on the board's history.
   */
  armedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CustomAutomation = z.infer<typeof CustomAutomation>;

export type CustomDefinition = Pick<CustomAutomation, "name" | "trigger" | "filters" | "action">;

export const CreateCustomAutomationInput = z.object(Definition);
export type CreateCustomAutomationInput = z.input<typeof CreateCustomAutomationInput>;

export const UpdateCustomAutomationInput = z.object(Definition).partial();
export type UpdateCustomAutomationInput = z.input<typeof UpdateCustomAutomationInput>;

// ── Placeholders and the shell environment ──────────────────────────────

/** The values an action is given, from its candidate. Missing ones are empty. */
export interface CustomValues {
  automation: string;
  task?: { id: string; number: number; title: string; status: string } | null;
  pr?: { url: string } | null;
  project?: { name: string; path: string | null } | null;
}

/** Each value a prompt can name as `{{key}}` and a shell command reads as `$<env>`. */
export const CUSTOM_PLACEHOLDERS = [
  { key: "task.number", env: "TASK_NUMBER", label: "Task number", read: (v: CustomValues) => v.task?.number },
  { key: "task.title", env: "TASK_TITLE", label: "Task title", read: (v: CustomValues) => v.task?.title },
  { key: "task.id", env: "TASK_ID", label: "Task id", read: (v: CustomValues) => v.task?.id },
  { key: "task.status", env: "TASK_STATUS", label: "Task status", read: (v: CustomValues) => v.task?.status },
  { key: "pr.url", env: "PR_URL", label: "Pull request URL", read: (v: CustomValues) => v.pr?.url },
  { key: "project.name", env: "PROJECT_NAME", label: "Project name", read: (v: CustomValues) => v.project?.name },
  { key: "project.path", env: "PROJECT_PATH", label: "Project folder", read: (v: CustomValues) => v.project?.path },
  { key: "automation.name", env: "AUTOMATION", label: "Automation name", read: (v: CustomValues) => v.automation },
] as const;

const PLACEHOLDER = /\{\{\s*([a-z]+(?:\.[a-z]+)*)\s*\}\}/gi;
const KNOWN = new Set<string>(CUSTOM_PLACEHOLDERS.map((p) => p.key));

/** The `{{…}}` names in a text, in order, without repeats. */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

const valueOf = (key: string, values: CustomValues): string => {
  const value = CUSTOM_PLACEHOLDERS.find((p) => p.key === key)?.read(values);
  return value === undefined || value === null ? "" : String(value);
};

/** Fills a prompt's placeholders. Unknown names are left as written (the definition check refuses them). */
export function renderCustomPrompt(template: string, values: CustomValues): string {
  return template.replace(PLACEHOLDER, (whole, key: string) => (KNOWN.has(key) ? valueOf(key, values) : whole));
}

/** The environment variable a placeholder reaches a shell command as, e.g. `ABOARD_TASK_NUMBER`. */
export const customEnvName = (env: string): string => brandEnv(env);

/** The variables a shell action gets on top of the server's environment (minus the board's own variables). */
export function customShellEnv(values: CustomValues): Record<string, string> {
  return Object.fromEntries(CUSTOM_PLACEHOLDERS.map((p) => [customEnvName(p.env), valueOf(p.key, values)]));
}

/** What a dry run or the settings form shows a shell action will run: the command, then its variables. */
export function describeShellRun(command: string, values: CustomValues): string {
  const env = Object.entries(customShellEnv(values)).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return `${command}\n\nwith\n${env.join("\n")}`;
}

type PrLink = Extract<TaskLink, { kind: "pr" }>;

/** What a check found that the action needs. */
export interface CustomData {
  /** The pull request the trigger was about, for `{{pr.url}}` and the agent's branch. */
  prLinkId?: string;
}

export const prLinksOf = (task: Pick<TaskSummary, "links">): PrLink[] =>
  task.links.filter((l): l is PrLink => l.kind === "pr");

/** The pull request a task's values name: the one the trigger was about, else its newest open one, else its newest. */
export function prOfTask(task: Pick<TaskSummary, "links">, linkId?: string): PrLink | null {
  const prs = prLinksOf(task);
  const open = prs.filter((l) => l.snapshot?.state === "open" || l.snapshot?.state === "draft");
  return (linkId ? prs.find((l) => l.id === linkId) : null) ?? open.at(-1) ?? prs.at(-1) ?? null;
}

/** Whether a task passes the filters (projects aside, which the scopes decide with them). Epics never do. */
export function customTaskMatches(filters: CustomFilters, task: TaskSummary): boolean {
  return (
    task.kind !== "epic" &&
    task.archivedAt === null &&
    (filters.labels.length === 0 || task.labels.some((l) => filters.labels.includes(l))) &&
    (!filters.epicId || task.parent?.id === filters.epicId)
  );
}

/** The values an action is given. */
export function customValues(
  def: Pick<CustomDefinition, "name">,
  project: Pick<Project, "title" | "workspaceRoot"> | null,
  task: TaskSummary | null,
  data: CustomData = {},
): CustomValues {
  const pr = task ? prOfTask(task, data.prLinkId) : null;
  return {
    automation: def.name,
    task: task ? { id: task.id, number: task.number, title: task.title, status: task.status } : null,
    pr: pr ? { url: pr.url } : null,
    project: project ? { name: project.title, path: project.workspaceRoot } : null,
  };
}

/** An agent action's prompt: the skill to use, the user's prompt filled in, and the task it is about. */
export function customAgentPrompt(
  def: Pick<CustomDefinition, "name" | "action">,
  values: CustomValues,
  task: TaskSummary,
  description: string | null,
): string {
  if (def.action.kind !== "agent") throw new Error("Not an agent action");
  const parts: string[] = [];
  if (def.action.skill) parts.push(`Use the ${def.action.skill} skill.`);
  parts.push(renderCustomPrompt(def.action.prompt, values));
  const context = [
    `Task #${task.number}: ${task.title} (${task.status})${values.project ? ` in ${values.project.name}` : ""}`,
    task.labels.length > 0 ? `Labels: ${task.labels.join(", ")}` : null,
    values.pr ? `Pull request: ${values.pr.url}` : null,
    description?.trim() ? `Description:\n${description.trim()}` : null,
    `Call get_task("#${task.number}") on the ${BRAND.id} MCP server for its plan and activity.`,
  ].filter(Boolean);
  parts.push(`---\nStarted by the ${BRAND.name} Autopilot automation "${def.name}".\n${context.join("\n")}`);
  return parts.join("\n\n");
}

/** Why a definition can't be saved, or null. Rules a field schema can't express alone. */
export function checkCustomDefinition(def: Pick<CustomDefinition, "trigger" | "filters" | "action">): string | null {
  const { trigger, filters, action } = def;
  if (trigger.kind === "schedule") {
    if (action.kind === "agent") {
      return "A schedule has no task for an agent to work on; use a shell command, or another trigger";
    }
    if (filters.labels.length > 0 || filters.epicId) {
      return "A schedule has no task, so it can only filter by project";
    }
  }
  if (trigger.kind === "status_change" && trigger.from === trigger.to) {
    return "Pick a different column to move from than to";
  }
  if (action.kind === "agent") {
    const unknown = placeholdersIn(action.prompt).find((key) => !KNOWN.has(key));
    if (unknown) return `The prompt names {{${unknown}}}, which isn't a placeholder`;
  } else {
    const named = placeholdersIn(action.command)[0];
    if (named) {
      const env = CUSTOM_PLACEHOLDERS.find((p) => p.key === named)?.env;
      return `Shell commands aren't filled in, so values can't be injected into them: read ${
        env ? `$${customEnvName(env)}` : "the environment variables"
      } instead of {{${named}}}`;
    }
  }
  return null;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  planned: "Planned",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
};

const PR_EVENT_LABEL: Record<CustomPrEvent, string> = {
  linked: "a pull request is linked",
  new_head: "a pull request gets new commits",
  checks_failing: "a pull request's checks fail",
  conflict: "a pull request has a merge conflict",
  merged: "a pull request is merged",
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "When a task moves into Review", "Every 6 hours": the trigger as one line. */
export function describeCustomTrigger(trigger: CustomTrigger): string {
  switch (trigger.kind) {
    case "status_change":
      return `When a task moves ${trigger.from ? `from ${STATUS_LABEL[trigger.from]} ` : ""}into ${STATUS_LABEL[trigger.to]}`;
    case "pr_event":
      return `When ${PR_EVENT_LABEL[trigger.event]}`;
    case "schedule": {
      const s = trigger.schedule;
      if (s.kind === "hourly") return s.everyHours === 1 ? "Every hour" : `Every ${s.everyHours} hours`;
      const days = s.days.length === 7 ? "Every day" : s.days.map((d) => DAY_NAMES[d]).join(", ");
      return `${days} at ${s.time}`;
    }
    case "stale":
      return `When a task has been in ${STATUS_LABEL[trigger.status]} for ${trigger.hours} hour${trigger.hours === 1 ? "" : "s"}`;
    case "blocker_finished":
      return "When a task's last blocker finishes";
  }
}

/** The latest hourly slot at or before `now`, counted from local midnight. */
export function latestHourlySlot(everyHours: number, now: Date): Date {
  const hour = Math.floor(now.getHours() / everyHours) * everyHours;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour);
}
