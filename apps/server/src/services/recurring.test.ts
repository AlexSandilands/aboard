import { localStamp, type RecurringRuleView, type RecurringSchedule } from "@repo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.ts";
import { createTestHarness } from "../test/harness.ts";

const mondays: RecurringSchedule = { kind: "weekly", days: [1], time: "09:00" };

function setup() {
  const h = createTestHarness();
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const other = s.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
  const template = s.templates.create({ name: "Bump", titlePattern: "Bump {{date}}" });
  return { ...h, s, project, other, template };
}

const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

afterEach(() => vi.useRealTimers());

describe("recurring rules", () => {
  it("creates a rule that starts from now, enabled, unflagged", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 16, 12, 0));
    const { s, project, template } = setup();
    const rule = s.recurring.create(project.id, { name: "Weekly bump", templateId: template.id, schedule: mondays });
    expect(rule).toMatchObject({
      projectId: project.id,
      name: "Weekly bump",
      templateId: template.id,
      flagAutopilot: false,
      enabled: true,
      lastTaskId: null,
      lastDueAt: localStamp(new Date(2026, 9, 16, 12, 0)),
      nextDueAt: new Date(2026, 9, 19, 9, 0).toISOString(),
      lastTask: null,
    });
    expect(s.recurring.list(project.id)).toEqual([rule]);
  });

  it("publishes autopilot.changed when rules change, so open boards refresh", () => {
    const { s, project, template, events } = setup();
    const before = events.length;
    const rule = s.recurring.create(project.id, { name: "A", templateId: template.id, schedule: mondays });
    s.recurring.update(rule.id, { flagAutopilot: true });
    s.recurring.delete(rule.id);
    expect(events.slice(before).map((e) => e.type)).toEqual([
      "autopilot.changed",
      "autopilot.changed",
      "autopilot.changed",
    ]);
  });

  it("checks the template: it must exist, belong to the project or the board, and have a title pattern", () => {
    const { s, project, other, template } = setup();
    const mine = s.templates.create({ name: "Mine", projectId: project.id, titlePattern: "Mine" });
    const theirs = s.templates.create({ name: "Theirs", projectId: other.id, titlePattern: "Theirs" });
    const bare = s.templates.create({ name: "Bare" });
    const make = (templateId: string) =>
      s.recurring.create(project.id, { name: `Rule ${templateId}`, templateId, schedule: mondays });
    expect(make(template.id).templateId).toBe(template.id);
    expect(make(mine.id).templateId).toBe(mine.id);
    expectCode(() => make(theirs.id), "VALIDATION");
    expectCode(() => make(bare.id), "VALIDATION");
    expectCode(() => make("nope"), "NOT_FOUND");
    expectCode(
      () => s.recurring.create("nope", { name: "x", templateId: template.id, schedule: mondays }),
      "NOT_FOUND",
    );
  });

  it("keeps names unique per project, ignoring case", () => {
    const { s, project, other, template } = setup();
    const input = { templateId: template.id, schedule: mondays };
    const rule = s.recurring.create(project.id, { name: "Audit", ...input });
    expectCode(() => s.recurring.create(project.id, { name: "audit", ...input }), "CONFLICT");
    expect(s.recurring.create(other.id, { name: "Audit", ...input }).name).toBe("Audit");
    const second = s.recurring.create(project.id, { name: "Other", ...input });
    expectCode(() => s.recurring.update(second.id, { name: "AUDIT" }), "CONFLICT");
    expect(s.recurring.update(rule.id, { name: "AUDIT" }).name).toBe("AUDIT");
  });

  it("restarts the rule from now when it is switched on again or its schedule changes", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 1, 12, 0));
    const { s, project, template } = setup();
    const rule = s.recurring.create(project.id, { name: "A", templateId: template.id, schedule: mondays });
    const created = rule.lastDueAt;

    vi.setSystemTime(new Date(2026, 9, 10, 12, 0));
    expect(s.recurring.update(rule.id, { name: "B", flagAutopilot: true }).lastDueAt).toBe(created);
    s.recurring.update(rule.id, { enabled: false });
    expect(s.recurring.get(rule.id).lastDueAt).toBe(created);

    vi.setSystemTime(new Date(2026, 9, 14, 12, 0));
    expect(s.recurring.update(rule.id, { enabled: true }).lastDueAt).toBe(localStamp(new Date(2026, 9, 14, 12, 0)));

    vi.setSystemTime(new Date(2026, 9, 15, 12, 0));
    const changed = s.recurring.update(rule.id, { schedule: { kind: "weekly", days: [2], time: "09:00" } });
    expect(changed.lastDueAt).toBe(localStamp(new Date(2026, 9, 15, 12, 0)));
    // Saving the same schedule again changes nothing.
    vi.setSystemTime(new Date(2026, 9, 16, 12, 0));
    expect(s.recurring.update(rule.id, { schedule: changed.schedule }).lastDueAt).toBe(changed.lastDueAt);
  });

  it("says what became of the task a rule made last", () => {
    const { s, project, template } = setup();
    const task = s.tasks.create({ projectId: project.id, title: "Made" });
    const rule = s.recurring.create(project.id, { name: "A", templateId: template.id, schedule: mondays });
    s.recurring.handled(rule.id, { dueAt: localStamp(new Date()), taskId: task.id });
    expect(s.recurring.list(project.id)[0]?.lastTask).toEqual({
      number: task.number,
      status: "backlog",
      archived: false,
    });
    s.tasks.update(task.id, { archived: true }, "user");
    expect(s.recurring.list(project.id)[0]?.lastTask).toMatchObject({ archived: true });
  });

  it("never moves the cursor back when a slot is recorded late", () => {
    const { s, project, template } = setup();
    const rule = s.recurring.create(project.id, { name: "A", templateId: template.id, schedule: mondays });
    s.recurring.handled(rule.id, { dueAt: "2999-01-02T00:00:00.000Z" });
    s.recurring.handled(rule.id, { dueAt: "2999-01-01T00:00:00.000Z" });
    expect(s.recurring.get(rule.id).lastDueAt).toBe("2999-01-02T00:00:00.000Z");
  });

  it("goes with its project, and forgets a deleted template or task", () => {
    const { s, project, template, db } = setup();
    const task = s.tasks.create({ projectId: project.id, title: "Made" });
    const rule = s.recurring.create(project.id, { name: "A", templateId: template.id, schedule: mondays });
    s.recurring.handled(rule.id, { dueAt: localStamp(new Date()), taskId: task.id });

    s.templates.delete(template.id);
    expect(s.recurring.get(rule.id).templateId).toBeNull();
    s.tasks.update(task.id, { archived: true }, "user");
    s.tasks.delete(task.id, "user");
    expect(s.recurring.get(rule.id).lastTaskId).toBeNull();

    s.projects.delete(project.id);
    expect(db.prepare("SELECT count(*) AS n FROM autopilot_recurring").get()).toEqual({ n: 0 });
  });
});

describe("recurring REST routes", () => {
  it("lists, creates, edits and deletes a project's rules", async () => {
    const { request, project, template } = setup();
    const created = await request(`/api/projects/${project.id}/recurring`, {
      method: "POST",
      json: {
        name: "Weekly bump",
        templateId: template.id,
        schedule: { kind: "weekly", days: [5, 1], time: "09:30" },
        flagAutopilot: true,
      },
    });
    expect(created.status).toBe(201);
    const rule = (await created.json()) as RecurringRuleView;
    expect(rule).toMatchObject({ name: "Weekly bump", schedule: { days: [1, 5], time: "09:30" }, flagAutopilot: true });
    expect(rule.nextDueAt).toEqual(expect.any(String));

    const list = (await (await request(`/api/projects/${project.id}/recurring`)).json()) as RecurringRuleView[];
    expect(list.map((r) => r.id)).toEqual([rule.id]);

    const patched = await request(`/api/recurring/${rule.id}`, { method: "PATCH", json: { enabled: false } });
    expect(await patched.json()).toMatchObject({ id: rule.id, enabled: false });

    expect((await request(`/api/recurring/${rule.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await request(`/api/recurring/${rule.id}`, { method: "DELETE" })).status).toBe(404);
    expect(await (await request(`/api/projects/${project.id}/recurring`)).json()).toEqual([]);
  });

  it("rejects what the schema or the project can't take", async () => {
    const { request, project, template } = setup();
    const post = (json: unknown) => request(`/api/projects/${project.id}/recurring`, { method: "POST", json });
    const valid = { name: "A", templateId: template.id, schedule: mondays };
    expect((await post({ ...valid, schedule: { kind: "weekly", days: [], time: "09:00" } })).status).toBe(400);
    expect((await post({ ...valid, schedule: { kind: "weekly", days: [1], time: "9am" } })).status).toBe(400);
    expect((await post({ ...valid, name: " " })).status).toBe(400);
    expect((await post({ ...valid, templateId: "nope" })).status).toBe(404);
    expect((await post(valid)).status).toBe(201);
    expect((await post(valid)).status).toBe(409);
    expect((await request("/api/projects/nope/recurring")).status).toBe(404);
  });
});
