import {
  MODEL_TIERS,
  TASK_STATUSES,
  type BoardFilterParams,
  type ModelTier,
  type TaskStatus,
  type TaskSummary,
} from "@repo/contracts";
import { formatLabelFilter, parseLabelFilter } from "~/components/labels/labels.logic";

/** A task's Autopilot flag as the `?autopilot=` filter names it: true is `on`, false is `off`, null is `default`. */
export type AutopilotChoice = "on" | "off" | "default";
/** A task's suggested model tier, or `none` for a task with no tier. */
export type TierChoice = ModelTier | "none";

export const AUTOPILOT_CHOICES: ReadonlyArray<{ value: AutopilotChoice; label: string }> = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
  { value: "default", label: "Default" },
];

export const TIER_CHOICES: ReadonlyArray<{ value: TierChoice; label: string }> = [
  ...MODEL_TIERS.map(({ value, label }) => ({ value, label })),
  { value: "none", label: "No tier" },
];

/**
 * The board's filters, read from its URL params (`BoardFilterParams`). Lists are in the order their choices are
 * listed, so the same filters always make the same URL.
 */
export interface FilterState {
  statuses: ReadonlyArray<TaskStatus>;
  tiers: ReadonlyArray<TierChoice>;
  autopilot: ReadonlyArray<AutopilotChoice>;
  labels: ReadonlyArray<string>;
  epicId: string | null;
  /** Free text: title, `#number`, Jira key or label. */
  text: string;
  attention: boolean;
  hasPr: boolean;
  blocked: boolean;
  priority: boolean;
  /** Only In Progress tasks from every project, whatever the project scope. */
  inProgress: boolean;
  archived: boolean;
}

export const EMPTY_FILTERS: FilterState = {
  statuses: [],
  tiers: [],
  autopilot: [],
  labels: [],
  epicId: null,
  text: "",
  attention: false,
  hasPr: false,
  blocked: false,
  priority: false,
  inProgress: false,
  archived: false,
};

/** Every param a filter set can hold, `project` included: the keys a view replaces when it is applied. */
export const FILTER_PARAM_KEYS = [
  "project",
  "epic",
  "labels",
  "status",
  "tier",
  "autopilot",
  "q",
  "attention",
  "pr",
  "blocked",
  "priority",
  "inprogress",
  "archived",
] as const satisfies ReadonlyArray<keyof BoardFilterParams>;

const STATUS_VALUES = TASK_STATUSES.map((s) => s.value);
const TIER_VALUES = TIER_CHOICES.map((c) => c.value);
const AUTOPILOT_VALUES = AUTOPILOT_CHOICES.map((c) => c.value);

/** The listed choices that `value` names, in the list's order. Unknown and repeated names are dropped. */
function parseChoices<T extends string>(value: string | undefined, choices: ReadonlyArray<T>): T[] {
  if (!value) return [];
  const named = new Set(value.split(",").map((part) => part.trim()));
  return choices.filter((choice) => named.has(choice));
}

function formatChoices(chosen: ReadonlyArray<string>): string | undefined {
  return chosen.length ? chosen.join(",") : undefined;
}

export function readFilters(params: BoardFilterParams): FilterState {
  return {
    statuses: parseChoices(params.status, STATUS_VALUES),
    tiers: parseChoices(params.tier, TIER_VALUES),
    autopilot: parseChoices(params.autopilot, AUTOPILOT_VALUES),
    labels: parseLabelFilter(params.labels),
    epicId: params.epic || null,
    text: params.q?.trim() ?? "",
    attention: params.attention === true,
    hasPr: params.pr === true,
    blocked: params.blocked === true,
    priority: params.priority === true,
    inProgress: params.inprogress === true,
    archived: params.archived === true,
  };
}

/**
 * The params for a filter set, with every unset one left out. Every key is present so a navigation that spreads it
 * over the current search clears what the set doesn't hold.
 */
export function filterParams(filters: FilterState, project?: string | null): BoardFilterParams {
  return {
    project: project || undefined,
    epic: filters.epicId ?? undefined,
    labels: formatLabelFilter(filters.labels),
    status: formatChoices(filters.statuses),
    tier: formatChoices(filters.tiers),
    autopilot: formatChoices(filters.autopilot),
    q: filters.text || undefined,
    attention: filters.attention || undefined,
    pr: filters.hasPr || undefined,
    blocked: filters.blocked || undefined,
    priority: filters.priority || undefined,
    inprogress: filters.inProgress || undefined,
    archived: filters.archived || undefined,
  };
}

/** The filter params of a search (the board's, or a saved view's), without `task` or anything else, normalised. */
export function normalizeParams(search: BoardFilterParams): BoardFilterParams {
  return filterParams(readFilters(search), search.project);
}

/** Whether two searches hold the same filters, whatever order their lists were written in. */
export function sameFilters(a: BoardFilterParams, b: BoardFilterParams): boolean {
  const left = normalizeParams(a);
  const right = normalizeParams(b);
  return FILTER_PARAM_KEYS.every((key) => left[key] === right[key]);
}

/** How many kinds of filter are set. The project scope has its own place in the header and doesn't count. */
export function activeFilterCount(filters: FilterState): number {
  return [
    filters.statuses.length > 0,
    filters.tiers.length > 0,
    filters.autopilot.length > 0,
    filters.labels.length > 0,
    filters.epicId !== null,
    filters.text !== "",
    filters.attention,
    filters.hasPr,
    filters.blocked,
    filters.priority,
    filters.inProgress,
    filters.archived,
  ].filter(Boolean).length;
}

/** The params to put over the current search to turn every filter off but the project scope. */
export function clearedParams(): BoardFilterParams {
  return { ...filterParams(EMPTY_FILTERS), project: undefined };
}

/** Whether a view has nothing to apply, so saving it would save an empty board. */
export function isEmptyView(params: BoardFilterParams): boolean {
  const normalized = normalizeParams(params);
  return FILTER_PARAM_KEYS.every((key) => normalized[key] === undefined);
}

export function toggleChoice<T extends string>(chosen: ReadonlyArray<T>, choice: T, choices: ReadonlyArray<T>): T[] {
  const next = chosen.includes(choice) ? chosen.filter((c) => c !== choice) : [...chosen, choice];
  return choices.filter((c) => next.includes(c));
}

/** The choice a task's Autopilot flag stands for. */
export function autopilotChoice(task: Pick<TaskSummary, "autopilot">): AutopilotChoice {
  return task.autopilot === true ? "on" : task.autopilot === false ? "off" : "default";
}

/**
 * The filters that look at a task itself, never at its epic: its status, tier, Autopilot flag, blocked and priority.
 * (The text, attention, PR and label filters also match a task through its epic.)
 */
export type TaskOwnFilters = Pick<FilterState, "statuses" | "tiers" | "autopilot" | "blocked" | "priority">;

export function hasTaskOwnFilters(filters: TaskOwnFilters): boolean {
  return (
    filters.statuses.length > 0 ||
    filters.tiers.length > 0 ||
    filters.autopilot.length > 0 ||
    filters.blocked ||
    filters.priority
  );
}

export function matchesTaskOwnFilters(task: TaskSummary, filters: TaskOwnFilters): boolean {
  if (filters.statuses.length > 0 && !filters.statuses.includes(task.status)) return false;
  if (filters.tiers.length > 0 && !filters.tiers.includes(task.suggestedModel?.tier ?? "none")) return false;
  if (filters.autopilot.length > 0 && !filters.autopilot.includes(autopilotChoice(task))) return false;
  if (filters.blocked && !task.blocked) return false;
  if (filters.priority && !task.priority) return false;
  return true;
}
