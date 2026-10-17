import { reviewBadgeLabel, type TaskDetail } from "@repo/contracts";
import { formatElapsedDurationLabel } from "~/lib/timestampFormat";
import { isSessionLink } from "./links.logic";

/** Detail-panel sections the user can collapse, reorder and hide, in default order. */
export const SECTION_IDS = [
  "labels",
  "sessions",
  "links",
  "relations",
  "review",
  "autopilot",
  "plan",
  "details",
  "activity",
] as const;

export type SectionId = (typeof SECTION_IDS)[number];

export const SECTION_TITLES: Record<SectionId, string> = {
  labels: "Labels",
  sessions: "Sessions",
  links: "Links",
  relations: "Relations",
  review: "Local review",
  autopilot: "Autopilot",
  plan: "Plan",
  details: "Details",
  activity: "Activity",
};

export interface SectionLayout {
  order: SectionId[];
  hidden: SectionId[];
  /** Explicit choices only; a missing id follows collapsedByDefault. */
  collapsed: Partial<Record<SectionId, boolean>>;
}

/** Sections added after others existed sit before the one they were split from in a saved order, not at the end. */
const SECTION_ANCHORS: Partial<Record<SectionId, SectionId>> = { sessions: "links" };

const isSectionId = (value: unknown): value is SectionId => SECTION_IDS.includes(value as SectionId);

/**
 * Re-validates stored values: unknown ids and duplicates are dropped, sections added since are appended (or placed
 * by SECTION_ANCHORS). Sessions used to be part of Links, so a layout saved before it existed hides and collapses it
 * with Links.
 */
export function normalizeSectionLayout(stored: {
  order?: unknown;
  hidden?: unknown;
  collapsed?: unknown;
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
  return {
    order,
    hidden: SECTION_IDS.filter((id) => hidden.includes(id)),
    collapsed,
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

export type SectionTask = Pick<
  TaskDetail,
  | "labels"
  | "links"
  | "blockedBy"
  | "blocks"
  | "attention"
  | "review"
  | "reviews"
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
    case "links":
      return task.links.every(isSessionLink);
    case "relations":
      return task.blockedBy.length === 0 && task.blocks.length === 0;
    case "review":
      return task.reviews.length === 0;
    // The runs aren't in the task detail; open it when one needs attention, since that is why you'd look.
    case "autopilot":
      return !task.attention.some((a) => a.kind === "autopilot");
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

const LINK_ATTENTION = new Set(["pr_checks_failing", "pr_changes_requested", "pr_conflict"]);
const SESSION_ATTENTION = new Set(["thread_needs_input", "thread_failed"]);

/** The one-line summary a collapsed section header shows in place of its content. */
export function summarizeSection(id: SectionId, task: SectionTask, nowMs: number = Date.now()): string {
  switch (id) {
    case "labels":
      return task.labels.length ? task.labels.join(", ") : "None";
    case "sessions": {
      const count = task.links.filter(isSessionLink).length;
      if (count === 0) return "None";
      const problem = task.attention.find((a) => SESSION_ATTENTION.has(a.kind));
      return problem ? `${count} · ${problem.message}` : String(count);
    }
    case "links": {
      const count = task.links.filter((link) => !isSessionLink(link)).length;
      if (count === 0) return "None";
      const problem = task.attention.find((a) => LINK_ATTENTION.has(a.kind));
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
      return task.attention.find((a) => a.kind === "autopilot")?.message ?? "Runs on this task";
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
