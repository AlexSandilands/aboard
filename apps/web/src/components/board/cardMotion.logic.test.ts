import { describe, expect, it } from "vitest";
import {
  canReuseSnapshot,
  flipDurationMs,
  planCardMotion,
  settleSnapshot,
  type BoardView,
  type CardRect,
  type CardSnapshot,
} from "./cardMotion.logic";

const viewport = { width: 1000, height: 800 };
const rect = (left: number, top: number): CardRect => ({ left, top, width: 200, height: 80 });
const rects = (entries: Record<string, CardRect>) => new Map(Object.entries(entries));

describe("flipDurationMs", () => {
  it("scales the panel animation setting, so the default is about 260 ms", () => {
    expect(flipDurationMs(150)).toBe(263);
    expect(flipDurationMs(400)).toBe(700);
  });

  it("is off at 0", () => {
    expect(flipDurationMs(0)).toBe(0);
  });
});

describe("planCardMotion", () => {
  it("slides a moved card and the neighbours that close the gap", () => {
    const prev = rects({ a: rect(0, 0), b: rect(0, 90), c: rect(300, 0) });
    const next = rects({ a: rect(0, 0), b: rect(0, 0), c: rect(300, 0) });
    next.set("a", rect(300, 90));
    expect(planCardMotion(prev, next, viewport)).toEqual([
      { id: "a", kind: "slide", dx: -300, dy: -90 },
      { id: "b", kind: "slide", dx: 0, dy: 90 },
    ]);
  });

  it("leaves cards that did not move, or moved by rounding, still", () => {
    const prev = rects({ a: rect(0, 0), b: rect(0, 90) });
    const next = rects({ a: rect(0, 0), b: rect(0.4, 90.6) });
    expect(planCardMotion(prev, next, viewport)).toEqual([]);
  });

  it("fades in a card with no previous rect", () => {
    expect(planCardMotion(rects({}), rects({ a: rect(0, 0) }), viewport)).toEqual([{ id: "a", kind: "fade" }]);
  });

  it("skips a card with no new rect", () => {
    expect(planCardMotion(rects({ a: rect(0, 0) }), rects({}), viewport)).toEqual([]);
  });

  it("skips cards that are off screen before and after, but slides one that enters the view", () => {
    const prev = rects({ a: rect(0, 2000), b: rect(0, 2000), c: rect(0, 2000) });
    const next = rects({ a: rect(0, 2090), b: rect(0, 100), c: rect(0, 3000) });
    expect(planCardMotion(prev, next, viewport)).toEqual([{ id: "b", kind: "slide", dx: 0, dy: 1900 }]);
  });

  it("does not fade in a new card below the fold", () => {
    expect(planCardMotion(rects({}), rects({ a: rect(0, 5000) }), viewport)).toEqual([]);
  });
});

describe("canReuseSnapshot", () => {
  it("shares a snapshot within a burst and drops a stale one", () => {
    expect(canReuseSnapshot(null, 1000)).toBe(false);
    expect(canReuseSnapshot({ at: 1000 }, 1100)).toBe(true);
    expect(canReuseSnapshot({ at: 1000 }, 1301)).toBe(false);
  });
});

describe("settleSnapshot", () => {
  const view: BoardView = { width: 900, height: 700, scrollLeft: 0, scrollTop: 100 };
  const snapshot = (overrides: Partial<CardSnapshot> = {}): CardSnapshot => ({
    rects: rects({ a: rect(10, 20) }),
    at: 1000,
    view,
    ...overrides,
  });

  it("keeps the rects when nothing changed", () => {
    expect(settleSnapshot(snapshot(), 1050, view)).toEqual(rects({ a: rect(10, 20) }));
  });

  it("follows the board's scroll, so scrolling is not a move", () => {
    const settled = settleSnapshot(snapshot(), 1050, { ...view, scrollTop: 160, scrollLeft: 5 });
    expect(settled?.get("a")).toEqual(rect(5, -40));
  });

  it("gives up when the snapshot is stale, empty or the scroll box resized", () => {
    expect(settleSnapshot(snapshot(), 2000, view)).toBeNull();
    expect(settleSnapshot(snapshot({ rects: rects({}) }), 1050, view)).toBeNull();
    expect(settleSnapshot(snapshot(), 1050, { ...view, width: 700 })).toBeNull();
  });
});
