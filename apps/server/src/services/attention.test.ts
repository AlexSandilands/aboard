import type { BoardEvent, TaskDetail } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";

function setup() {
  // Each call to the clock is a second later, so two requests never share a dedupe key.
  let tick = 0;
  const now = () => new Date(Date.parse("2026-10-01T12:00:00Z") + tick++ * 1000);
  const h = createTestHarness({ integrations: { now } });
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const task = s.tasks.create({
    projectId: project.id,
    title: "Ship it",
    plan: { phases: [{ title: "Build", steps: [{ title: "a" }] }] },
  });
  const created = () =>
    h.events.filter(
      (e): e is Extract<BoardEvent, { type: "notification.created" }> => e.type === "notification.created",
    );
  return { ...h, s, project, task, created };
}

describe("request attention", () => {
  it("flags the task, shows it under Needs attention and notifies once", () => {
    const { s, task, created, events } = setup();
    const flagged = s.attention.request(task.id, "  Please review the plan  ", "claude-code");
    expect(flagged.attentionRequest).toMatchObject({ message: "Please review the plan", actor: "claude-code" });
    expect(flagged.attention).toEqual([
      { kind: "agent_request", severity: "warning", message: "Please review the plan" },
    ]);
    expect(s.tasks.summaries({ attentionOnly: true }).map((t) => t.id)).toEqual([task.id]);
    expect(created()).toHaveLength(1);
    expect(created()[0]?.notification).toMatchObject({
      kind: "agent_request",
      taskId: task.id,
      title: "Attention requested on #1",
      body: "#1 Ship it\nPlease review the plan",
    });
    expect(events.some((e) => e.type === "task.upserted" && e.task.id === task.id)).toBe(true);
    expect(s.tasks.detail(task.id).events.map((e) => e.type)).toContain("attention_requested");
  });

  it("replaces the standing request and notifies again", () => {
    const { s, task, created } = setup();
    s.attention.request(task.id, "First", "claude-code");
    const second = s.attention.request(task.id, "Second", "copilot");
    expect(second.attentionRequest).toMatchObject({ message: "Second", actor: "copilot" });
    expect(second.attention.map((a) => a.message)).toEqual(["Second"]);
    expect(created()).toHaveLength(2);
  });

  it("keeps the flag when the notification kind is switched off", () => {
    const { s, task, created } = setup();
    s.settings.update({ notifications: { kinds: { agent_request: false } } });
    expect(s.attention.request(task.id, "Look", "claude-code").attention).toHaveLength(1);
    expect(created()).toHaveLength(0);
  });

  it("refuses an empty message and a finished task", () => {
    const { s, task } = setup();
    expect(() => s.attention.request(task.id, "   ", "claude-code")).toThrow(/what the user should look at/);
    s.tasks.close(task.id, { resolution: "wont_do" }, "user");
    expect(() => s.attention.request(task.id, "Look", "claude-code")).toThrow(/is done/);
  });

  it("is cleared by an agent or dismissed by the user, and clearing nothing is harmless", async () => {
    const { s, task, request } = setup();
    s.attention.request(task.id, "Look", "claude-code");
    expect(s.attention.clear(task.id, "claude-code")).toMatchObject({ cleared: true });
    expect(s.tasks.summary(task.id)).toMatchObject({ attention: [], attentionRequest: null });
    expect(s.attention.clear(task.id, "claude-code").cleared).toBe(false);

    s.attention.request(task.id, "Look again", "claude-code");
    const res = await request(`/api/tasks/${task.id}/attention-request`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as TaskDetail).attention).toEqual([]);
    expect(s.tasks.summary(task.id).attentionRequest).toBeNull();
    expect(s.tasks.detail(task.id).events.filter((e) => e.type === "attention_cleared")).toHaveLength(2);
  });

  it("drops the request when the task is finished, so reopening it doesn't bring it back", () => {
    const { s, task } = setup();
    s.attention.request(task.id, "Look", "claude-code");
    s.tasks.close(task.id, { resolution: "wont_do" }, "user");
    expect(s.tasks.summary(task.id)).toMatchObject({ attention: [], attentionRequest: null });
    s.tasks.move(task.id, { status: "in_progress" }, "user");
    expect(s.tasks.summary(task.id).attention).toEqual([]);

    s.attention.request(task.id, "Look again", "claude-code");
    s.tasks.move(task.id, { status: "done" }, "user");
    s.tasks.move(task.id, { status: "review" }, "user");
    expect(s.tasks.summary(task.id).attentionRequest).toBeNull();
  });

  it("drops an epic's request when its last task finishes and the epic rolls up to Done", () => {
    const { s, task, project } = setup();
    const epic = s.tasks.createEpic({ projectId: project.id, title: "Feature" }, [task.id], "agent");
    s.attention.request(epic.id, "Look at the epic", "claude-code");
    expect(s.tasks.summary(epic.id).attention).toHaveLength(1);
    s.tasks.close(task.id, { resolution: "wont_do" }, "user");
    expect(s.tasks.summary(epic.id)).toMatchObject({ status: "done", attention: [], attentionRequest: null });
    expect(s.tasks.detail(epic.id).events.map((e) => e.type)).toContain("attention_cleared");
  });
});
