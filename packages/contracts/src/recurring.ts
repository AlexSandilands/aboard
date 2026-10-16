import { z } from "zod";

// Recurring tasks: an Autopilot automation that creates a task from a template on a schedule. A rule belongs to one
// project; the schedule maths here is shared so the UI can show when a rule is next due (docs/features/autopilot.md).

export const RECURRING_NAME_MAX = 80;
export const RECURRING_EVERY_DAYS_MAX = 365;

/** The automation's key. Stored in settings and runs, so never renamed. */
export const AUTOPILOT_RECURRING = "recurring";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** "HH:mm" on a 24-hour clock, in the server's local time. */
const Time = z.string().regex(TIME, "Use a time like 09:00");

/** "YYYY-MM-DD", a real calendar date. */
const CalendarDate = z
  .string()
  .regex(DATE, "Use a date like 2026-10-16")
  .refine((value) => {
    const [y, m, d] = value.split("-").map(Number) as [number, number, number];
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }, "Not a calendar date");

/** On the chosen weekdays (0 is Sunday, as in `Date#getDay`) at a time. */
export const WeeklySchedule = z.object({
  kind: z.literal("weekly"),
  days: z
    .array(z.number().int().min(0).max(6))
    .min(1, "Pick at least one weekday")
    .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
  time: Time,
});

/** Every N days at a time, counted from a start date (which is itself one of the days). */
export const IntervalSchedule = z.object({
  kind: z.literal("every"),
  everyDays: z.number().int().min(1).max(RECURRING_EVERY_DAYS_MAX),
  startDate: CalendarDate,
  time: Time,
});

export const RecurringSchedule = z.discriminatedUnion("kind", [WeeklySchedule, IntervalSchedule]);
export type RecurringSchedule = z.infer<typeof RecurringSchedule>;

export const RecurringRule = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  /** The template the tasks are made from; null once it was deleted, and the rule fails until it is changed. */
  templateId: z.string().nullable(),
  schedule: RecurringSchedule,
  /** Whether the tasks it creates carry the Autopilot flag (On). */
  flagAutopilot: z.boolean(),
  enabled: z.boolean(),
  /** Slots up to here are dealt with: created, skipped or deliberately passed over. The next one is after it. */
  lastDueAt: z.string(),
  /** The task the rule created last, for the skip-while-open check. */
  lastTaskId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RecurringRule = z.infer<typeof RecurringRule>;

/** A rule as the API returns it. */
export const RecurringRuleView = RecurringRule.extend({
  /** The first slot after `lastDueAt`; in the past when it is waiting for the next pass or is being skipped. */
  nextDueAt: z.string().nullable(),
});
export type RecurringRuleView = z.infer<typeof RecurringRuleView>;

export const CreateRecurringRuleInput = z.object({
  name: z.string().trim().min(1).max(RECURRING_NAME_MAX),
  /** A template (id) board-wide or in the rule's project. */
  templateId: z.string().min(1),
  schedule: RecurringSchedule,
  flagAutopilot: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type CreateRecurringRuleInput = z.infer<typeof CreateRecurringRuleInput>;

export const UpdateRecurringRuleInput = CreateRecurringRuleInput.partial();
export type UpdateRecurringRuleInput = z.infer<typeof UpdateRecurringRuleInput>;

const DAY_MS = 86_400_000;

/** Whole days since the epoch of a local calendar date, so day arithmetic never meets a DST change. */
const dayNumber = (date: Date): number =>
  Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);

const dayOfDate = (value: string): number => {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
};

/**
 * The local instant `time` on a calendar day. A time the clock skips on a spring-forward night lands an hour
 * later; one it repeats on a fall-back night is the first.
 */
const at = (day: number, time: string): Date => {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const date = new Date(day * DAY_MS);
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h, m);
};

const isSlotDay = (schedule: RecurringSchedule, day: number): boolean => {
  if (schedule.kind === "weekly") return schedule.days.includes(new Date(day * DAY_MS).getUTCDay());
  const since = day - dayOfDate(schedule.startDate);
  return since >= 0 && since % schedule.everyDays === 0;
};

/**
 * The first slot strictly after `after`, in local time. Null only when none falls within a year of it (or of the
 * start date, for an interval).
 */
export function nextDue(schedule: RecurringSchedule, after: Date): Date | null {
  const first = dayNumber(after);
  const startDay = schedule.kind === "every" ? dayOfDate(schedule.startDate) : first;
  // A year and a bit covers the longest interval; starting at the start date skips the empty days before it.
  const from = Math.max(first, startDay);
  for (let day = from; day <= from + RECURRING_EVERY_DAYS_MAX + 7; day++) {
    if (!isSlotDay(schedule, day)) continue;
    const slot = at(day, schedule.time);
    if (slot.getTime() > after.getTime()) return slot;
  }
  return null;
}

/**
 * The latest slot after `after` that is already due at `now`, or null. Only the latest: a board that was off for
 * three Mondays gets one catch-up task, not three.
 */
export function latestDue(schedule: RecurringSchedule, now: Date, after: Date): Date | null {
  const floor = dayNumber(after) - 1;
  for (let day = dayNumber(now); day >= floor; day--) {
    if (!isSlotDay(schedule, day)) continue;
    const slot = at(day, schedule.time);
    if (slot.getTime() > now.getTime()) continue;
    return slot.getTime() > after.getTime() ? slot : null;
  }
  return null;
}

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** "Mondays and Thursdays at 09:00", "Every 14 days at 09:00". */
export function describeSchedule(schedule: RecurringSchedule): string {
  if (schedule.kind === "every") {
    return `${schedule.everyDays === 1 ? "Every day" : `Every ${schedule.everyDays} days`} at ${schedule.time}`;
  }
  const names = schedule.days.map((d) => `${WEEKDAY_NAMES[d]}s`);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
  return schedule.days.length === 7 ? `Every day at ${schedule.time}` : `${list} at ${schedule.time}`;
}
