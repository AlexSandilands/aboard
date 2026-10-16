import { describe, expect, it } from "vitest";
import {
  arrowPath,
  blockedLabel,
  curvePath,
  dependencyEdges,
  edgeColor,
  edgeGeometry,
  farEnd,
  reach,
  relationCandidates,
  stubDirection,
  type RelatedTask,
} from "./dependencies.logic";

/** A chain a -> b -> c -> d (a blocks b blocks c blocks d), plus e, which also blocks c. */
const tasks = (() => {
  const make = (id: string, blockedBy: string[], blocks: string[]): [string, RelatedTask] => [
    id,
    { id, status: "planned", blockedBy: blockedBy.map((b) => ({ id: b })), blocks: blocks.map((b) => ({ id: b })) },
  ];
  return new Map<string, RelatedTask>([
    make("a", [], ["b"]),
    make("b", ["a"], ["c"]),
    make("c", ["b", "e"], ["d"]),
    make("d", ["c"], []),
    make("e", [], ["c"]),
  ]);
})();

const summarize = (edges: ReturnType<typeof dependencyEdges>) =>
  edges.map((e) => `${e.side[0]}${e.depth}:${e.blockerId}>${e.blockedId}`).sort();

describe("blockedLabel", () => {
  const blocker = (number: number, status: "planned" | "done") => ({
    id: `t${number}`,
    number,
    title: "",
    status,
    archived: false,
  });
  it("names the blockers that are still open", () => {
    expect(
      blockedLabel({
        blocked: true,
        status: "planned",
        blockedBy: [blocker(79, "planned"), blocker(80, "planned"), blocker(7, "done")],
      }),
    ).toBe("Blocked by #79, #80");
  });
  it("says nothing when nothing blocks the task or it is done itself", () => {
    expect(blockedLabel({ blocked: false, status: "planned", blockedBy: [blocker(7, "done")] })).toBeNull();
    expect(blockedLabel({ blocked: true, status: "done", blockedBy: [blocker(7, "planned")] })).toBeNull();
  });
});

describe("dependencyEdges", () => {
  it("is just the direct relations without the chain", () => {
    expect(summarize(dependencyEdges(tasks, "c", false))).toEqual(["b1:b>c", "b1:e>c", "d1:c>d"]);
    expect(summarize(dependencyEdges(tasks, "a", false))).toEqual(["d1:a>b"]);
  });

  it("follows the whole ancestry both ways with the chain, each edge at its far end's distance", () => {
    expect(summarize(dependencyEdges(tasks, "c", true))).toEqual(["b1:b>c", "b1:e>c", "b2:a>b", "d1:c>d"]);
    expect(summarize(dependencyEdges(tasks, "a", true))).toEqual(["d1:a>b", "d2:b>c", "d3:c>d"]);
    expect(summarize(dependencyEdges(tasks, "d", true))).toEqual(["b1:c>d", "b2:b>c", "b2:e>c", "b3:a>b"]);
  });

  it("gives a task reached two ways its nearest distance and lists each edge once", () => {
    const diamond = new Map<string, RelatedTask>([
      ["x", { id: "x", status: "planned", blockedBy: [], blocks: [{ id: "y" }, { id: "z" }] }],
      ["y", { id: "y", status: "planned", blockedBy: [{ id: "x" }], blocks: [{ id: "z" }] }],
      ["z", { id: "z", status: "planned", blockedBy: [{ id: "x" }, { id: "y" }], blocks: [] }],
    ]);
    expect(summarize(dependencyEdges(diamond, "x", true))).toEqual(["d1:x>y", "d1:x>z", "d2:y>z"]);
  });

  it("keeps relations to tasks the board doesn't have, and survives a cycle", () => {
    const odd = new Map<string, RelatedTask>([
      ["p", { id: "p", status: "planned", blockedBy: [{ id: "gone" }, { id: "q" }], blocks: [{ id: "q" }] }],
      ["q", { id: "q", status: "planned", blockedBy: [{ id: "p" }], blocks: [{ id: "p" }] }],
    ]);
    const edges = dependencyEdges(odd, "p", true);
    expect(edges.map(farEnd)).toContain("gone");
    expect(edges.length).toBeGreaterThan(0);
    expect(dependencyEdges(odd, "unknown", true)).toEqual([]);
  });
});

describe("edgeColor", () => {
  const lightness = (css: string) => Number(/oklch\(([\d.]+)/.exec(css)![1]);
  it("is green for dependents and red for blockers", () => {
    expect(edgeColor("dependents", 1)).toContain(" 150)");
    expect(edgeColor("blockers", 1)).toContain(" 25)");
  });
  it("darkens with each level out, down to a floor", () => {
    const levels = [1, 2, 3, 4, 5, 20].map((d) => lightness(edgeColor("dependents", d)));
    expect(levels[1]).toBeLessThan(levels[0]!);
    expect(levels[2]).toBeLessThan(levels[1]!);
    expect(levels[4]).toBeLessThanOrEqual(levels[3]!);
    expect(levels[5]).toBe(0.4);
  });
});

describe("edgeGeometry", () => {
  const box = (left: number, top: number) => ({ left, top, width: 200, height: 80 });
  it("joins the facing sides of cards in different columns", () => {
    const g = edgeGeometry(box(0, 0), box(300, 100));
    expect(g.start).toEqual({ x: 200, y: 40 });
    expect(g.end).toEqual({ x: 300, y: 140 });
    expect(g.c1.x).toBeGreaterThan(g.start.x);
    expect(g.c2.x).toBeLessThan(g.end.x);
    const back = edgeGeometry(box(300, 100), box(0, 0));
    expect(back.start).toEqual({ x: 300, y: 140 });
    expect(back.end).toEqual({ x: 200, y: 40 });
    expect(back.c1.x).toBeLessThan(back.start.x);
  });
  it("loops out of the right edges for cards in the same column", () => {
    const g = edgeGeometry(box(0, 0), box(10, 200));
    expect(g.start.x).toBe(200);
    expect(g.end.x).toBe(210);
    expect(g.c1.x).toBe(g.c2.x);
    expect(g.c1.x).toBeGreaterThan(210);
  });
  it("renders a path and an arrowhead ending on the target", () => {
    const g = edgeGeometry(box(0, 0), box(300, 100));
    expect(curvePath(g)).toMatch(/^M 200 40 C .* 300 140$/);
    expect(arrowPath(g)).toMatch(/^M 300 140 L .* Z$/);
  });
});

describe("stubDirection", () => {
  it("points toward the hidden card's column, else its lane", () => {
    expect(stubDirection({ status: "planned", laneIndex: 1 }, { status: "done", laneIndex: 1 })).toBe("right");
    expect(stubDirection({ status: "review", laneIndex: 1 }, { status: "backlog", laneIndex: 3 })).toBe("left");
    expect(stubDirection({ status: "review", laneIndex: 2 }, { status: "review", laneIndex: 0 })).toBe("up");
    expect(stubDirection({ status: "review", laneIndex: 2 }, { status: "review", laneIndex: 2 })).toBe("down");
  });
});

describe("reach", () => {
  it("collects everything up or down the chain without the task itself", () => {
    expect([...reach(tasks, "b", "dependents")].sort()).toEqual(["c", "d"]);
    expect([...reach(tasks, "d", "blockers")].sort()).toEqual(["a", "b", "c", "e"]);
    expect(reach(tasks, "a", "blockers").size).toBe(0);
  });
});

describe("relationCandidates", () => {
  const all = [...tasks.values()];
  const ids = (list: ReadonlyArray<{ id: string }>) => list.map((t) => t.id).sort();
  it("offers neither itself, what is already a blocker, nor what already depends on it", () => {
    // b is blocked by a and blocks c (and so d): none of c, d can block it, nor a again.
    expect(ids(relationCandidates(all, "b", "blockers"))).toEqual(["e"]);
  });
  it("offers neither itself, what it already blocks, nor what already blocks it", () => {
    // b is blocked by a: a can't also depend on b. c is already a dependent.
    expect(ids(relationCandidates(all, "b", "dependents"))).toEqual(["d", "e"]);
    expect(relationCandidates(all, "missing", "blockers")).toEqual([]);
  });
});
