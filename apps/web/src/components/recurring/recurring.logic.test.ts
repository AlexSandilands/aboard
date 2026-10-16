import { CreateRecurringRuleInput, type RecurringRuleView, type TaskSummary, type TaskTemplate } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  RULE_SUGGESTIONS,
  anchorSchedule,
  emptyRuleForm,
  formFromRule,
  formToInput,
  lastTaskLabel,
  nextDueLabel,
  remainingSuggestions,
  usableTemplates,
} from "./recurring.logic";

const rule = (over: Partial<RecurringRuleView> = {}): RecurringRuleView => ({
  id: "r1",
  projectId: "p1",
  name: "Weekly bump",
  templateId: "t1",
  schedule: { kind: "weekly", days: [1, 4], time: "09:00" },
  flagAutopilot: true,
  enabled: true,
  lastDueAt: "2026-10-12T08:00:00.000Z",
  lastTaskId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  nextDueAt: "2026-10-15T08:00:00.000Z",
  ...over,
});

const template = (over: Partial<TaskTemplate>): TaskTemplate => ({
  id: "t",
  name: "T",
  projectId: null,
  titlePattern: "Do it",
  description: null,
  labels: [],
  planContext: null,
  phases: [],
  suggestedTier: null,
  createdAt: "",
  updatedAt: "",
  ...over,
});

describe("rule form", () => {
  it("starts as a weekly Monday-morning rule starting today", () => {
    expect(emptyRuleForm(new Date(2026, 9, 16))).toMatchObject({
      kind: "weekly",
      days: [1],
      time: "09:00",
      startDate: "2026-10-16",
      flagAutopilot: false,
      enabled: true,
    });
  });

  it("round-trips a rule through the form", () => {
    const input = formToInput(formFromRule(rule()));
    expect(input).toEqual({
      ok: true,
      input: {
        name: "Weekly bump",
        templateId: "t1",
        schedule: { kind: "weekly", days: [1, 4], time: "09:00" },
        flagAutopilot: true,
        enabled: true,
      },
    });
    const every = rule({ schedule: { kind: "every", everyDays: 14, startDate: "2026-10-01", time: "06:30" } });
    expect(formToInput(formFromRule(every))).toMatchObject({
      ok: true,
      input: { schedule: { kind: "every", everyDays: 14, startDate: "2026-10-01", time: "06:30" } },
    });
  });

  it("produces input the server accepts", () => {
    const result = formToInput({ ...emptyRuleForm(new Date(2026, 9, 16)), name: "A", templateId: "t", days: [5, 1] });
    expect(result.ok && CreateRecurringRuleInput.safeParse(result.input).success).toBe(true);
  });

  it("says what is missing", () => {
    const form = { ...emptyRuleForm(new Date(2026, 9, 16)), name: "A", templateId: "t" };
    const error = (over: Partial<typeof form>) => {
      const result = formToInput({ ...form, ...over });
      return result.ok ? null : result.error;
    };
    expect(error({ name: "  " })).toMatch(/name/);
    expect(error({ templateId: "" })).toMatch(/template/);
    expect(error({ days: [] })).toMatch(/weekday/);
    expect(error({ time: "" })).toMatch(/time/);
    expect(error({ kind: "every", everyDays: "0" })).toMatch(/1 to 365/);
    expect(error({ kind: "every", everyDays: "1.5" })).toMatch(/1 to 365/);
    expect(error({ kind: "every", startDate: "" })).toMatch(/start date/);
    expect(error({})).toBeNull();
  });

  it("offers only templates the project can use, with a title pattern", () => {
    const list = [
      template({ id: "all" }),
      template({ id: "mine", projectId: "p1" }),
      template({ id: "theirs", projectId: "p2" }),
      template({ id: "bare", titlePattern: " " }),
    ];
    expect(usableTemplates(list, "p1").map((t) => t.id)).toEqual(["all", "mine"]);
  });
});

describe("labels", () => {
  const now = new Date("2026-10-14T00:00:00.000Z");

  it("shows when a rule is next due, or why it isn't", () => {
    expect(nextDueLabel(rule(), now)).not.toMatch(/Due now|Paused/);
    expect(nextDueLabel(rule({ nextDueAt: "2026-10-13T08:00:00.000Z" }), now)).toBe("Due now");
    expect(nextDueLabel(rule({ enabled: false }), now)).toBe("Paused");
    expect(nextDueLabel(rule({ nextDueAt: null }), now)).toBe("No upcoming slot");
  });

  it("says what became of the last task", () => {
    const task = (over: Partial<TaskSummary>) =>
      ({ id: "x", number: 7, status: "backlog", archivedAt: null, ...over }) as TaskSummary;
    expect(lastTaskLabel(rule(), [])).toBeNull();
    expect(lastTaskLabel(rule({ lastTaskId: "x" }), [task({})])).toBe("#7 still open");
    expect(lastTaskLabel(rule({ lastTaskId: "x" }), [task({ status: "done" })])).toBe("#7 done");
    expect(lastTaskLabel(rule({ lastTaskId: "x" }), [task({ archivedAt: "2026-10-01T00:00:00.000Z" })])).toBe(
      "#7 archived",
    );
    expect(lastTaskLabel(rule({ lastTaskId: "gone" }), [task({})])).toBe("Last task is gone");
  });
});

describe("suggestions", () => {
  it("are valid rules with a template each, and unique names", () => {
    expect(new Set(RULE_SUGGESTIONS.map((s) => s.name)).size).toBe(RULE_SUGGESTIONS.length);
    for (const suggestion of RULE_SUGGESTIONS) {
      expect(suggestion.template.titlePattern?.trim()).toBeTruthy();
      expect(
        CreateRecurringRuleInput.safeParse({ name: suggestion.name, templateId: "t", schedule: suggestion.schedule })
          .success,
      ).toBe(true);
    }
  });

  it("drops the ones a project already has, ignoring case", () => {
    const taken = RULE_SUGGESTIONS[0]!.name.toUpperCase();
    const left = remainingSuggestions([{ name: taken }]);
    expect(left).toHaveLength(RULE_SUGGESTIONS.length - 1);
    expect(left.map((s) => s.name)).not.toContain(RULE_SUGGESTIONS[0]!.name);
  });

  it("count an interval from today", () => {
    const every = RULE_SUGGESTIONS.find((s) => s.schedule.kind === "every")!;
    expect(anchorSchedule(every.schedule, new Date(2026, 9, 16))).toMatchObject({ startDate: "2026-10-16" });
    const weekly = RULE_SUGGESTIONS.find((s) => s.schedule.kind === "weekly")!;
    expect(anchorSchedule(weekly.schedule)).toBe(weekly.schedule);
  });
});
