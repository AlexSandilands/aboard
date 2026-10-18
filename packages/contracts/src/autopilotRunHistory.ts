import { z } from "zod";
import { AutopilotRun } from "./autopilot.ts";

// The run history page: a paged, filterable list of an automation's runs, and deleting them by hand
// (docs/features/autopilot.md#run-history).

/** The `automation` value that lists the runs of every automation together. */
export const AUTOPILOT_ALL_RUNS = "all";

export const RUN_PAGE_DEFAULT = 50;
export const RUN_PAGE_MAX = 100;

/** A run younger than this is never deleted by hand: a pass could redo what its dedupe key stopped (a slot, a notice). */
export const RUN_DELETE_MIN_AGE_MS = 24 * 60 * 60_000;

const RunTime = z.iso.datetime({ offset: true });

/** What the history page filters by, and what "delete all matching" deletes. `since` is inclusive, `until` exclusive. */
export const AutopilotRunFilter = z.object({
  /** An automation's key, or `AUTOPILOT_ALL_RUNS`. */
  automation: z.string().min(1),
  projectId: z.string().min(1).optional(),
  since: RunTime.optional(),
  until: RunTime.optional(),
  /** Matches the run id, the project's title, a `#N` task number, and the summary and handover text. */
  q: z.string().trim().min(1).max(200).optional(),
});
export type AutopilotRunFilter = z.infer<typeof AutopilotRunFilter>;

/** `GET /api/autopilot/runs/history`: the filter plus where to continue from. */
export const ListAutopilotRunsQuery = AutopilotRunFilter.extend({
  /** The `nextCursor` of the previous page; leave out for the newest. */
  cursor: z.string().min(1).max(300).optional(),
  limit: z.coerce.number().int().min(1).max(RUN_PAGE_MAX).optional(),
});
export type ListAutopilotRunsQuery = z.infer<typeof ListAutopilotRunsQuery>;

export const AutopilotRunPage = z.object({
  runs: z.array(AutopilotRun),
  /** Null on the last page. Opaque: pass it back unchanged. */
  nextCursor: z.string().nullable(),
});
export type AutopilotRunPage = z.infer<typeof AutopilotRunPage>;

/** Why a run survived a delete, the first that applies in this order. */
export const AutopilotKeptReason = z.enum(["active", "worktree", "open_task", "latest_answer", "recent"]);
export type AutopilotKeptReason = z.infer<typeof AutopilotKeptReason>;

export const KEPT_REASON_TEXT: Record<AutopilotKeptReason, string> = {
  active: "still queued or running",
  worktree: "its worktree is still on disk",
  open_task: "on a task that isn't done (its counts and dedupe keys are still read)",
  latest_answer: "the latest answer of a scheduled agent, which its next run is handed",
  recent: "less than a day old",
};

/** `POST /api/autopilot/runs/delete`: either these runs, or every run matching a filter. */
export const DeleteAutopilotRunsInput = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(500).optional(),
    filter: AutopilotRunFilter.optional(),
    /** Count what would be deleted and what would be kept, and delete nothing. */
    preview: z.boolean().optional(),
  })
  .refine((input) => (input.ids === undefined) !== (input.filter === undefined), {
    message: "Pass either ids or filter",
  });
export type DeleteAutopilotRunsInput = z.infer<typeof DeleteAutopilotRunsInput>;

export const DeleteAutopilotRunsResult = z.object({
  preview: z.boolean(),
  /** Runs removed; in a preview, the runs that would be. */
  deleted: z.number().int(),
  /** Runs asked for that were left alone, with why. */
  kept: z.number().int(),
  keptReasons: z.array(z.object({ reason: AutopilotKeptReason, count: z.number().int() })),
});
export type DeleteAutopilotRunsResult = z.infer<typeof DeleteAutopilotRunsResult>;
