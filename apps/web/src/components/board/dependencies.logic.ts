import { TASK_STATUSES, type TaskStatus, type TaskSummary } from "@repo/contracts";

/** What the dependency lines need of a task: its id, status and the ids on either end of its relations. */
export type RelatedTask = Pick<TaskSummary, "id" | "status"> & {
  blockedBy: ReadonlyArray<{ id: string }>;
  blocks: ReadonlyArray<{ id: string }>;
};

/** Blockers that haven't finished, which is what makes a card blocked. */
export function openBlockers(task: Pick<TaskSummary, "blockedBy">) {
  return task.blockedBy.filter((b) => b.status !== "done");
}

/** "Blocked by #79, #80" for a card's lock marker, or null when nothing open blocks it (or it is done itself). */
export function blockedLabel(task: Pick<TaskSummary, "blocked" | "blockedBy" | "status">): string | null {
  if (!task.blocked || task.status === "done") return null;
  const open = openBlockers(task);
  return open.length ? `Blocked by ${open.map((b) => `#${b.number}`).join(", ")}` : null;
}

/** Which way a line runs from the card in focus: to the tasks it waits on, or to the tasks waiting on it. */
export type EdgeSide = "blockers" | "dependents";

export interface DependencyEdge {
  blockerId: string;
  blockedId: string;
  side: EdgeSide;
  /** 1 for a direct relation, 2 for one further out, and so on. */
  depth: number;
}

/**
 * The relations to draw for `focusId`: its direct blockers (red) and the tasks it blocks (green), or with
 * `chain` the whole ancestry both ways. Each edge's depth is how far its far end is from the focus.
 * Relations only to tasks the board doesn't have (archived ones) are kept, since the lines skip what isn't shown.
 */
export function dependencyEdges(
  tasks: ReadonlyMap<string, RelatedTask>,
  focusId: string,
  chain: boolean,
): DependencyEdge[] {
  const edges = new Map<string, DependencyEdge>();
  const walk = (side: EdgeSide) => {
    const seen = new Set<string>([focusId]);
    let level = [focusId];
    for (let depth = 1; level.length > 0; depth += 1) {
      // Without the chain only the first level is drawn.
      if (depth > 1 && !chain) break;
      const next: string[] = [];
      for (const id of level) {
        const task = tasks.get(id);
        if (!task) continue;
        for (const other of side === "blockers" ? task.blockedBy : task.blocks) {
          const [blockerId, blockedId] = side === "blockers" ? [other.id, id] : [id, other.id];
          const key = `${blockerId}>${blockedId}`;
          if (!edges.has(key)) edges.set(key, { blockerId, blockedId, side, depth });
          if (!seen.has(other.id)) {
            seen.add(other.id);
            next.push(other.id);
          }
        }
      }
      level = next;
    }
  };
  walk("blockers");
  walk("dependents");
  return [...edges.values()];
}

/** Every task reached from `id` by following its dependents (what it blocks) or its blockers, `id` excluded. */
export function reach(tasks: ReadonlyMap<string, RelatedTask>, id: string, side: EdgeSide): Set<string> {
  const seen = new Set<string>();
  const queue = [id];
  for (const current of queue) {
    const task = tasks.get(current);
    for (const other of (side === "blockers" ? task?.blockedBy : task?.blocks) ?? []) {
      if (other.id === id || seen.has(other.id)) continue;
      seen.add(other.id);
      queue.push(other.id);
    }
  }
  return seen;
}

/**
 * The tasks that could be added as a blocker (`side` "blockers") or a dependent ("dependents") of `taskId`:
 * not itself, not one already there, and none that would close a loop. The server is the authority on cycles;
 * this keeps the picker from offering what it would refuse.
 */
export function relationCandidates<T extends RelatedTask>(
  tasks: ReadonlyArray<T>,
  taskId: string,
  side: EdgeSide,
): T[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const task = byId.get(taskId);
  if (!task) return [];
  // A new blocker can't already depend on this task; a new dependent can't already block it.
  const loops = reach(byId, taskId, side === "blockers" ? "dependents" : "blockers");
  const existing = new Set((side === "blockers" ? task.blockedBy : task.blocks).map((r) => r.id));
  return tasks.filter((t) => t.id !== taskId && !existing.has(t.id) && !loops.has(t.id));
}

/** The task at the far end of an edge from the focus. */
export const farEnd = (edge: DependencyEdge): string => (edge.side === "blockers" ? edge.blockerId : edge.blockedId);

const HUE: Record<EdgeSide, number> = { dependents: 150, blockers: 25 };
/** Lightness of a depth-1 line, and how much darker each level further out is, down to a floor. */
const LIGHTNESS_START = 0.72;
const LIGHTNESS_STEP = 0.07;
const LIGHTNESS_MIN = 0.4;

/** Green for what the task unblocks, red for what blocks it; each level further away a little darker. */
export function edgeColor(side: EdgeSide, depth: number): string {
  const lightness = Math.max(LIGHTNESS_MIN, LIGHTNESS_START - LIGHTNESS_STEP * (depth - 1));
  return `oklch(${lightness.toFixed(3)} 0.17 ${HUE[side]})`;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A curve from one card to another with the arrowhead that sits on its blocked end. */
export interface EdgeGeometry {
  start: Point;
  end: Point;
  /** Cubic bezier control points. */
  c1: Point;
  c2: Point;
}

const MIN_REACH = 36;
const SAME_COLUMN_BULGE = 30;

/**
 * Anchors a curve on the facing sides of two cards when they sit in different columns, and loops out of the
 * right edges of both when they share one (so the curve doesn't cut across the cards between them).
 */
export function edgeGeometry(from: Box, to: Box): EdgeGeometry {
  const fromMid = from.left + from.width / 2;
  const toMid = to.left + to.width / 2;
  const fromY = from.top + from.height / 2;
  const toY = to.top + to.height / 2;
  if (Math.abs(toMid - fromMid) < Math.min(from.width, to.width) / 2) {
    const start = { x: from.left + from.width, y: fromY };
    const end = { x: to.left + to.width, y: toY };
    const x = Math.max(start.x, end.x) + SAME_COLUMN_BULGE;
    return { start, end, c1: { x, y: start.y }, c2: { x, y: end.y } };
  }
  const rightwards = toMid > fromMid;
  const start = { x: rightwards ? from.left + from.width : from.left, y: fromY };
  const end = { x: rightwards ? to.left : to.left + to.width, y: toY };
  const lead = Math.max(MIN_REACH, Math.abs(end.x - start.x) / 2);
  const sign = rightwards ? 1 : -1;
  return { start, end, c1: { x: start.x + sign * lead, y: start.y }, c2: { x: end.x - sign * lead, y: end.y } };
}

/** SVG path data for the curve. */
export function curvePath({ start, c1, c2, end }: EdgeGeometry): string {
  const p = (pt: Point) => `${round(pt.x)} ${round(pt.y)}`;
  return `M ${p(start)} C ${p(c1)}, ${p(c2)}, ${p(end)}`;
}

/** A small triangle at `tip`, pointing along the curve's last stretch (from its second control point). */
export function arrowPath({ c2, end }: EdgeGeometry, size = 5): string {
  const angle = Math.atan2(end.y - c2.y, end.x - c2.x);
  const corner = (turn: number): Point => ({
    x: end.x - size * 1.6 * Math.cos(angle) + turn * size * Math.sin(angle),
    y: end.y - size * 1.6 * Math.sin(angle) - turn * size * Math.cos(angle),
  });
  const [a, b] = [corner(1), corner(-1)];
  return `M ${round(end.x)} ${round(end.y)} L ${round(a.x)} ${round(a.y)} L ${round(b.x)} ${round(b.y)} Z`;
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** Which way a card that isn't shown lies from the one in focus: toward its column, or up or down its lane. */
export type StubDirection = "left" | "right" | "up" | "down";

const STATUS_INDEX = new Map<TaskStatus, number>(TASK_STATUSES.map((s, index) => [s.value, index]));

/**
 * Where to point the stub for a hidden card (in a collapsed column, filtered out or in a collapsed lane): toward
 * its column when that differs from the focus card's, else toward its lane, else down (it is in the same cell).
 */
export function stubDirection(
  focus: { status: TaskStatus; laneIndex: number },
  hidden: { status: TaskStatus; laneIndex: number },
): StubDirection {
  const dx = (STATUS_INDEX.get(hidden.status) ?? 0) - (STATUS_INDEX.get(focus.status) ?? 0);
  if (dx !== 0) return dx > 0 ? "right" : "left";
  return hidden.laneIndex < focus.laneIndex ? "up" : "down";
}
