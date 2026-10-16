import type { Project, TaskSummary } from "@repo/contracts";
import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import {
  arrowPath,
  curvePath,
  dependencyEdges,
  edgeColor,
  edgeGeometry,
  stubDirection,
  type Box,
  type DependencyEdge,
  type StubDirection,
} from "./dependencies.logic";

/** How far a stub reaches from the card toward where the hidden one is. */
const STUB_LENGTH = 26;
/** Selecting a card (the panel is open) draws its lines softer than hovering one does. */
const SELECTED_OPACITY = 0.55;
/** Cards slide into place for a moment after the board changes; measure again once they have. */
const SETTLE_MS = 350;

interface Layout {
  boxes: ReadonlyMap<string, Box>;
}

/**
 * Lines between the card under the pointer (or the open one) and the cards it blocks and is blocked by: green to
 * what finishing it unblocks, red to what it waits on. Holding Shift draws the whole chain both ways, each level
 * further out a little darker. Related cards that aren't shown (in a collapsed column or lane, or filtered out)
 * get a short stub toward where they are.
 *
 * The overlay sits inside the scrolling content, so scrolling carries it along; it measures the cards' boxes when
 * the focus, the tasks or the content's size change. It never takes the pointer.
 */
export function DependencyLines({
  containerRef,
  tasks,
  projects,
  selectedTaskId,
  suspended,
}: {
  /** The positioned, scrolling content the lines are drawn over. */
  containerRef: RefObject<HTMLElement | null>;
  tasks: ReadonlyArray<TaskSummary>;
  projects: ReadonlyArray<Project>;
  selectedTaskId: string | null;
  /** Hidden while a card is being dragged, since cards are moving under it. */
  suspended: boolean;
}) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [shift, setShift] = useState(false);
  const [layout, setLayout] = useState<Layout>({ boxes: new Map() });

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const onOver = (event: PointerEvent) => {
      const card = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-task-card]") : null;
      setHoverId(card?.dataset.taskCard ?? null);
      setShift(event.shiftKey);
    };
    const onLeave = () => setHoverId(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Shift") setShift(event.type === "keydown");
    };
    const onBlur = () => setShift(false);
    root.addEventListener("pointerover", onOver);
    root.addEventListener("pointerleave", onLeave);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      root.removeEventListener("pointerover", onOver);
      root.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [containerRef]);

  const focusId = suspended ? null : (hoverId ?? selectedTaskId);
  const hovering = hoverId !== null && !suspended;
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const edges = useMemo(() => (focusId ? dependencyEdges(byId, focusId, shift) : []), [byId, focusId, shift]);

  // Every card a line touches, by id, so each is measured once.
  const wanted = useMemo(
    () =>
      focusId && edges.length > 0 ? [...new Set([focusId, ...edges.flatMap((e) => [e.blockerId, e.blockedId])])] : [],
    [focusId, edges],
  );

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root || wanted.length === 0) {
      setLayout((current) => (current.boxes.size === 0 ? current : { boxes: new Map() }));
      return;
    }
    const measure = () => {
      const origin = root.getBoundingClientRect();
      const boxes = new Map<string, Box>();
      for (const id of wanted) {
        const el = root.querySelector(`[data-task-card="${CSS.escape(id)}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        boxes.set(id, { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height });
      }
      setLayout({ boxes });
    };
    measure();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(root);
    // Collapsing a cell or filtering the board adds and removes cards without resizing the content.
    const isCard = (node: Node) =>
      node instanceof Element && (node.matches("[data-task-card]") || node.querySelector("[data-task-card]") !== null);
    const mutations = new MutationObserver((records) => {
      if (!records.some((r) => [...r.addedNodes, ...r.removedNodes].some(isCard))) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    mutations.observe(root, { childList: true, subtree: true });
    const settle = window.setTimeout(measure, SETTLE_MS);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [containerRef, wanted]);

  if (!focusId || edges.length === 0 || !layout.boxes.has(focusId)) return null;

  const laneIndex = (task: TaskSummary) => projects.findIndex((p) => p.id === task.projectId);
  const stubCounts = new Map<string, number>();
  const opacity = hovering ? 1 : SELECTED_OPACITY;

  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 z-5 size-full overflow-visible">
      {edges.map((edge) => {
        const from = layout.boxes.get(edge.blockerId);
        const to = layout.boxes.get(edge.blockedId);
        const color = edgeColor(edge.side, edge.depth);
        // A blocker that is Done no longer holds anything up: its line stays, but faint and dashed.
        const settled = byId.get(edge.blockerId)?.status === "done";
        const style = { opacity: settled ? opacity * 0.6 : opacity };
        const key = `${edge.blockerId}>${edge.blockedId}`;
        if (from && to) {
          const geometry = edgeGeometry(from, to);
          return (
            <g key={key} style={style}>
              <path
                d={curvePath(geometry)}
                fill="none"
                stroke={color}
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeDasharray={settled ? "4 4" : undefined}
              />
              <path d={arrowPath(geometry)} fill={color} />
            </g>
          );
        }
        // One end isn't shown: stub from the one that is toward where the other would be.
        const shownId = from ? edge.blockerId : to ? edge.blockedId : null;
        const hiddenId = from ? edge.blockedId : to ? edge.blockerId : null;
        const shown = shownId ? byId.get(shownId) : undefined;
        const hidden = hiddenId ? byId.get(hiddenId) : undefined;
        const box = shownId ? layout.boxes.get(shownId) : undefined;
        // The shown end must be a card we measured; an archived task's card is only there with Show archived.
        if (!shown || !hidden || !box) return null;
        const direction = stubDirection(
          { status: shown.status, laneIndex: laneIndex(shown) },
          { status: hidden.status, laneIndex: laneIndex(hidden) },
        );
        const slot = stubCounts.get(`${shown.id}:${direction}`) ?? 0;
        stubCounts.set(`${shown.id}:${direction}`, slot + 1);
        return (
          <Stub
            key={key}
            box={box}
            direction={direction}
            slot={slot}
            label={`#${hidden.number}`}
            edge={edge}
            color={color}
            style={style}
          />
        );
      })}
    </svg>
  );
}

/** A short line out of a card, ending in a dot and the number of the card it leads to. */
function Stub({
  box,
  direction,
  slot,
  label,
  edge,
  color,
  style,
}: {
  box: Box;
  direction: StubDirection;
  /** Stubs leaving the same side are spread out so their labels don't overlap. */
  slot: number;
  label: string;
  edge: DependencyEdge;
  color: string;
  style: { opacity: number };
}) {
  const spread = slot * 12;
  const horizontal = direction === "left" || direction === "right";
  const start = horizontal
    ? { x: direction === "right" ? box.left + box.width : box.left, y: box.top + box.height / 2 + spread }
    : { x: box.left + box.width / 2 + spread, y: direction === "down" ? box.top + box.height : box.top };
  const sign = direction === "right" || direction === "down" ? 1 : -1;
  const end = horizontal
    ? { x: start.x + sign * STUB_LENGTH, y: start.y }
    : { x: start.x, y: start.y + sign * STUB_LENGTH };
  const anchor = direction === "left" ? "end" : horizontal ? "start" : "middle";
  const text = horizontal ? { x: end.x + sign * 4, y: end.y + 3 } : { x: end.x, y: end.y + sign * 11 };
  return (
    <g style={style} data-stub={edge.side}>
      <path
        d={`M ${start.x} ${start.y} L ${end.x} ${end.y}`}
        fill="none"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
      />
      <circle cx={end.x} cy={end.y} r={2.5} fill={color} />
      <text x={text.x} y={text.y} textAnchor={anchor} fontSize={10} className="font-mono tabular-nums" fill={color}>
        {label}
      </text>
    </g>
  );
}
