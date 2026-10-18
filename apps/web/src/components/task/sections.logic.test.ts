import type { TaskLink, TaskRelation, TaskReview, TaskReviewSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import type { PlainLink } from "./links.logic";
import {
  collapsedByDefault,
  firstLine,
  limitItems,
  linkSummaryChips,
  moveSection,
  normalizeSectionLayout,
  relationChipGroups,
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
    autopilot: null,
    autoReview: null,
    autoMerge: null,
    priority: false,
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
const thread = { id: "t", kind: "t3_thread" } as TaskLink;
const session = { id: "s", kind: "agent_session" } as TaskLink;
const round = (statuses: Array<"open" | "fixed">) =>
  ({ findings: statuses.map((status) => ({ status })) }) as unknown as TaskReview;
const summary = (state: TaskReviewSummary["state"]): TaskReviewSummary => ({
  state,
  round: 1,
  maxRounds: 3,
  open: { blocking: 0, major: 0, minor: 0, nit: 0 },
  byBoard: false,
  verifiedOnPr: false,
});

describe("normalizeSectionLayout", () => {
  it("defaults everything when nothing is stored", () => {
    expect(normalizeSectionLayout({})).toEqual({ order: [...SECTION_IDS], hidden: [], collapsed: {} });
  });

  it("drops unknown and duplicate ids and appends missing sections", () => {
    const layout = normalizeSectionLayout({ order: ["plan", "nope", "plan", 3, "activity"] });
    expect(layout.order).toEqual([
      "plan",
      "activity",
      "labels",
      "sessions",
      "links",
      "relations",
      "automation",
      "review",
      "autopilot",
      "details",
    ]);
  });

  it("keeps known hidden ids in default order and only boolean collapsed choices", () => {
    const layout = normalizeSectionLayout({
      hidden: ["review", "bogus", "labels", "review"],
      collapsed: { plan: true, links: false, bogus: true, activity: "yes" },
    });
    expect(layout.hidden).toEqual(["labels", "review"]);
    expect(layout.collapsed).toEqual({ plan: true, links: false });
  });

  it("places Sessions before Links in a layout saved without it, keeping the user's order", () => {
    const saved = ["plan", "labels", "links", "relations", "review", "autopilot", "details", "activity"];
    expect(normalizeSectionLayout({ order: saved }).order).toEqual([
      "plan",
      "labels",
      "sessions",
      "links",
      "relations",
      "automation",
      "review",
      "autopilot",
      "details",
      "activity",
    ]);
  });

  it("keeps Sessions where the user put it once it is saved", () => {
    const order = [
      "sessions",
      "plan",
      "labels",
      "links",
      "relations",
      "automation",
      "review",
      "autopilot",
      "details",
      "activity",
    ];
    expect(normalizeSectionLayout({ order }).order).toEqual(order);
  });

  it("places Automation before Local review in a layout saved without it", () => {
    const saved = ["review", "plan", "sessions", "labels", "links", "relations", "autopilot", "details", "activity"];
    expect(normalizeSectionLayout({ order: saved }).order).toEqual([
      "automation",
      "review",
      "plan",
      "sessions",
      "labels",
      "links",
      "relations",
      "autopilot",
      "details",
      "activity",
    ]);
  });

  it("hides Sessions with Links in a layout saved before Sessions existed", () => {
    const order = ["labels", "links", "relations", "review", "autopilot", "plan", "details", "activity"];
    expect(normalizeSectionLayout({ order, hidden: ["links", "review"] }).hidden).toEqual([
      "sessions",
      "links",
      "review",
    ]);
    // Once saved with Sessions, showing it again sticks.
    expect(normalizeSectionLayout({ order: ["sessions", ...order], hidden: ["links"] }).hidden).toEqual(["links"]);
  });

  it("collapses Sessions with Links in a layout saved before Sessions existed", () => {
    const order = ["labels", "links", "relations", "review", "autopilot", "plan", "details", "activity"];
    expect(normalizeSectionLayout({ order, collapsed: { links: true } }).collapsed).toEqual({
      links: true,
      sessions: true,
    });
    expect(normalizeSectionLayout({ order, collapsed: { links: false } }).collapsed.sessions).toBe(false);
    expect(normalizeSectionLayout({ order, collapsed: { plan: true } }).collapsed).toEqual({ plan: true });
    // Once saved with Sessions, its own choice stays.
    expect(normalizeSectionLayout({ order: ["sessions", ...order], collapsed: { links: true } }).collapsed).toEqual({
      links: true,
    });
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
      "sessions",
      "links",
      "relations",
      "review",
      "autopilot",
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
    expect(SECTION_IDS.filter((id) => collapsedByDefault(id, full))).toEqual(["sessions", "autopilot", "activity"]);
  });

  it("opens Sessions and Links by their own kind of link", () => {
    expect(collapsedByDefault("sessions", task({ links: [thread] }))).toBe(false);
    expect(collapsedByDefault("links", task({ links: [thread, session] }))).toBe(true);
    expect(collapsedByDefault("sessions", task({ links: [link] }))).toBe(true);
    expect(collapsedByDefault("links", task({ links: [session, link] }))).toBe(false);
  });

  it("keeps Automation open: the settings are its content", () => {
    expect(collapsedByDefault("automation", task())).toBe(false);
  });

  it("opens Autopilot only when a run needs attention", () => {
    const flagged = task({ attention: [{ kind: "autopilot", severity: "warning", message: "Start planned failed" }] });
    expect(collapsedByDefault("autopilot", task())).toBe(true);
    expect(collapsedByDefault("autopilot", flagged)).toBe(false);
    expect(summarizeSection("autopilot", flagged)).toBe("Start planned failed");
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

  it("sessions, with a thread problem", () => {
    expect(summarizeSection("sessions", task({ links: [link] }))).toBe("None");
    expect(summarizeSection("sessions", task({ links: [thread, session, link] }))).toBe("2");
    const attention = [
      { kind: "pr_checks_failing", severity: "error", message: "PR #4 checks failing" },
      { kind: "thread_needs_input", severity: "warning", message: "Needs input" },
    ] as SectionTask["attention"];
    expect(summarizeSection("sessions", task({ links: [thread, link], attention }))).toBe("1 · Needs input");
  });

  it("links, with the first link problem", () => {
    expect(summarizeSection("links", task())).toBe("None");
    expect(summarizeSection("links", task({ links: [thread] }))).toBe("None");
    expect(summarizeSection("links", task({ links: [link, link, thread] }))).toBe("2");
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

  it("automation names the settings that differ from their default", () => {
    expect(summarizeSection("automation", task())).toBe("Defaults");
    expect(summarizeSection("automation", task({ autopilot: true, autoMerge: false, priority: true }))).toBe(
      "Autopilot on · Auto-merge off · Priority",
    );
    expect(summarizeSection("automation", task({ autopilot: false, autoReview: true }))).toBe(
      "Autopilot off · Auto-review on",
    );
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

describe("limitItems", () => {
  it("keeps the first items and counts the rest", () => {
    expect(limitItems(["a", "b", "c", "d", "e"], 3)).toEqual({ shown: ["a", "b", "c"], hidden: 2 });
  });

  it("hides nothing when everything fits", () => {
    expect(limitItems(["a", "b"], 3)).toEqual({ shown: ["a", "b"], hidden: 0 });
    expect(limitItems([], 3)).toEqual({ shown: [], hidden: 0 });
  });
});

describe("relationChipGroups", () => {
  it("is empty without relations", () => {
    expect(relationChipGroups({ blockedBy: [], blocks: [] })).toEqual([]);
  });

  it("colours blockers by whether they are done and lists open ones first", () => {
    const [group] = relationChipGroups({ blockedBy: [relation(1, "done"), relation(2, "in_progress")], blocks: [] });
    expect(group?.kind).toBe("blockedBy");
    expect(group?.chips.map((c) => [c.number, c.tone])).toEqual([
      [2, "blocking"],
      [1, "done"],
    ]);
  });

  it("lists what the task holds up as neutral, after the blockers", () => {
    const groups = relationChipGroups({ blockedBy: [relation(1, "planned")], blocks: [relation(9, "backlog")] });
    expect(groups.map((g) => g.kind)).toEqual(["blockedBy", "blocks"]);
    expect(groups[1]?.chips).toEqual([{ id: "t9", number: 9, title: "Task 9", tone: "neutral" }]);
  });
});

describe("linkSummaryChips", () => {
  const pr = (id: string) => ({ id, kind: "pr" }) as PlainLink;
  const jira = (id: string) => ({ id, kind: "jira" }) as PlainLink;

  it("shows PRs and counts every other link as the rest", () => {
    expect(linkSummaryChips([pr("a"), jira("b"), jira("c")])).toEqual({ prs: [pr("a")], rest: 2 });
  });

  it("counts PRs past the cap as part of the rest", () => {
    const { prs, rest } = linkSummaryChips([pr("a"), pr("b"), pr("c"), pr("d"), jira("e")]);
    expect(prs.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(rest).toBe(2);
  });

  it("has nothing to show without a PR", () => {
    expect(linkSummaryChips([jira("a")])).toEqual({ prs: [], rest: 1 });
  });
});
