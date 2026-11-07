import type { AutomationWeek, AutopilotAutoPause, AutopilotHint, AutopilotRun } from "@repo/contracts";

/** One day's bar in This week: its height out of 1 (the busiest day is 1), and the failed part of it. */
export interface WeekBar {
  date: string;
  runs: number;
  failed: number;
  height: number;
  failedHeight: number;
}

/** The week's bars; an empty week has none taller than zero. */
export function weekBars(days: AutomationWeek["days"]): WeekBar[] {
  const most = Math.max(1, ...days.map((d) => d.runs));
  return days.map((d) => ({ ...d, height: d.runs / most, failedHeight: d.failed / most }));
}

/** "Mon 3": a day's short label, in the local time zone. */
export function dayLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

/** "$1.84", "$0.004", "$0": a week's spend. */
export function spendText(usd: number): string {
  if (usd === 0) return "$0";
  return usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

/** The hints about one automation; with null, Autopilot-wide ones. */
export const hintsFor = (hints: readonly AutopilotHint[], automation: string | null): AutopilotHint[] =>
  hints.filter((h) => h.automation === automation);

/** The projects an automation has paused itself in. */
export const pausesFor = (pauses: readonly AutopilotAutoPause[], automation: string): AutopilotAutoPause[] =>
  pauses.filter((p) => p.automation === automation);

/** "Paused in storefront", "Paused in 3 projects": the list row's line for an automation that paused itself. */
export function pausedText(pauses: readonly AutopilotAutoPause[]): string | null {
  if (pauses.length === 0) return null;
  return pauses.length === 1 ? `Paused in ${pauses[0]!.projectTitle}` : `Paused in ${pauses.length} projects`;
}

/**
 * Whether the run's automation has paused itself in the run's project. A retry there would only wait for Resume, so
 * Retry isn't offered.
 */
export const pausedForRun = (
  pauses: readonly AutopilotAutoPause[] | undefined,
  run: Pick<AutopilotRun, "automation" | "projectId">,
): boolean => !!pauses?.some((p) => p.automation === run.automation && p.projectId === run.projectId);
