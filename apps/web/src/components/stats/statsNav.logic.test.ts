import type { StatsResponse, StatsSeries } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  hasStatsCharts,
  searchStatsNav,
  STATS_SECTIONS,
  statsSection,
  statsSectionOf,
  visibleStatsCards,
} from "./statsNav.logic";

const series = (total: number): StatsSeries => ({ unit: "count", values: [total], total, previousTotal: 0 });
const response = (named: Record<string, StatsSeries>): Pick<StatsResponse, "series"> => ({ series: named });

describe("STATS_SECTIONS", () => {
  it("gives every section and card a unique id, each card under its section's", () => {
    const ids = STATS_SECTIONS.flatMap((section) => [section.id, ...section.cards.map((card) => card.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of STATS_SECTIONS) {
      expect(section.id.startsWith("stats.")).toBe(true);
      for (const card of section.cards) expect(card.id.startsWith(`${section.id}.`)).toBe(true);
    }
  });

  it("puts the sections in the page's order, with no Breakdowns section", () => {
    expect(STATS_SECTIONS.map((section) => section.label)).toEqual([
      "Throughput",
      "Tokens & cost",
      "Cycle time",
      "Flow",
      "PRs, commits and reviews",
      "PR flow",
      "Sessions",
      "Autopilot",
      "Friction",
    ]);
  });
});

describe("statsSectionOf", () => {
  it("finds the section of a section or card id", () => {
    expect(statsSectionOf("stats.flow")?.id).toBe("stats.flow");
    expect(statsSectionOf("stats.flow.open-tasks")?.id).toBe("stats.flow");
  });

  it("is null for ids that aren't the page's, so a stale hash is ignored", () => {
    expect(statsSectionOf("stats.breakdowns")).toBeNull();
    expect(statsSectionOf("stats.flow.nope")).toBeNull();
    expect(statsSectionOf("")).toBeNull();
  });
});

describe("visibleStatsCards", () => {
  const autopilot = statsSection("stats.autopilot");

  it("lists no cards while loading or when nothing happened", () => {
    expect(visibleStatsCards(autopilot, null)).toEqual([]);
    expect(visibleStatsCards(autopilot, response({ tasks_completed: series(0) }))).toEqual([]);
    expect(hasStatsCharts(response({ tasks_completed: series(0) }))).toBe(false);
  });

  it("leaves out Runs by automation when no automation ran", () => {
    const data = response({ tasks_completed: series(3) });
    expect(hasStatsCharts(data)).toBe(true);
    expect(visibleStatsCards(autopilot, data).map((card) => card.id)).toEqual([
      "stats.autopilot.outcomes",
      "stats.autopilot.cost",
    ]);
  });

  it("lists Runs by automation once one ran", () => {
    const data = response({ "autopilot.runs.review_prs.succeeded": series(2) });
    expect(visibleStatsCards(autopilot, data).map((card) => card.id)).toContain("stats.autopilot.by-automation");
  });

  it("lists every card of the other sections", () => {
    const flow = statsSection("stats.flow");
    expect(visibleStatsCards(flow, response({ tasks_completed: series(1) }))).toEqual(flow.cards);
  });
});

describe("searchStatsNav", () => {
  const charted = response({ tasks_completed: series(3) });
  const ids = (query: string, data = charted) => searchStatsNav(data, query).map((entry) => entry.id);

  it("matches nothing for an empty query or a page with no charts", () => {
    expect(ids("  ")).toEqual([]);
    expect(ids("cost", response({}))).toEqual([]);
    expect(searchStatsNav(undefined, "cost")).toEqual([]);
  });

  it("ranks a label's start above a word in it, and both above the section a card is in", () => {
    const found = ids("cost");
    expect(found[0]).toBe("stats.autopilot.cost");
    expect(found.indexOf("stats.tokens.cost")).toBeLessThan(found.indexOf("stats.tokens.by-kind"));
    expect(found.at(-1)).toBe("stats.tokens.by-kind");
  });

  it("finds sections by their label, labelled as sections", () => {
    const [first] = searchStatsNav(charted, "friction");
    expect(first).toMatchObject({ id: "stats.friction", kind: "section", location: "Section" });
  });

  it("needs every word to match, and leaves out cards the page doesn't draw", () => {
    expect(ids("open merged")).toEqual(["stats.pr-flow.open-to-merged"]);
    expect(ids("runs by automation")).toEqual([]);
  });
});
