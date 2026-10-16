import type { TaskLink, TaskRelation, TaskReview, TaskReviewSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  collapsedByDefault,
  firstLine,
  moveSection,
  normalizeSectionLayout,
  SECTION_IDS,
  summarizeSection,
  type SectionTask,
  withCollapseChoice,
} from "./sections.logic";

const NOW = Date.parse("2026-10-15T12:00:00Z");

function task(patch: Partial<SectionTask> = {}): SectionTask {
  return {
    labels: [],
    links: [],
    blockedBy: [],
    blocks: [],
    attention: [],
    review: null,
    reviews: [],
    progress: { done: 0, total: 0 },
    currentStep: null,
    description: null,
    planContext: null,
    events: [],
    ...patch,
  };
}

const relation = (number: number, status: TaskRelation["status"]): TaskRelation => ({
  id: `t${number}`,
  number,
  title: `Task ${number}`,
  status,
  archived: false,
});
const link = { id: "l", kind: "url", url: "https://example.com" } as TaskLink;
const round = (statuses: Array<"open" | "fixed">) =>
  ({ findings: statuses.map((status) => ({ status })) }) as unknown as TaskReview;
const summary = (state: TaskReviewSummary["state"]): TaskReviewSummary => ({
  state,
  round: 1,
  maxRounds: 3,
  open: { blocking: 0, major: 0, minor: 0, nit: 0 },
  byBoard: false,
});

describe("normalizeSectionLayout", () => {
  it("defaults everything when nothing is stored", () => {
    expect(normalizeSectionLayout({})).toEqual({ order: [...SECTION_IDS], hidden: [], collapsed: {} });
  });

  it("drops unknown and duplicate ids and appends missing sections", () => {
    const layout = normalizeSectionLayout({ order: ["plan", "nope", "plan", 3, "activity"] });
    expect(layout.order).toEqual(["plan", "activity", "labels", "links", "relations", "review", "details"]);
  });

  it("keeps known hidden ids in default order and only boolean collapsed choices", () => {
    const layout = normalizeSectionLayout({
      hidden: ["review", "bogus", "labels", "review"],
      collapsed: { plan: true, links: false, bogus: true, activity: "yes" },
    });
    expect(layout.hidden).toEqual(["labels", "review"]);
    expect(layout.collapsed).toEqual({ plan: true, links: false });
  });

  it("survives garbage", () => {
    expect(normalizeSectionLayout({ order: "plan", hidden: null, collapsed: 5 })).toEqual(normalizeSectionLayout({}));
  });
});

describe("moveSection", () => {
  it("moves a section to the target's slot in either direction", () => {
    expect(moveSection(["labels", "links", "plan"], "plan", "labels")).toEqual(["plan", "labels", "links"]);
    expect(moveSection(["labels", "links", "plan"], "labels", "plan")).toEqual(["links", "plan", "labels"]);
  });
});

describe("collapsedByDefault", () => {
  it("collapses empty sections and always the activity log", () => {
    const empty = task();
    expect(SECTION_IDS.filter((id) => collapsedByDefault(id, empty))).toEqual([
      "links",
      "relations",
      "review",
      "details",
      "activity",
    ]);
  });

  it("opens sections with content", () => {
    const full = task({
      links: [link],
      blocks: [relation(2, "planned")],
      reviews: [round([])],
      planContext: "Why",
    });
    expect(SECTION_IDS.filter((id) => collapsedByDefault(id, full))).toEqual(["activity"]);
  });

  it("treats whitespace-only text as empty", () => {
    expect(collapsedByDefault("details", task({ description: "  \n" }))).toBe(true);
  });
});

describe("withCollapseChoice", () => {
  it("saves a choice that differs from the default", () => {
    expect(withCollapseChoice({}, "links", false, true)).toEqual({ links: false });
    expect(withCollapseChoice({ plan: true }, "links", true, false)).toEqual({ plan: true, links: true });
  });

  it("clears the choice when it matches the default", () => {
    expect(withCollapseChoice({ links: false, plan: true }, "links", true, true)).toEqual({ plan: true });
  });
});

describe("firstLine", () => {
  it("strips leading markdown syntax and skips blank lines", () => {
    expect(firstLine("\n\n## **Goal**: ship it\nmore")).toBe("Goal: ship it");
    expect(firstLine("- [x] done thing")).toBe("done thing");
    expect(firstLine("> quoted `code`")).toBe("quoted code");
    expect(firstLine("  \n ")).toBeNull();
    expect(firstLine(null)).toBeNull();
  });
});

describe("summarizeSection", () => {
  it("labels", () => {
    expect(summarizeSection("labels", task())).toBe("None");
    expect(summarizeSection("labels", task({ labels: ["bug", "ui"] }))).toBe("bug, ui");
  });

  it("links, with the first link problem", () => {
    expect(summarizeSection("links", task())).toBe("None");
    expect(summarizeSection("links", task({ links: [link, link] }))).toBe("2");
    const attention = [
      { kind: "blocked_step", severity: "warning", message: "Step blocked" },
      { kind: "pr_checks_failing", severity: "error", message: "PR #4 checks failing" },
    ] as SectionTask["attention"];
    expect(summarizeSection("links", task({ links: [link], attention }))).toBe("1 · PR #4 checks failing");
  });

  it("relations, naming only the blockers still open", () => {
    expect(summarizeSection("relations", task())).toBe("None");
    expect(summarizeSection("relations", task({ blockedBy: [relation(4, "planned"), relation(5, "done")] }))).toBe(
      "blocked by #4",
    );
    expect(summarizeSection("relations", task({ blockedBy: [relation(5, "done")] }))).toBe("Unblocked");
    expect(
      summarizeSection("relations", task({ blockedBy: [relation(4, "review")], blocks: [relation(8, "backlog")] })),
    ).toBe("blocked by #4 · blocks #8");
  });

  it("review", () => {
    expect(summarizeSection("review", task())).toBe("Not reviewed yet");
    expect(summarizeSection("review", task({ review: summary("running"), reviews: [round(["open"])] }))).toBe(
      "Reviewing",
    );
    const reviews = [round(["open", "fixed"]), round(["open"])];
    expect(summarizeSection("review", task({ review: summary("changes_requested"), reviews }))).toBe("2 open findings");
    expect(summarizeSection("review", task({ review: summary("clean"), reviews: [round(["fixed"])] }))).toBe(
      "Reviewed",
    );
  });

  it("plan", () => {
    expect(summarizeSection("plan", task())).toBe("No plan yet");
    expect(summarizeSection("plan", task({ progress: { done: 3, total: 3 } }))).toBe("3/3");
    const currentStep = { id: "s", title: "Wire it up", phaseTitle: "P", status: "todo", index: "2.1" } as const;
    expect(summarizeSection("plan", task({ progress: { done: 4, total: 10 }, currentStep }))).toBe(
      "4/10 · 2.1 Wire it up",
    );
  });

  it("details falls back from description to plan context", () => {
    expect(summarizeSection("details", task())).toBe("Empty");
    expect(summarizeSection("details", task({ planContext: "# Context" }))).toBe("Context");
    expect(summarizeSection("details", task({ description: "What", planContext: "Why" }))).toBe("What");
  });

  it("activity", () => {
    expect(summarizeSection("activity", task(), NOW)).toBe("No activity yet");
    const events = [{ at: "2026-10-15T08:00:00Z" }, { at: "2026-10-15T10:00:00Z" }] as SectionTask["events"];
    expect(summarizeSection("activity", task({ events }), NOW)).toBe("2 · last 2h ago");
    expect(
      summarizeSection("activity", task({ events: [{ at: "2026-10-15T12:00:00Z" }] as SectionTask["events"] }), NOW),
    ).toBe("1 · last just now");
  });
});
