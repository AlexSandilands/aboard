import type { BoardEvent, InboxNotification, PrSnapshot, T3ThreadSnapshot } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";

const pr = (overrides: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "open",
  title: "Change",
  checks: "passing",
  reviewDecision: null,
  mergeable: "mergeable",
  headRef: "feat/x",
  updatedAt: "2026-10-01T10:00:00Z",
  headOid: "aaa",
  ...overrides,
});

const thread = (overrides: Partial<T3ThreadSnapshot> = {}): T3ThreadSnapshot => ({
  title: "Fix the build",
  status: "working",
  lastActivityAt: "2026-10-01T10:00:00Z",
  ...overrides,
});

function setup(now: () => Date = () => new Date("2026-10-01T12:00:00")) {
  const h = createTestHarness({ integrations: { now } });
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const task = s.tasks.create({
    projectId: project.id,
    title: "Ship it",
    plan: { phases: [{ title: "Build", steps: [{ title: "a" }] }] },
    links: [
      { value: "https://github.com/acme/app/pull/7" },
      { t3Thread: { environmentId: "env", threadId: "thread-1" } },
    ],
  });
  const prLink = s.links.listByKind("pr").find((l) => l.taskId === task.id)!;
  const threadLink = s.links.listByKind("t3_thread").find((l) => l.taskId === task.id)!;
  const created = () =>
    h.events.filter(
      (e): e is Extract<BoardEvent, { type: "notification.created" }> => e.type === "notification.created",
    );
  const inbox = () => s.notifications.list().items;
  return { ...h, s, project, task, prLink, threadLink, created, inbox };
}

describe("notify", () => {
  it("records one notification per dedupe key and tells open browsers", () => {
    const { s, task, created, inbox } = setup();
    const input = {
      kind: "autopilot_notice",
      taskId: task.id,
      title: "Stale",
      body: "#1 Ship it",
      dedupeKey: "k",
    } as const;
    expect(s.notifications.notify(input)).toMatchObject({ title: "Stale", readAt: null });
    expect(s.notifications.notify({ ...input, title: "Again" })).toBeNull();
    expect(inbox()).toHaveLength(1);
    expect(created()).toHaveLength(1);
    expect(created()[0]).toMatchObject({ unread: 1, popup: true });
  });

  it("drops a kind that is switched off, keeping the others", () => {
    const { s, prLink, inbox } = setup();
    s.settings.update({ notifications: { kinds: { pr_checks_failing: false } } });
    s.links.setSnapshot(prLink.id, pr());
    s.links.setSnapshot(prLink.id, pr({ checks: "failing", headOid: "bbb" }));
    s.links.setSnapshot(prLink.id, pr({ checks: "failing", headOid: "bbb", reviewDecision: "changes_requested" }));
    expect(inbox().map((n) => n.kind)).toEqual(["pr_changes_requested"]);
    expect(s.settings.get().notifications.kinds).toMatchObject({ pr_checks_failing: false, thread_waiting: true });
  });

  it("sends no popup during quiet hours, but still records it", () => {
    const { s, created, inbox } = setup(() => new Date("2026-10-01T23:30:00"));
    s.autopilot.updateEngine({ quietHours: { enabled: true, start: "22:00", end: "07:00" } });
    s.notifications.notify({ kind: "autopilot_notice", title: "Digest", body: "", dedupeKey: "d1" });
    expect(inbox()).toHaveLength(1);
    expect(created()[0]).toMatchObject({ popup: false });

    s.settings.update({ notifications: { muteInQuietHours: false } });
    s.notifications.notify({ kind: "autopilot_notice", title: "Digest 2", body: "", dedupeKey: "d2" });
    expect(created()[1]).toMatchObject({ popup: true });
  });

  it("reads one or all, and counts unread across the whole inbox", () => {
    const { s, events } = setup();
    const make = (key: string) =>
      s.notifications.notify({ kind: "autopilot_notice", title: key, body: "", dedupeKey: key })!;
    const a = make("a");
    make("b");
    make("c");
    expect(s.notifications.list({ limit: 1 })).toMatchObject({ unread: 3, items: [{ title: "c" }] });

    events.length = 0;
    expect(s.notifications.markRead(a.id).readAt).not.toBeNull();
    expect(events).toEqual([{ type: "notifications.changed", unread: 2 }]);
    // Reading again changes nothing, so nothing is published.
    events.length = 0;
    s.notifications.markRead(a.id);
    expect(events).toEqual([]);

    expect(s.notifications.markAllRead()).toBe(2);
    expect(s.notifications.list().unread).toBe(0);
    expect(s.notifications.list({ kind: "review_finished" }).items).toEqual([]);
  });

  it("reads only one task's unread notifications when its panel opens", async () => {
    const { s, events, task, request } = setup();
    const note = (key: string, taskId?: string) =>
      s.notifications.notify({
        kind: "autopilot_notice",
        ...(taskId ? { taskId } : {}),
        title: key,
        body: "",
        dedupeKey: key,
      })!;
    note("a", task.id);
    note("b", task.id);
    note("digest");
    events.length = 0;

    expect(s.notifications.markTaskRead(task.id)).toBe(2);
    expect(events).toEqual([{ type: "notifications.changed", unread: 1 }]);
    // Board-wide notifications stay; reading again changes nothing, so nothing is published.
    events.length = 0;
    expect(s.notifications.markTaskRead(task.id)).toBe(0);
    expect(events).toEqual([]);

    note("c", task.id);
    const res = await request("/api/notifications/read", { method: "POST", body: JSON.stringify({ taskId: task.id }) });
    expect(((await res.json()) as { unread: number }).unread).toBe(1);
    expect((await request("/api/notifications/read", { method: "POST", body: "{}" })).status).toBe(400);
  });

  it("prunes after 30 days", () => {
    let now = new Date("2026-10-01T12:00:00");
    const { s } = setup(() => now);
    s.notifications.notify({ kind: "autopilot_notice", title: "old", body: "", dedupeKey: "old" });
    now = new Date("2026-10-20T12:00:00");
    expect(s.notifications.list().items).toHaveLength(1);
    now = new Date("2026-11-05T12:00:00");
    // Hidden at once; the row itself goes with the next notification.
    expect(s.notifications.list()).toEqual({ items: [], unread: 0 });
    s.notifications.notify({ kind: "autopilot_notice", title: "new", body: "", dedupeKey: "new" });
    expect(s.notifications.list().items.map((n) => n.title)).toEqual(["new"]);
    // The old key is free again.
    expect(
      s.notifications.notify({ kind: "autopilot_notice", title: "old", body: "", dedupeKey: "old" }),
    ).not.toBeNull();
  });

  it("leaves with its task", () => {
    const { s, task, events } = setup();
    s.notifications.notify({ kind: "autopilot_notice", taskId: task.id, title: "x", body: "", dedupeKey: "x" });
    s.tasks.update(task.id, { archived: true }, "user");
    events.length = 0;
    s.tasks.delete(task.id, "user");
    expect(s.notifications.list().items).toEqual([]);
    expect(events).toContainEqual({ type: "notifications.changed", unread: 0 });
  });
});

describe("producers", () => {
  it("notifies when a thread starts waiting, once per wait", () => {
    const { s, task, threadLink, inbox } = setup();
    // The first snapshot is whatever state the thread was linked in.
    s.links.setSnapshot(threadLink.id, thread({ status: "input" }));
    expect(inbox()).toEqual([]);

    s.links.setSnapshot(threadLink.id, thread({ status: "working", lastActivityAt: "2026-10-01T10:05:00Z" }));
    s.links.setSnapshot(threadLink.id, thread({ status: "input", lastActivityAt: "2026-10-01T10:06:00Z" }));
    // A later poll of the same wait says nothing more.
    s.links.setSnapshot(threadLink.id, thread({ status: "input", lastActivityAt: "2026-10-01T10:06:00Z", model: "m" }));
    expect(inbox()).toHaveLength(1);
    expect(inbox()[0]).toMatchObject({
      kind: "thread_waiting",
      taskId: task.id,
      title: "Thread waiting for input",
      body: `#${task.number} Ship it\nFix the build`,
    });

    s.links.setSnapshot(threadLink.id, thread({ status: "approval", lastActivityAt: "2026-10-01T10:07:00Z" }));
    expect(inbox().map((n) => n.title)).toEqual(["Thread waiting for approval", "Thread waiting for input"]);
  });

  it("notifies again when a thread asks twice between two polls", () => {
    const { s, threadLink, inbox } = setup();
    s.links.setSnapshot(threadLink.id, thread({ status: "working" }));
    s.links.setSnapshot(threadLink.id, thread({ status: "input", lastActivityAt: "2026-10-01T10:06:00Z" }));
    // It was answered and asked again before the next poll: still input, but newer.
    s.links.setSnapshot(threadLink.id, thread({ status: "input", lastActivityAt: "2026-10-01T10:09:00Z" }));
    expect(inbox()).toHaveLength(2);
  });

  it("notifies when checks start failing, and again for a new head that fails", () => {
    const { s, prLink, inbox } = setup();
    s.links.setSnapshot(prLink.id, pr());
    s.links.setSnapshot(prLink.id, pr({ checks: "pending", headOid: "bbb" }));
    s.links.setSnapshot(prLink.id, pr({ checks: "failing", headOid: "bbb" }));
    s.links.setSnapshot(prLink.id, pr({ checks: "failing", headOid: "bbb", mergeable: "conflicting" }));
    expect(inbox().map((n) => [n.kind, n.title])).toEqual([["pr_checks_failing", "Checks failing on PR #7"]]);

    s.links.setSnapshot(prLink.id, pr({ checks: "failing", headOid: "ccc" }));
    expect(inbox()).toHaveLength(2);
  });

  it("notifies when changes are requested, not for a PR that is closed", () => {
    const { s, prLink, inbox } = setup();
    s.links.setSnapshot(prLink.id, pr());
    s.links.setSnapshot(prLink.id, pr({ reviewDecision: "changes_requested", updatedAt: "2026-10-01T11:00:00Z" }));
    expect(inbox().map((n) => n.kind)).toEqual(["pr_changes_requested"]);

    s.links.setSnapshot(prLink.id, pr({ reviewDecision: "approved", updatedAt: "2026-10-01T11:30:00Z" }));
    s.links.setSnapshot(prLink.id, pr({ state: "closed", checks: "failing", headOid: "zzz" }));
    expect(inbox()).toHaveLength(1);
  });

  it("notifies when a review round is submitted, with what it found", () => {
    const { s, task, inbox } = setup();
    s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" });
    s.reviews.submit(
      task.id,
      {
        findings: [
          { severity: "major", title: "a" },
          { severity: "major", title: "b" },
          { severity: "nit", title: "c" },
        ],
      },
      "reviewer",
    );
    expect(inbox()[0]).toMatchObject({
      kind: "review_finished",
      title: "Review round 1 finished",
      body: `#${task.number} Ship it\n2 major, 1 nit`,
    });

    s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" });
    s.reviews.submit(task.id, { findings: [] }, "reviewer");
    expect(inbox()[0]!.body).toContain("No findings");
  });

  it("notifies when an Autopilot run fails or asks for the user, not for a dry run", () => {
    const { s, task, inbox } = setup();
    const run = (key: string, dryRun = false) => {
      const queued = s.autopilot.record({
        automation: "start_planned",
        candidate: { dedupeKey: key, summary: "start it", taskId: task.id },
        dryRun,
      });
      return queued && !dryRun ? s.autopilot.start(queued.id) : queued;
    };
    s.autopilot.finish(run("ok")!.id, {});
    expect(inbox()).toEqual([]);

    s.autopilot.finish(run("bad")!.id, { status: "failed", error: "No runner", needsAttention: true });
    s.autopilot.finish(run("gave-up")!.id, {
      status: "skipped",
      summary: "Gave up after 3 tries",
      needsAttention: true,
    });
    run("dry", true);
    expect(inbox().map((n: InboxNotification) => [n.kind, n.body])).toEqual([
      ["autopilot_failed", `#${task.number} Ship it\nGave up after 3 tries`],
      ["autopilot_failed", `#${task.number} Ship it\nNo runner`],
    ]);
    expect(inbox()[0]!.title).toMatch(/needs you$/);
    expect(inbox()[1]!.title).toMatch(/failed$/);
  });
});

describe("REST", () => {
  it("lists, reads one and reads all", async () => {
    const { s, request } = setup();
    const id = s.notifications.notify({ kind: "autopilot_notice", title: "A", body: "", dedupeKey: "a" })!.id;
    s.notifications.notify({ kind: "review_finished", title: "B", body: "", dedupeKey: "b" });

    const all = (await (await request("/api/notifications")).json()) as { items: InboxNotification[]; unread: number };
    expect(all.unread).toBe(2);
    expect(all.items.map((n) => n.title)).toEqual(["B", "A"]);
    const filtered = (await (await request("/api/notifications?kind=review_finished")).json()) as typeof all;
    expect(filtered.items.map((n) => n.title)).toEqual(["B"]);
    expect(filtered.unread).toBe(2);

    expect((await request("/api/notifications?kind=nope")).status).toBe(400);
    expect((await request("/api/notifications/missing/read", { method: "POST" })).status).toBe(404);
    const read = await request(`/api/notifications/${id}/read`, { method: "POST" });
    expect(((await read.json()) as InboxNotification).readAt).not.toBeNull();

    const cleared = (await (await request("/api/notifications/read-all", { method: "POST" })).json()) as typeof all;
    expect(cleared.unread).toBe(0);
    expect(cleared.items).toHaveLength(2);
  });

  it("updates the settings through PATCH /api/settings", async () => {
    const { request } = setup();
    const res = await request("/api/settings", {
      method: "PATCH",
      json: { notifications: { kinds: { review_finished: false }, muteInQuietHours: false } },
    });
    expect(((await res.json()) as { notifications: unknown }).notifications).toMatchObject({
      muteInQuietHours: false,
      kinds: { review_finished: false, thread_waiting: true },
    });
  });
});
