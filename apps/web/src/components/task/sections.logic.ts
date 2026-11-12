import { reviewBadgeLabel, type AttentionReason, type TaskDetail, type TaskRelation } from "@repo/contracts";
import { topAttention } from "~/components/board/board.logic";
import { formatElapsedDurationLabel } from "~/lib/timestampFormat";
import { mayState } from "./automation.logic";
import { isSessionLink, type PlainLink } from "./links.logic";
import { usageSummary } from "./usage.logic";

type PrLink = Extract<PlainLink, { kind: "pr" }>;

/** Where the task's details show: the docked side panel, or the task window over the board. */
export type TaskPanelLayout = "panel" | "window";

/** Detail-panel sections the user can collapse, reorder and hide, in default order. */
export const SECTION_IDS = [
  "labels",
  "sessions",
  "usage",
  "links",
  "relations",
  "autopilot",
  "review",
  "plan",
  "details",
  "activity",
] as const;

export type SectionId = (typeof SECTION_IDS)[number];

export const SECTION_TITLES: Record<SectionId, string> = {
  labels: "Labels",
  sessions: "Sessions",
  usage: "Usage",
  links: "Links",
  relations: "Relations",
  review: "Local review",
  autopilot: "Autopilot",
  plan: "Plan",
  details: "Details",
  activity: "Activity",
};

/**
 * Which column of the task window a section sits in, from about 56rem wide: by default the task's story (Plan,
 * Details, Activity) in the main column, its properties in the rail beside it. The user can move any section to the
 * other column (SectionLayout.columns); the saved order, hidden and collapsed choices apply within each column.
 * Narrower, and in the docked panel, the sections are one column in saved order.
 */
export type SectionColumn = "main" | "rail";

const isSectionColumn = (value: unknown): value is SectionColumn => value === "main" || value === "rail";

export const SECTION_COLUMNS: Record<SectionId, SectionColumn> = {
  labels: "rail",
  sessions: "rail",
  usage: "rail",
  links: "rail",
  relations: "rail",
  autopilot: "rail",
  review: "rail",
  plan: "main",
  details: "main",
  activity: "main",
};

export const SECTION_COLUMN_TITLES: Record<SectionColumn, string> = { main: "Main column", rail: "Side column" };

export interface SectionLayout {
  order: SectionId[];
  hidden: SectionId[];
  /** Explicit choices only; a missing id follows collapsedByDefault. */
  collapsed: Partial<Record<SectionId, boolean>>;
  /** The task window column of each section the user moved; a missing id sits in its SECTION_COLUMNS default. */
  columns: Partial<Record<SectionId, SectionColumn>>;
}

/** The column a section sits in: the user's choice, else its default. */
export function sectionColumn(columns: SectionLayout["columns"], id: SectionId): SectionColumn {
  return columns[id] ?? SECTION_COLUMNS[id];
}

/** The sections of `ids` in a column, in their order; every section without a column. */
export function sectionsInColumn(
  ids: ReadonlyArray<SectionId>,
  column: SectionColumn | undefined,
  columns: SectionLayout["columns"] = {},
): SectionId[] {
  return column ? ids.filter((id) => sectionColumn(columns, id) === column) : [...ids];
}

/** Sections added after others existed sit before the one they were split from in a saved order, not at the end. */
const SECTION_ANCHORS: Partial<Record<SectionId, SectionId>> = { sessions: "links", usage: "links" };

export const isSectionId = (value: unknown): value is SectionId => SECTION_IDS.includes(value as SectionId);

/**
 * Re-validates stored values: unknown ids and duplicates are dropped, sections added since are appended (or placed
 * by SECTION_ANCHORS). Sessions used to be part of Links, so a layout saved before it existed hides and collapses it
 * with Links.
 */
export function normalizeSectionLayout(stored: {
  order?: unknown;
  hidden?: unknown;
  collapsed?: unknown;
  columns?: unknown;
}): SectionLayout {
  const known = (value: unknown) => (Array.isArray(value) ? [...new Set(value.filter(isSectionId))] : []);
  const order = known(stored.order);
  const hidden = known(stored.hidden);
  const beforeSessions = order.length > 0 && !order.includes("sessions");
  if (beforeSessions && hidden.includes("links")) hidden.push("sessions");
  for (const id of SECTION_IDS.filter((section) => !order.includes(section))) {
    const anchor = SECTION_ANCHORS[id];
    const at = anchor ? order.indexOf(anchor) : -1;
    if (at >= 0) order.splice(at, 0, id);
    else order.push(id);
  }
  const collapsed: SectionLayout["collapsed"] = {};
  if (stored.collapsed && typeof stored.collapsed === "object") {
    for (const [id, value] of Object.entries(stored.collapsed)) {
      if (isSectionId(id) && typeof value === "boolean") collapsed[id] = value;
    }
  }
  if (beforeSessions && typeof collapsed.links === "boolean" && collapsed.sessions === undefined) {
    collapsed.sessions = collapsed.links;
  }
  const columns: SectionLayout["columns"] = {};
  if (stored.columns && typeof stored.columns === "object") {
    for (const [id, value] of Object.entries(stored.columns)) {
      // A choice that matches the default is dropped, so a later change to the default still reaches it.
      if (isSectionId(id) && isSectionColumn(value) && value !== SECTION_COLUMNS[id]) columns[id] = value;
    }
  }
  return {
    order,
    hidden: SECTION_IDS.filter((id) => hidden.includes(id)),
    collapsed,
    columns,
  };
}

/** Moves `id` to where `overId` sits, as a sortable list drop does. */
export function moveSection(order: ReadonlyArray<SectionId>, id: SectionId, overId: SectionId): SectionId[] {
  const from = order.indexOf(id);
  const to = order.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return [...order];
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/**
 * Whether the task window splits into two columns: only when each has a section to show (not hidden, not left out for
 * this task). Otherwise one column, rather than an empty strip beside the other.
 */
export function splitsIntoColumns(
  layout: Pick<SectionLayout, "order" | "hidden" | "columns">,
  exclude: ReadonlyArray<SectionId> = [],
): boolean {
  const showsIn = (column: SectionColumn) =>
    sectionsInColumn(layout.order, column, layout.columns).some(
      (id) => !layout.hidden.includes(id) && !exclude.includes(id),
    );
  return showsIn("main") && showsIn("rail");
}

/**
 * Puts `id` in `column`: where `overId` sits when given (a drop on a row of that column), else after the column's last
 * section (or where it is, when the column is empty). Only choices that differ from the default are kept.
 */
export function moveSectionToColumn(
  layout: Pick<SectionLayout, "order" | "columns">,
  id: SectionId,
  column: SectionColumn,
  overId?: SectionId,
): Pick<SectionLayout, "order" | "columns"> {
  const columns = { ...layout.columns };
  if (column === SECTION_COLUMNS[id]) delete columns[id];
  else columns[id] = column;
  const order = layout.order.filter((section) => section !== id);
  const at = overId && overId !== id ? order.indexOf(overId) : -1;
  if (at >= 0) {
    order.splice(at, 0, id);
  } else {
    const last = sectionsInColumn(order, column, columns).at(-1);
    if (last) order.splice(order.indexOf(last) + 1, 0, id);
    else order.splice(Math.max(0, layout.order.indexOf(id)), 0, id);
  }
  return { order, columns };
}

export type SectionTask = Pick<
  TaskDetail,
  | "kind"
  | "labels"
  | "links"
  | "usage"
  | "blockedBy"
  | "blocks"
  | "attention"
  | "review"
  | "reviews"
  | "autopilot"
  | "autoReview"
  | "reviewModel"
  | "autoMerge"
  | "priority"
  | "manual"
  | "progress"
  | "currentStep"
  | "description"
  | "planContext"
  | "events"
>;

const hasText = (value: string | null) => !!value?.trim();

/**
 * Sections start collapsed when there's nothing in them for this task, so the panel opens on what
 * matters. Activity is a log rather than a summary, so it always starts collapsed. Labels and Plan
 * stay open: Labels is one row either way and an empty Plan is the prompt to write one.
 */
export function collapsedByDefault(id: SectionId, task: SectionTask): boolean {
  switch (id) {
    case "labels":
    case "plan":
      return false;
    case "sessions":
      return !task.links.some(isSessionLink);
    case "usage":
      return task.usage === null;
    case "links":
      return task.links.every(isSessionLink);
    case "relations":
      return task.blockedBy.length === 0 && task.blocks.length === 0;
    // The settings are the section's content, so it stays open: they're what you came to change.
    // An epic has no settings of its own here, only the runs on it: open it when one needs a look.
    case "autopilot":
      return task.kind === "epic" ? !task.attention.some((a) => a.kind === "autopilot") : false;
    case "review":
      return task.reviews.length === 0;
    case "details":
      return !hasText(task.description) && !hasText(task.planContext);
    case "activity":
      return true;
  }
}

/** Records a collapse choice; choosing the section's default clears it so the smart default applies again. */
export function withCollapseChoice(
  collapsed: SectionLayout["collapsed"],
  id: SectionId,
  value: boolean,
  byDefault: boolean,
): SectionLayout["collapsed"] {
  const next = { ...collapsed };
  if (value === byDefault) delete next[id];
  else next[id] = value;
  return next;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** First line of markdown as plain-ish text, for a one-line preview. */
export function firstLine(markdown: string | null): string | null {
  for (const raw of markdown?.split("\n") ?? []) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX~!-]\]\s+)?|\d+[.)]\s+)/, "")
      .replace(/[*_`]/g, "")
      .trim();
    if (line) return line;
  }
  return null;
}

/** Chips a rich summary shows before folding the rest into "+N". */
export const SUMMARY_CHIP_LIMIT = { labels: 3, sessions: 4, links: 3, relations: 3 } as const;

/** The first `max` items and how many were left out, for a "+N" chip. */
export function limitItems<T>(items: ReadonlyArray<T>, max: number): { shown: T[]; hidden: number } {
  return { shown: items.slice(0, max), hidden: Math.max(0, items.length - max) };
}

/** The PRs a collapsed Links header shows, and how many links (more PRs or any other kind) it leaves out. */
export function linkSummaryChips(links: ReadonlyArray<PlainLink>): { prs: PrLink[]; rest: number } {
  const { shown } = limitItems(
    links.filter((link): link is PrLink => link.kind === "pr"),
    SUMMARY_CHIP_LIMIT.links,
  );
  return { prs: shown, rest: links.length - shown.length };
}

export interface RelationChip {
  id: string;
  number: number;
  title: string;
  /** blocking: an open blocker. done: a blocker that is Done. neutral: a task this one holds up. */
  tone: "blocking" | "done" | "neutral";
}

export interface RelationChipGroup {
  kind: "blockedBy" | "blocks";
  label: string;
  chips: RelationChip[];
}

/** Collapsed Relations header: open blockers first (they are why the task can't start), then what it holds up. */
export function relationChipGroups(task: Pick<SectionTask, "blockedBy" | "blocks">): RelationChipGroup[] {
  const chip = (r: TaskRelation, tone: RelationChip["tone"]): RelationChip => ({
    id: r.id,
    number: r.number,
    title: r.title,
    tone,
  });
  const blockedBy = task.blockedBy
    .map((r) => chip(r, r.status === "done" ? "done" : "blocking"))
    .toSorted((a, b) => Number(b.tone === "blocking") - Number(a.tone === "blocking"));
  return [
    { kind: "blockedBy" as const, label: "blocked by", chips: blockedBy },
    { kind: "blocks" as const, label: "blocks", chips: task.blocks.map((r) => chip(r, "neutral")) },
  ].filter((group) => group.chips.length > 0);
}

/**
 * What Autopilot may do with the task, as the collapsed Autopilot section says it: "May start, review", or "Not
 * automated". It reads the same chips the open section shows (`mayState`), so a task that follows the board's
 * Auto-review counts review when the board has it on; the reviewer's model comes after it.
 */
function autopilotSummary(
  task: Pick<SectionTask, "kind" | "autopilot" | "autoReview" | "reviewModel" | "autoMerge" | "priority" | "manual">,
  globalReview: boolean,
): string {
  // An epic has no flags: its section is only the runs.
  if (task.kind === "epic") return "Runs on this epic";
  // A manual task has no Autopilot, review or merge settings that apply to it.
  if (task.manual) return task.priority ? "For a person · Priority" : "For a person";
  const on = mayState(task, globalReview);
  const may = [on.start ? "start" : null, on.review ? "review" : null, on.merge ? "merge" : null].filter(
    (part) => part !== null,
  );
  const reviewer =
    task.reviewModel === null || task.reviewModel === "inherit"
      ? null
      : `Reviewer ${"tier" in task.reviewModel ? task.reviewModel.tier : "profile" in task.reviewModel ? task.reviewModel.profile : task.reviewModel.model}`;
  const parts = [may.length ? `May ${may.join(", ")}` : "Not automated", reviewer, task.priority ? "Priority" : null];
  return parts.filter((part) => part !== null).join(" · ");
}

/**
 * Which attention reasons live in which section. import_failed and agent_request are in none: they have their own
 * callouts at the top of the panel.
 */
export const SECTION_ATTENTION: Partial<Record<SectionId, ReadonlyArray<AttentionReason["kind"]>>> = {
  autopilot: ["autopilot"],
  sessions: ["thread_needs_input", "thread_failed"],
  links: ["pr_checks_failing", "pr_changes_requested", "pr_conflict"],
  plan: ["blocked_step"],
  review: ["review_stalled", "review_stuck", "review_failed", "review_unattended"],
};

/** The reason a section's header shows, errors before warnings; null when the task has none for it. */
export function sectionAttention(id: SectionId, task: Pick<SectionTask, "attention">): AttentionReason | null {
  const kinds = SECTION_ATTENTION[id];
  return kinds ? topAttention(task.attention.filter((a) => kinds.includes(a.kind))) : null;
}

/** The one-line summary a collapsed section header shows in place of its content. */
export function summarizeSection(
  id: SectionId,
  task: SectionTask,
  nowMs: number = Date.now(),
  /** The board's Auto-review setting, which a task that sets nothing follows. */
  globalReview: boolean = false,
): string {
  switch (id) {
    case "labels":
      return task.labels.length ? task.labels.join(", ") : "None";
    case "sessions": {
      const count = task.links.filter(isSessionLink).length;
      if (count === 0) return "None";
      const problem = sectionAttention("sessions", task);
      return problem ? `${count} · ${problem.message}` : String(count);
    }
    case "usage":
      return usageSummary(task.usage);
    case "links": {
      const count = task.links.filter((link) => !isSessionLink(link)).length;
      if (count === 0) return "None";
      const problem = sectionAttention("links", task);
      return problem ? `${count} · ${problem.message}` : String(count);
    }
    case "relations": {
      const open = task.blockedBy.filter((b) => b.status !== "done");
      const parts = [
        open.length ? `blocked by ${open.map((b) => `#${b.number}`).join(", ")}` : null,
        task.blocks.length ? `blocks ${task.blocks.map((b) => `#${b.number}`).join(", ")}` : null,
      ].filter((part) => part !== null);
      return parts.length ? parts.join(" · ") : task.blockedBy.length ? "Unblocked" : "None";
    }
    case "review": {
      if (!task.review) return "Not reviewed yet";
      if (task.review.state === "pending" || task.review.state === "running") return reviewBadgeLabel(task.review);
      const open = task.reviews.flatMap((r) => r.findings).filter((f) => f.status === "open").length;
      return open ? plural(open, "open finding") : reviewBadgeLabel(task.review);
    }
    case "autopilot":
      return sectionAttention("autopilot", task)?.message ?? autopilotSummary(task, globalReview);
    case "plan": {
      const { done, total } = task.progress;
      if (total === 0) return "No plan yet";
      const step = task.currentStep;
      return step ? `${done}/${total} · ${step.index} ${step.title}` : `${done}/${total}`;
    }
    case "details":
      return firstLine(task.description) ?? firstLine(task.planContext) ?? "Empty";
    case "activity": {
      const last = task.events.at(-1);
      if (!last) return "No activity yet";
      const elapsed = formatElapsedDurationLabel(last.at, nowMs);
      return `${task.events.length} · last ${elapsed === "just now" ? elapsed : `${elapsed} ago`}`;
    }
  }
}
