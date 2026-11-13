import type { BoardEvent, PrSnapshot, T3ThreadStatus, TaskDetail, TaskSummary } from "@repo/contracts";
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
    expect(flagged.attention).toMatchObject([
      { kind: "agent_request", severity: "warning", message: "Please review the plan", key: "request" },
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

describe("dismissing flags", () => {
  const HEAD = "1111111111111111111111111111111111111111";
  const prSnapshot = (headOid = HEAD): PrSnapshot => ({
    state: "open",
    title: "Ship it",
    checks: "failing",
    reviewDecision: null,
    mergeable: "mergeable",
    headRef: "ship",
    headOid,
    updatedAt: "2026-10-01T11:00:00.000Z",
  });
  const threadSnapshot = (status: T3ThreadStatus, lastActivityAt = "2026-10-01T11:00:00.000Z") => ({
    title: "Agent thread",
    status,
    lastActivityAt,
  });

  /** A task with a failed thread, a PR whose checks fail and a blocked step. */
  function flagged() {
    const ctx = setup();
    const { s, task } = ctx;
    const thread = s.links.add(task.id, { value: "t3code://threads/env/th1" }, "user");
    const pr = s.links.add(task.id, { value: "https://github.com/acme/app/pull/7" }, "user");
    s.links.setSnapshot(thread.id, threadSnapshot("working"));
    s.links.setSnapshot(thread.id, threadSnapshot("failed"));
    s.links.setSnapshot(pr.id, { ...prSnapshot(), checks: "passing" });
    s.links.setSnapshot(pr.id, prSnapshot());
    const step = s.tasks.detail(task.id).phases[0]!.steps[0]!;
    s.plans.updateStep(step.id, { status: "blocked" }, "claude-code");
    const kinds = () => s.tasks.summary(task.id).attention.map((a) => a.kind);
    const post = (body: object) =>
      ctx.request(`/api/tasks/${task.id}/attention/dismissals`, { method: "POST", json: body });
    const del = (key?: string) =>
      ctx.request(`/api/tasks/${task.id}/attention/dismissals${key ? `?key=${encodeURIComponent(key)}` : ""}`, {
        method: "DELETE",
      });
    return { ...ctx, thread, pr, step, kinds, post, del };
  }

  it("hides one flag, keeps the link, and lists it as dismissed", async () => {
    const { s, task, thread, kinds, post } = flagged();
    expect(kinds()).toEqual(["blocked_step", "session_failed", "pr_checks_failing"]);
    const res = await post({ key: `link:${thread.id}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskSummary;
    expect(body.attention.map((a) => a.kind)).toEqual(["blocked_step", "pr_checks_failing"]);
    expect(body.dismissedAttention).toMatchObject([{ kind: "session_failed", dismissedBy: "user" }]);
    expect(body.links.map((l) => l.id)).toContain(thread.id);
    expect(s.tasks.detail(task.id).events.find((e) => e.type === "attention_dismissed")?.payload).toEqual({
      flags: ["Thread failed"],
    });
    // Dismissing it again (a second tab) is harmless; a flag the task never had is refused.
    expect((await post({ key: `link:${thread.id}` })).status).toBe(200);
    expect((await post({ key: "link:nope" })).status).toBe(409);
  });

  it("raises a dismissed flag again when the state behind it changes", async () => {
    const { s, thread, pr, step, task, kinds, post } = flagged();
    await post({});
    expect(kinds()).toEqual([]);
    expect(s.tasks.summaries({ attentionOnly: true })).toEqual([]);

    // The thread ran and failed again; the PR's checks fail on a new commit; a second step is blocked.
    s.links.setSnapshot(thread.id, threadSnapshot("failed", "2026-10-01T12:30:00.000Z"));
    expect(kinds()).toEqual(["session_failed"]);
    s.links.setSnapshot(pr.id, prSnapshot("2222222222222222222222222222222222222222"));
    expect(kinds()).toEqual(["session_failed", "pr_checks_failing"]);
    const [added] = s.plans.addSteps(step.phaseId, [{ title: "b" }], "claude-code");
    s.plans.updateStep(added!.id, { status: "blocked" }, "claude-code");
    expect(kinds()).toEqual(["blocked_step", "session_failed", "pr_checks_failing"]);
    expect(s.tasks.summary(task.id).dismissedAttention).toEqual([]);
  });

  it("dismisses everything at once: derived flags, the agent's request and Autopilot's runs", async () => {
    const { s, task, kinds, post, events } = flagged();
    s.attention.request(task.id, "Look", "claude-code");
    const run = s.autopilot.record({
      automation: "noop",
      candidate: { dedupeKey: "k", summary: "stuck", taskId: task.id },
      dryRun: false,
    });
    s.autopilot.finish(run!.id, { status: "failed", error: "No runner", needsAttention: true });
    expect(kinds()).toEqual(["agent_request", "autopilot", "blocked_step", "session_failed", "pr_checks_failing"]);
    events.length = 0;
    const res = await post({});
    const body = (await res.json()) as TaskSummary;
    expect(body.attention).toEqual([]);
    expect(body.attentionRequest).toBeNull();
    // The request and the runs have their own dismissal, which can't be restored.
    expect(body.dismissedAttention.map((a) => a.kind)).toEqual(["blocked_step", "session_failed", "pr_checks_failing"]);
    expect(events.some((e) => e.type === "task.upserted" && e.task.id === task.id)).toBe(true);
    expect(s.notifications.list().items.filter((n) => n.kind === "pr_checks_failing" && !n.readAt)).toEqual([]);
    // Nothing left to dismiss.
    expect((await post({})).status).toBe(200);
  });

  it("restores one dismissed flag, or all of them", async () => {
    const { s, task, thread, kinds, post, del } = flagged();
    await post({});
    expect((await del(`link:${thread.id}`)).status).toBe(200);
    expect(kinds()).toEqual(["session_failed"]);
    const body = (await (await del()).json()) as TaskSummary;
    expect(body.attention.map((a) => a.kind)).toEqual(["blocked_step", "session_failed", "pr_checks_failing"]);
    expect(body.dismissedAttention).toEqual([]);
    expect(s.tasks.detail(task.id).events.filter((e) => e.type === "attention_restored")).toHaveLength(2);
  });

  it("stops flagging a failed session once the task is Done", () => {
    const { s, task, step, kinds } = flagged();
    s.plans.updateStep(step.id, { status: "done" }, "claude-code");
    s.tasks.move(task.id, { status: "review" }, "user");
    expect(kinds()).toContain("session_failed");
    s.tasks.move(task.id, { status: "done" }, "user");
    expect(kinds()).not.toContain("session_failed");
  });
});
