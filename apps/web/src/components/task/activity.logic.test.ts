import type { TaskEvent } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { describeEvent, type ActivityContext } from "./activity.logic";
import { describeLinkInput, threadStatusPresentation, ticketLinkHref } from "./links.logic";
import { classifyLink, TICKET_SYSTEM_PRESETS } from "@repo/contracts";

const JIRA = { ...TICKET_SYSTEM_PRESETS[0]!.system, linkTemplate: "https://jira.example.com/browse/{key}" };

const ctx: ActivityContext = {
  steps: new Map([["s1", { label: "1.2", title: "Write migrations" }]]),
  projectTitle: (id) => (id === "p2" ? "storefront" : undefined),
};

const event = (type: string, payload: Record<string, unknown> = {}): TaskEvent => ({
  id: 1,
  taskId: "t",
  at: "2026-01-01T00:00:00Z",
  actor: "claude-code",
  type,
  payload,
});

describe("describeEvent", () => {
  it("describes status moves with column labels", () => {
    expect(describeEvent(event("status_changed", { from: "backlog", to: "in_progress" }), ctx)).toEqual({
      icon: "status",
      text: "moved to In Progress",
      quote: null,
    });
  });

  it("describes an import turning a task into an epic", () => {
    expect(describeEvent(event("became_epic"), ctx).text).toBe(
      "turned this into an epic, since the imported issue is one",
    );
  });

  it("describes label changes", () => {
    const text = (payload: Record<string, unknown>) => describeEvent(event("labels_changed", payload), ctx).text;
    expect(text({ added: ["ui", "bug"], removed: ["server"] })).toBe("added 2 labels ui, bug; removed server");
    expect(text({ added: [], removed: ["ui"] })).toBe("removed ui");
    expect(text({})).toBe("changed the labels");
  });

  it("describes relation changes from either side", () => {
    const text = (type: string) => describeEvent(event(type, { task: 4, title: "Migration" }), ctx).text;
    expect(text("blocker_added")).toBe("made this blocked by #4 Migration");
    expect(text("blocks_added")).toBe("made this block #4 Migration");
    expect(text("blocker_removed")).toBe("removed #4 Migration as a blocker");
    expect(text("blocked_deleted")).toBe("deleted #4 Migration, which this blocked");
    expect(describeEvent(event("blocker_deleted", {}), ctx)).toEqual({
      icon: "delete",
      text: "deleted a task, which blocked this",
      quote: null,
    });
  });

  it("describes suggested model changes", () => {
    const line = (payload: Record<string, unknown>) => describeEvent(event("suggested_model_changed", payload), ctx);
    expect(line({ tier: "deep", reason: "Migration" })).toMatchObject({
      text: "suggested the deep model tier",
      quote: "Migration",
    });
    expect(line({ tier: null, reason: null })).toMatchObject({ text: "cleared the suggested model", quote: null });
  });

  it("describes the local review loop", () => {
    const text = (type: string, payload: Record<string, unknown>) => describeEvent(event(type, payload), ctx);
    expect(text("review_opened", { round: 1, trigger: "move" }).text).toBe("opened review round 1 (moved to Review)");
    expect(text("review_submitted", { round: 2, findings: { blocking: 1, major: 0, nit: 2 } })).toMatchObject({
      icon: "review_findings",
      text: "reviewed round 2: 1 blocking, 2 nit",
    });
    expect(text("review_submitted", { round: 3, findings: { blocking: 0 } }).icon).toBe("review_clean");
    expect(text("attention_requested", { message: "Review the plans" })).toMatchObject({
      text: "asked for your attention",
      quote: "Review the plans",
    });
    expect(text("attention_cleared", { requestedBy: "claude-code" }).text).toBe("cleared the request for attention");
    expect(text("finding_resolved", { finding: "R1.2", status: "wont_fix", note: "By design" })).toEqual({
      icon: "review",
      text: "marked R1.2 won't fix",
      quote: "By design",
    });
    expect(text("finding_resolved", { finding: "R1.2", status: "open" }).text).toBe("reopened R1.2");
    expect(text("review_status", { round: 1, status: "failed", error: "CLI not found" })).toMatchObject({
      icon: "step_blocked",
      quote: "CLI not found",
    });
  });

  it("explains a resolution whose task was deleted", () => {
    expect(describeEvent(event("resolver_deleted", { number: 7, title: "Ship it" }), ctx)).toEqual({
      icon: "delete",
      text: "deleted #7, which closed this",
      quote: null,
    });
  });

  it("describes a task restored from a backup", () => {
    expect(describeEvent(event("restored", { backupNumber: 42 }), ctx).text).toBe(
      "restored this from a backup (as #42)",
    );
  });

  it("describes closing and reopening", () => {
    const text = (type: string, payload: Record<string, unknown>) => describeEvent(event(type, payload), ctx).text;
    expect(text("closed", { resolution: "completed", byTask: 4 })).toBe("closed this as done by #4");
    expect(text("closed", { resolution: "duplicate", byTask: 4 })).toBe("closed this as a duplicate of #4");
    expect(text("closed", { resolution: "wont_do" })).toBe("closed this as won't do");
    expect(text("status_changed", { from: "done", to: "backlog", clearedResolution: "wont_do" })).toBe(
      "reopened this and moved to Backlog",
    );
    expect(text("status_changed", { from: "review", to: "done", mergedPr: "acme/app#12" })).toBe(
      "moved to Done when acme/app#12 merged",
    );
  });

  it("names steps by their current index label, falling back to the logged title", () => {
    expect(
      describeEvent(event("step_updated", { stepId: "s1", title: "old", from: "in_progress", to: "done" }), ctx).text,
    ).toBe("completed 1.2 Write migrations");
    expect(
      describeEvent(event("step_updated", { stepId: "gone", title: "Old step", to: "in_progress" }), ctx).text,
    ).toBe("started Old step");
    expect(describeEvent(event("step_updated", { stepId: "s1", title: "x" }), ctx).text).toBe(
      "edited 1.2 Write migrations",
    );
  });

  it("quotes notes and summarises plans", () => {
    expect(describeEvent(event("note", { text: "Handover: tests pass" }), ctx)).toMatchObject({
      icon: "note",
      quote: "Handover: tests pass",
    });
    expect(describeEvent(event("plan_set", { phases: 2, steps: 1 }), ctx).text).toBe("set the plan (2 phases, 1 step)");
    expect(describeEvent(event("plan_set", { phases: 1, steps: 1, deleted: ["1.1 a", "1.2 b"] }), ctx)).toMatchObject({
      text: "set the plan (1 phase, 1 step)",
      quote: "Deleted 2 steps:\n\n- 1.1 a\n- 1.2 b",
    });
    expect(describeEvent(event("moved_project", { to: "p2" }), ctx).text).toBe("moved to project storefront");
    expect(describeEvent(event("archived"), ctx).text).toBe("archived this");
    expect(describeEvent(event("archived", { withEpic: 12 }), ctx).text).toBe("archived this with epic #12");
    expect(describeEvent(event("unarchived", { withEpic: 12 }), ctx).text).toBe("unarchived this with epic #12");
    expect(describeEvent(event("unarchived", { becauseTask: 7, reopened: true }), ctx).text).toBe(
      "unarchived this because #7 was reopened",
    );
    expect(describeEvent(event("unarchived", { becauseTask: 7, reopened: false }), ctx).text).toBe(
      "unarchived this because #7 was unarchived",
    );
    expect(describeEvent(event("updated", { fields: ["title", "planContext"] }), ctx).text).toBe(
      "edited the title, plan context",
    );
  });

  it("falls back to the event name for unknown types", () => {
    expect(describeEvent(event("something_new"), ctx)).toEqual({ icon: "other", text: "something new", quote: null });
  });
});

describe("links logic", () => {
  it("previews the detected link kind", () => {
    expect(describeLinkInput(classifyLink("https://github.com/acme/app/pull/12"))?.label).toBe(
      "Pull request acme/app#12",
    );
    const ticketSystems = [JIRA];
    expect(describeLinkInput(classifyLink("ABC-12", { ticketSystems }), ticketSystems)?.label).toBe("Jira ABC-12");
    expect(describeLinkInput(classifyLink("ABC-12"))).toBeNull();
    expect(describeLinkInput(classifyLink("https://www.example.com/x"))?.label).toBe("Link to example.com");
    expect(describeLinkInput(classifyLink("not a link"))).toBeNull();
  });

  it("builds ticket hrefs from the stored URL or the system's link template", () => {
    const base = {
      id: "l",
      taskId: "t",
      label: null,
      syncedAt: null,
      createdAt: "",
      kind: "ticket" as const,
      ref: { system: "jira", key: "ABC-1" },
    };
    expect(ticketLinkHref({ ...base, url: "ABC-1" }, [JIRA])).toBe("https://jira.example.com/browse/ABC-1");
    expect(ticketLinkHref({ ...base, url: "ABC-1" }, [])).toBeNull();
    expect(ticketLinkHref({ ...base, url: "https://j.example.com/browse/ABC-1" }, null)).toBe(
      "https://j.example.com/browse/ABC-1",
    );
  });

  it("hides idle thread status", () => {
    expect(threadStatusPresentation("idle")).toBeNull();
    expect(threadStatusPresentation("input")?.label).toBe("Awaiting Input");
  });
});
