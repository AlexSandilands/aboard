import {
  RECURRING_EVERY_DAYS_MAX,
  RECURRING_NAME_MAX,
  isoDate,
  type CreateRecurringRuleInput,
  type CreateTemplateInput,
  type RecurringRuleView,
  type RecurringSchedule,
  type TaskSummary,
  type TaskTemplate,
} from "@repo/contracts";

/** A rule as the editor holds it: numbers and dates as typed. */
export interface RuleForm {
  name: string;
  templateId: string;
  kind: "weekly" | "every";
  /** 0 is Sunday. */
  days: number[];
  time: string;
  /** As typed. */
  everyDays: string;
  /** YYYY-MM-DD. */
  startDate: string;
  flagAutopilot: boolean;
  enabled: boolean;
}

/** Weekday buttons start on Monday; the values are `Date#getDay` numbers. */
export const WEEKDAYS: ReadonlyArray<{ value: number; short: string; long: string }> = [
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
  { value: 0, short: "Sun", long: "Sunday" },
];

export function emptyRuleForm(today: Date = new Date()): RuleForm {
  return {
    name: "",
    templateId: "",
    kind: "weekly",
    days: [1],
    time: "09:00",
    everyDays: "14",
    startDate: isoDate(today),
    flagAutopilot: false,
    enabled: true,
  };
}

export function formFromRule(rule: RecurringRuleView, today: Date = new Date()): RuleForm {
  const base = emptyRuleForm(today);
  return {
    ...base,
    name: rule.name,
    templateId: rule.templateId ?? "",
    kind: rule.schedule.kind,
    ...(rule.schedule.kind === "weekly"
      ? { days: rule.schedule.days }
      : { everyDays: String(rule.schedule.everyDays), startDate: rule.schedule.startDate }),
    time: rule.schedule.time,
    flagAutopilot: rule.flagAutopilot,
    enabled: rule.enabled,
  };
}

/** The form as a schedule; kept apart so a change of schedule can be told from other edits. */
export function scheduleFromForm(
  form: RuleForm,
): { ok: true; schedule: RecurringSchedule } | { ok: false; error: string } {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time)) return { ok: false, error: "Pick a time of day" };
  if (form.kind === "weekly") {
    if (form.days.length === 0) return { ok: false, error: "Pick at least one weekday" };
    return { ok: true, schedule: { kind: "weekly", days: [...form.days].sort((a, b) => a - b), time: form.time } };
  }
  const everyDays = Number(form.everyDays);
  if (!Number.isInteger(everyDays) || everyDays < 1 || everyDays > RECURRING_EVERY_DAYS_MAX) {
    return { ok: false, error: `Repeat every 1 to ${RECURRING_EVERY_DAYS_MAX} days` };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.startDate) || Number.isNaN(Date.parse(form.startDate))) {
    return { ok: false, error: "Pick a start date" };
  }
  return { ok: true, schedule: { kind: "every", everyDays, startDate: form.startDate, time: form.time } };
}

export type RuleFormResult = { ok: true; input: CreateRecurringRuleInput } | { ok: false; error: string };

export function formToInput(form: RuleForm): RuleFormResult {
  const name = form.name.trim();
  if (!name) return { ok: false, error: "Give the rule a name" };
  if (name.length > RECURRING_NAME_MAX)
    return { ok: false, error: `Keep the name under ${RECURRING_NAME_MAX} characters` };
  if (!form.templateId) return { ok: false, error: "Pick the template the tasks are made from" };
  const schedule = scheduleFromForm(form);
  if (!schedule.ok) return schedule;
  return {
    ok: true,
    input: {
      name,
      templateId: form.templateId,
      schedule: schedule.schedule,
      flagAutopilot: form.flagAutopilot,
      enabled: form.enabled,
    },
  };
}

/** Templates a project's rule can use: board-wide ones and the project's own, with a title pattern. */
export const usableTemplates = (templates: readonly TaskTemplate[], projectId: string): TaskTemplate[] =>
  templates.filter((t) => (t.projectId === null || t.projectId === projectId) && t.titlePattern.trim() !== "");

const WHEN = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** "Mon, 19 Oct, 09:00", or what is happening when the slot has already come. */
export function nextDueLabel(rule: RecurringRuleView, now: Date = new Date()): string {
  if (!rule.enabled) return "Paused";
  if (!rule.nextDueAt) return "No upcoming slot";
  const due = new Date(rule.nextDueAt);
  return due.getTime() <= now.getTime() ? "Due now" : WHEN.format(due);
}

/** What became of the last task the rule made, for the row's second line. */
export function lastTaskLabel(rule: RecurringRuleView, tasks: readonly TaskSummary[]): string | null {
  if (!rule.lastTaskId) return null;
  const task = tasks.find((t) => t.id === rule.lastTaskId);
  if (!task) return "Last task is gone";
  return `#${task.number} ${task.archivedAt ? "archived" : task.status === "done" ? "done" : "still open"}`;
}

/** An example rule: a template to create for the project, and the schedule to run it on. */
export interface RuleSuggestion {
  id: string;
  name: string;
  summary: string;
  template: Pick<CreateTemplateInput, "titlePattern" | "description" | "labels">;
  schedule: RecurringSchedule;
}

const weekly = (day: number, time = "09:00"): RecurringSchedule => ({ kind: "weekly", days: [day], time });

export const RULE_SUGGESTIONS: readonly RuleSuggestion[] = [
  {
    id: "dependency-bumps",
    name: "Weekly dependency bumps",
    summary: "Mondays at 09:00",
    template: {
      titlePattern: "Bump dependencies {{date}}",
      description: "Update dependencies, run the checks and open a PR for what passes.\n",
      labels: ["deps", "chore"],
    },
    schedule: weekly(1),
  },
  {
    id: "pnpm-audit",
    name: "Weekly security audit",
    summary: "Tuesdays at 09:00",
    template: {
      titlePattern: "Security audit {{date}}",
      description: "Run `pnpm audit`, fix or document what it finds, and note anything that has to wait.\n",
      labels: ["security", "chore"],
    },
    schedule: weekly(2),
  },
  {
    id: "docs-drift",
    name: "Monthly docs drift check",
    summary: "Every 28 days at 09:00",
    template: {
      titlePattern: "Docs drift check {{date}}",
      description: "Compare the docs with what the code does now, and fix or file what has drifted.\n",
      labels: ["docs", "chore"],
    },
    schedule: { kind: "every", everyDays: 28, startDate: "2026-01-05", time: "09:00" },
  },
  {
    id: "stale-branches",
    name: "Stale branch and worktree cleanup",
    summary: "Fridays at 16:00",
    template: {
      titlePattern: "Clean up stale branches and worktrees {{date}}",
      description:
        "List branches and worktrees with no recent work or an open PR, and remove the ones that are done.\n",
      labels: ["chore"],
    },
    schedule: weekly(5, "16:00"),
  },
  {
    id: "flaky-tests",
    name: "Flaky test sweep",
    summary: "Every 14 days at 09:00",
    template: {
      titlePattern: "Flaky test sweep {{date}}",
      description: "Find tests that failed and passed on rerun in CI, and fix or quarantine them.\n",
      labels: ["tests", "chore"],
    },
    schedule: { kind: "every", everyDays: 14, startDate: "2026-01-05", time: "09:00" },
  },
  {
    id: "release-prep",
    name: "Release prep",
    summary: "Thursdays at 10:00",
    template: {
      titlePattern: "Prepare the release {{date}}",
      description: "Check the changelog and version, run the full checks and list what is left before releasing.\n",
      labels: ["release"],
    },
    schedule: weekly(4, "10:00"),
  },
  {
    id: "t3-token",
    name: "Renew the T3 token",
    summary: "Every 28 days at 09:00",
    template: {
      titlePattern: "Renew the T3 token {{date}}",
      description: "Create a new T3 Code token and update it under Settings, before the current one expires.\n",
      labels: ["chore"],
    },
    schedule: { kind: "every", everyDays: 28, startDate: "2026-01-05", time: "09:00" },
  },
];

/** The suggestions a project hasn't taken yet: none whose name matches one of its rules. */
export const remainingSuggestions = (rules: readonly Pick<RecurringRuleView, "name">[]): RuleSuggestion[] => {
  const taken = new Set(rules.map((r) => r.name.trim().toLowerCase()));
  return RULE_SUGGESTIONS.filter((s) => !taken.has(s.name.toLowerCase()));
};

/** A suggested interval counts from the day it is added, whatever start date the suggestion lists. */
export function anchorSchedule(schedule: RecurringSchedule, today: Date = new Date()): RecurringSchedule {
  if (schedule.kind === "weekly") return schedule;
  return { ...schedule, startDate: isoDate(today) };
}
