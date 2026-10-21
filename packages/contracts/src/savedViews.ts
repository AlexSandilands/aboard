import { z } from "zod";

// Board filters as the board's URL search params, and the named sets of them a user saves as views
// (docs/features/saved-views.md). The params are the one representation: a URL, a saved view and the board's
// filter state are the same record, so any view can be bookmarked or shared.

/** Longest name of a saved view. */
export const SAVED_VIEW_NAME_MAX = 60;
/** Most views one board keeps. */
export const SAVED_VIEWS_MAX = 50;

// The router parses a param as JSON when it can, so `?q=2024` arrives as a number and `?attention=true` as a boolean.
const text = z.union([z.string(), z.number(), z.boolean()]).transform(String).optional().catch(undefined);
const flag = z
  .unknown()
  .transform((value): true | undefined => (value === true || value === "true" ? true : undefined))
  .optional()
  .catch(undefined);

/**
 * The filter params of the board. Lists are comma-separated and a flag is `true` or absent, so a default board has
 * an empty search. Values that don't parse are dropped on read (`readBoardFilters` in the web app).
 */
export const BoardFilterParams = z.object({
  /** Scopes the board to some projects: their ids, comma-separated. One id is a list of one. */
  project: text,
  /** Shows only that epic's band. */
  epic: text,
  /** Labels, any of them. */
  labels: text,
  /** Task statuses, any of them. */
  status: text,
  /** Suggested model tiers, any of them; `none` is a task with no tier. */
  tier: text,
  /** Autopilot flags, any of them: `on`, `off` or `default`. */
  autopilot: text,
  /** Free text: title, number, ticket key or label. */
  q: text,
  /** Only tasks that need attention. */
  attention: flag,
  /** Only tasks with a pull request. */
  pr: flag,
  /** Only tasks blocked by an open task. */
  blocked: flag,
  /** Only priority tasks. */
  priority: flag,
  /** Only In Progress tasks, from every project whatever the project scope. */
  inprogress: flag,
  /** Includes archived tasks. */
  archived: flag,
});
export type BoardFilterParams = z.infer<typeof BoardFilterParams>;

/**
 * A `?project=` value as a list of project ids: blanks and repeats dropped. With the board's projects in lane order
 * (`order`), unknown ids are dropped too and the rest come in that order, so a subset always reads the same.
 */
export function parseProjectScope(value: string | undefined, order?: ReadonlyArray<string>): string[] {
  if (!value) return [];
  const named = [
    ...new Set(
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
  if (!order) return named;
  const known = new Set(named);
  return order.filter((id) => known.has(id));
}

/**
 * A project list as the `?project=` value, or undefined for the whole board: no ids, or every project ticked
 * (`order` is the board's projects in lane order, which the ids are written in).
 */
export function formatProjectScope(ids: ReadonlyArray<string>, order: ReadonlyArray<string>): string | undefined {
  const chosen = parseProjectScope(ids.join(","), order);
  return chosen.length === 0 || chosen.length === order.length ? undefined : chosen.join(",");
}

export const SavedView = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(SAVED_VIEW_NAME_MAX),
  filters: BoardFilterParams,
});
export type SavedView = z.infer<typeof SavedView>;

/** The whole list, replaced as one: views are few, and the order is the user's. */
export const SavedViews = z.array(SavedView).max(SAVED_VIEWS_MAX);
export type SavedViews = z.infer<typeof SavedViews>;
