import type { StatsResponse } from "@repo/contracts";
import { isQuiet, runsByAutomation } from "./stats.logic";

/**
 * The Stats page's sections and chart cards, in page order: the page draws its sections in this order, and the rail
 * lists them (docs/features/stats.md). A card's id is its section's id plus its own segment; both are element ids on
 * the page and the URL hash a rail jump sets. Rail labels don't name the period, so they read the same at any width.
 */
export const STATS_SECTIONS = [
  {
    id: "stats.throughput",
    label: "Throughput",
    cards: [
      { id: "stats.throughput.created-finished", label: "Created and finished" },
      { id: "stats.throughput.by-label", label: "Finished by label" },
      { id: "stats.throughput.by-tier", label: "Finished by model tier" },
    ],
  },
  {
    id: "stats.tokens",
    label: "Tokens & cost",
    cards: [
      { id: "stats.tokens.cost", label: "Estimated cost" },
      { id: "stats.tokens.by-kind", label: "Tokens by kind" },
      { id: "stats.tokens.cost-by-model", label: "Cost by model" },
      { id: "stats.tokens.cost-by-harness", label: "Cost by harness" },
      { id: "stats.tokens.board-runs", label: "Cost of the board's runs" },
      { id: "stats.tokens.top-tasks", label: "Top tasks by cost" },
    ],
  },
  {
    id: "stats.cycle-time",
    label: "Cycle time",
    cards: [{ id: "stats.cycle-time.median", label: "Median cycle time" }],
  },
  {
    id: "stats.flow",
    label: "Flow",
    cards: [
      { id: "stats.flow.median-time", label: "Median time in status" },
      { id: "stats.flow.average-time", label: "Average time in status" },
      { id: "stats.flow.open-tasks", label: "Open tasks" },
    ],
  },
  {
    id: "stats.prs",
    label: "PRs, commits and reviews",
    cards: [
      { id: "stats.prs.merged", label: "PRs merged" },
      { id: "stats.prs.commits", label: "Commits" },
      { id: "stats.prs.review-rounds", label: "Review rounds" },
      { id: "stats.prs.findings", label: "Review findings" },
    ],
  },
  {
    id: "stats.pr-flow",
    label: "PR flow",
    cards: [
      { id: "stats.pr-flow.open-to-merged", label: "Open to merged" },
      { id: "stats.pr-flow.autopilot-rounds", label: "Autopilot rounds" },
      { id: "stats.pr-flow.gave-up", label: "Autopilot gave up" },
    ],
  },
  {
    id: "stats.sessions",
    label: "Sessions",
    cards: [
      { id: "stats.sessions.started", label: "Sessions started" },
      { id: "stats.sessions.by-harness", label: "Sessions by harness" },
    ],
  },
  {
    id: "stats.autopilot",
    label: "Autopilot",
    cards: [
      { id: "stats.autopilot.outcomes", label: "Runs by outcome" },
      { id: "stats.autopilot.by-automation", label: "Runs by automation" },
      { id: "stats.autopilot.cost", label: "Cost" },
    ],
  },
  {
    id: "stats.friction",
    label: "Friction",
    cards: [
      { id: "stats.friction.steps", label: "Blocked and skipped steps" },
      { id: "stats.friction.attention", label: "Asks for attention" },
      { id: "stats.friction.stalls", label: "Stalls and restarts" },
    ],
  },
] as const;

export type StatsSection = (typeof STATS_SECTIONS)[number];
export type StatsSectionId = StatsSection["id"];
export type StatsCard = StatsSection["cards"][number];
export type StatsCardId = StatsCard["id"];

/** The section with this id. */
export function statsSection(id: StatsSectionId): StatsSection {
  return STATS_SECTIONS.find((section) => section.id === id)!;
}

/** The section a section or card id belongs to, or null for an id that isn't one of the page's. */
export function statsSectionOf(id: string): StatsSection | null {
  return (
    STATS_SECTIONS.find(
      (section) => section.id === id || section.cards.some((card: { id: string }) => card.id === id),
    ) ?? null
  );
}

/** Whether the page draws its charts for this response: not while loading, and not when nothing happened. */
export function hasStatsCharts(data: Pick<StatsResponse, "series"> | null | undefined): boolean {
  return !!data && !isQuiet(data.series);
}

/**
 * The cards the page draws in a section for this response, for the rail to list: none when it draws no charts, and
 * Runs by automation only when some automation ran.
 */
export function visibleStatsCards(
  section: StatsSection,
  data: Pick<StatsResponse, "series"> | null | undefined,
): ReadonlyArray<StatsCard> {
  if (!data || !hasStatsCharts(data)) return [];
  return section.cards.filter(
    (card) => card.id !== "stats.autopilot.by-automation" || runsByAutomation(data.series).length > 0,
  );
}

/** A section or card as the rail's search lists it: its label, with where it sits on the page beneath. */
export interface StatsSearchEntry {
  id: StatsSectionId | StatsCardId;
  kind: "section" | "card";
  label: string;
  /** "Section" for a section; a card's section. */
  location: string;
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Where a word sits in a label: the whole label, its start, the start of one of its words, or anywhere in it. */
function labelRank(label: string, word: string): number | null {
  if (label === word) return 0;
  if (label.startsWith(word)) return 1;
  if (label.includes(` ${word}`) || label.includes(`-${word}`)) return 2;
  return label.includes(word) ? 3 : null;
}

/**
 * The sections and drawn cards matching `query`, best first; ties keep page order. Every word typed has to match the
 * label or, a weaker match, the section a card is in, so "cost" finds Estimated cost above Tokens by kind. An entry
 * ranks by its worst-matching word. An empty query, or a response with no charts, matches nothing.
 */
export function searchStatsNav(
  data: Pick<StatsResponse, "series"> | null | undefined,
  query: string,
): StatsSearchEntry[] {
  const words = normalize(query).split(" ").filter(Boolean);
  if (words.length === 0 || !hasStatsCharts(data)) return [];
  const entries: StatsSearchEntry[] = STATS_SECTIONS.flatMap((section) => [
    { id: section.id, kind: "section" as const, label: section.label, location: "Section" },
    ...visibleStatsCards(section, data).map((card) => ({
      id: card.id,
      kind: "card" as const,
      label: card.label,
      location: section.label,
    })),
  ]);
  const matches: { entry: StatsSearchEntry; rank: number; order: number }[] = [];
  entries.forEach((entry, order) => {
    const label = normalize(entry.label);
    // A section's own location says nothing about it, so it matches on its label alone.
    const location = entry.kind === "section" ? "" : normalize(entry.location);
    let rank = 0;
    for (const word of words) {
      const wordMatch = labelRank(label, word) ?? (location.includes(word) ? 4 : null);
      if (wordMatch === null) return;
      rank = Math.max(rank, wordMatch);
    }
    if (words.length > 1) rank = Math.min(rank, labelRank(label, words.join(" ")) ?? rank);
    matches.push({ entry, rank, order });
  });
  matches.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return matches.map((match) => match.entry);
}
