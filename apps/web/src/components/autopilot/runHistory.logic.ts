import { KEPT_REASON_TEXT, type AutopilotRunFilter, type DeleteAutopilotRunsResult } from "@repo/contracts";
import { z } from "zod";

/** The time presets of the history page's filter, in the order they're offered. `custom` takes `since` and `until`. */
export const RUN_RANGES = [
  { value: "all", label: "All time" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "custom", label: "Custom range" },
] as const;
export type RunRange = (typeof RUN_RANGES)[number]["value"];

const PRESET_MS: Record<"24h" | "7d" | "30d", number> = {
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

/** A calendar date as a date input holds it (YYYY-MM-DD) that is a real day. */
const DateOnly = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)));

/** The run history page's URL params. Anything that doesn't parse is dropped, so a stale link still opens the page. */
export const RunHistorySearch = z.object({
  /** A project id; none is every project. */
  project: z.string().min(1).optional().catch(undefined),
  /** None is all time. */
  range: z.enum(["24h", "7d", "30d", "custom"]).optional().catch(undefined),
  /** With `range=custom`: the first day, in the local time zone. */
  since: DateOnly.optional().catch(undefined),
  /** With `range=custom`: the last day, included. */
  until: DateOnly.optional().catch(undefined),
  q: z.string().optional().catch(undefined),
});
export type RunHistorySearch = z.infer<typeof RunHistorySearch>;

/** Midnight at the start of a local calendar day, plus `days`, as an ISO instant. */
export function localDayStart(date: string, days = 0): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day + days).toISOString();
}

/**
 * The server's filter for a page's URL params. A custom range's days are local and both included, so `until` is the
 * start of the day after. Search text is trimmed, and nothing is sent for blank text.
 */
export function runHistoryFilter(automation: string, search: RunHistorySearch, now: Date): AutopilotRunFilter {
  const filter: AutopilotRunFilter = { automation };
  if (search.project) filter.projectId = search.project;
  if (search.range === "custom") {
    if (search.since) filter.since = localDayStart(search.since);
    if (search.until) filter.until = localDayStart(search.until, 1);
  } else if (search.range) {
    filter.since = new Date(now.getTime() - PRESET_MS[search.range]).toISOString();
  }
  const q = search.q?.trim();
  if (q) filter.q = q;
  return filter;
}

/** The query string of a history request: the filter, and the cursor of the page after what is loaded. */
export function runHistoryParams(filter: AutopilotRunFilter, cursor?: string): URLSearchParams {
  const params = new URLSearchParams({ automation: filter.automation });
  for (const key of ["projectId", "since", "until", "q"] as const) {
    const value = filter[key];
    if (value) params.set(key, value);
  }
  if (cursor) params.set("cursor", cursor);
  return params;
}

/** The pages' runs in order, each once: a refetch may move a run to the page before. */
export function runsOfPages<T extends { id: string }>(pages: ReadonlyArray<{ runs: readonly T[] }> | undefined): T[] {
  const seen = new Set<string>();
  const runs: T[] = [];
  for (const run of pages?.flatMap((p) => p.runs) ?? []) {
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    runs.push(run);
  }
  return runs;
}

/** Whether a filter narrows anything beyond the automation. */
export const isNarrowed = (search: RunHistorySearch): boolean =>
  !!search.project || !!search.range || !!search.q?.trim();

/** "Orchestrate runs in Alpha from 3 Mar to 5 Mar matching "x"": what a delete-all would act on, for its dialog. */
export function describeRunFilter(
  automationTitle: string | null,
  projectTitle: string | null,
  search: RunHistorySearch,
): string {
  const parts = [automationTitle ? `${automationTitle} runs` : "Runs of every automation"];
  if (projectTitle) parts.push(`in ${projectTitle}`);
  if (search.range === "custom") {
    if (search.since) parts.push(`from ${search.since}`);
    if (search.until) parts.push(`until ${search.until}`);
  } else if (search.range) {
    parts.push(`from the ${RUN_RANGES.find((r) => r.value === search.range)!.label.toLowerCase()}`);
  }
  const q = search.q?.trim();
  if (q) parts.push(`matching “${q}”`);
  return parts.join(" ");
}

/** What the delete dialog says about the runs it will leave: "2 on a task that isn't done…, 1 still queued…". */
export function keptText(result: Pick<DeleteAutopilotRunsResult, "keptReasons">): string {
  return result.keptReasons.map(({ reason, count }) => `${count} ${KEPT_REASON_TEXT[reason]}`).join("; ");
}

/** The title of the delete dialog. */
export function deleteTitle(count: number): string {
  return count === 1 ? "Delete 1 run?" : `Delete ${count} runs?`;
}
