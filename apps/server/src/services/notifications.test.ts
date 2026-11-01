import type { BoardEvent, InboxNotification, PrSnapshot, T3ThreadSnapshot } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { createRepos } from "../db/repos/index.ts";
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
  // Autopilot updates are off by default; most of these tests use them as a plain kind.
  s.settings.update({ notifications: { kinds: { autopilot_notice: true } } });
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
    s.tasks.update(task.id, { archived: true }, "user");
    s.notifications.notify({ kind: "autopilot_notice", taskId: task.id, title: "x", body: "", dedupeKey: "x" });
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
      body: `Fix the build\n#${task.number} Ship it`,
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

  it("notifies once for a thread shared by several tasks, naming each, and clears it for all", () => {
    const { s, project, task, threadLink, inbox } = setup();
    const others = ["Second", "Third"].map((title) =>
      s.tasks.create({
        projectId: project.id,
        title,
        links: [{ t3Thread: { environmentId: "env", threadId: "thread-1" } }],
      }),
    );
    const links = s.links
      .listByKind("t3_thread")
      .filter((l) => l.kind === "t3_thread" && l.ref.threadId === "thread-1");
    expect(links).toHaveLength(3);
    for (const l of links) s.links.setSnapshot(l.id, thread({ status: "working" }));
    // Each task's link is polled and moves to input, but it is one question.
    for (const l of links)
      s.links.setSnapshot(l.id, thread({ status: "input", lastActivityAt: "2026-10-01T10:06:00Z" }));
    expect(inbox()).toHaveLength(1);
    expect(inbox()[0]).toMatchObject({ taskId: task.id });
    const body = inbox()[0]!.body;
    for (const t of [task, ...others]) expect(body).toContain(`#${t.number} ${t.title}`);

    // Opening any of the tasks has seen it.
    expect(s.notifications.markTaskRead(others[1]!.id)).toBe(1);
    expect(inbox()[0]!.readAt).not.toBeNull();

    // Asked again after activity: a second notification, still one.
    for (const l of links)
      s.links.setSnapshot(l.id, thread({ status: "working", lastActivityAt: "2026-10-01T10:08:00Z" }));
    for (const l of links)
      s.links.setSnapshot(l.id, thread({ status: "input", lastActivityAt: "2026-10-01T10:09:00Z" }));
    expect(inbox()).toHaveLength(2);
    expect(inbox().filter((n) => n.readAt === null)).toHaveLength(1);
    // One link moving on clears it, though the threads of the others have not been polled yet.
    s.links.setSnapshot(threadLink.id, thread({ status: "working", lastActivityAt: "2026-10-01T10:10:00Z" }));
    expect(inbox().filter((n) => n.readAt === null)).toHaveLength(0);
  });

  describe("a thread shared with finished tasks", () => {
    const sharedThread = () => {
      const ctx = setup();
      const { s, project } = ctx;
      const others = ["Second", "Third"].map((title) =>
        s.tasks.create({
          projectId: project.id,
          title,
          plan: { phases: [{ title: "Build", steps: [{ title: "a" }] }] },
          links: [{ t3Thread: { environmentId: "env", threadId: "thread-1" } }],
        }),
      );
      const links = s.links
        .listByKind("t3_thread")
        .filter((l) => l.kind === "t3_thread" && l.ref.threadId === "thread-1");
      for (const l of links) s.links.setSnapshot(l.id, thread({ status: "working" }));
      return { ...ctx, others, links };
    };
    const ask = (ctx: ReturnType<typeof sharedThread>) => {
      for (const l of ctx.links)
        ctx.s.links.setSnapshot(l.id, thread({ status: "input", lastActivityAt: "2026-10-01T10:06:00Z" }));
    };

    it("files the notification under a task that is still open, and names only those", () => {
      const ctx = sharedThread();
      ctx.s.tasks.move(ctx.task.id, { status: "done" }, "user");
      ask(ctx);
      expect(ctx.inbox()).toHaveLength(1);
      expect(ctx.inbox()[0]).toMatchObject({ taskId: ctx.others[0]!.id });
      expect(ctx.inbox()[0]!.body).not.toContain(ctx.task.title);
      expect(ctx.inbox()[0]!.body).toContain(ctx.others[1]!.title);
    });

    it("keeps it unread, under another open task, when its task finishes while the thread still waits", () => {
      const ctx = sharedThread();
      ask(ctx);
      expect(ctx.inbox()[0]).toMatchObject({ taskId: ctx.task.id, readAt: null });
      ctx.s.tasks.move(ctx.task.id, { status: "done" }, "user");
      expect(ctx.inbox()[0]).toMatchObject({ taskId: ctx.others[0]!.id, readAt: null });
      // Once the last open task finishes, nothing is left to ask about.
      ctx.s.tasks.move(ctx.others[0]!.id, { status: "done" }, "user");
      ctx.s.tasks.move(ctx.others[1]!.id, { status: "done" }, "user");
      expect(ctx.inbox()[0]!.readAt).not.toBeNull();
    });
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
    // Only the newest head's failure stands; the older head's is read.
    expect(inbox().map((n) => n.readAt !== null)).toEqual([false, true]);
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

  it("tells the user about a review only when its loop ends without a clean result", () => {
    const { s, task, inbox } = setup();
    // A round that asks the agent to fix things, with rounds left, is the agent's business.
    s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" });
    s.reviews.submit(task.id, { findings: [{ severity: "major", title: "a" }] }, "reviewer");
    s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" });
    s.reviews.submit(task.id, { findings: [] }, "reviewer");
    expect(inbox()).toEqual([]);

    // Round 1's finding was never resolved, so two are open after the last round: Stuck.
    s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" });
    s.reviews.submit(task.id, { findings: [{ severity: "major", title: "b" }] }, "reviewer");
    expect(inbox()[0]).toMatchObject({
      kind: "review_finished",
      title: "Review stuck on round 3",
      body: `#${task.number} Ship it\n2 blocking or major still open after 3 rounds`,
    });
  });

  it("tells the user when a round fails or finds no reviewer", () => {
    const { s, task, inbox } = setup();
    const failed = s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" });
    s.reviews.setRoundStatus(failed.id, "failed", { actor: "board", error: "boom" });
    expect(inbox().map((n) => n.title)).toEqual(["Review failed on round 1"]);
    s.reviews.submit(task.id, { findings: [] }, "reviewer");

    const stalled = s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" });
    s.reviews.setRoundStatus(stalled.id, "stalled", { actor: "board", error: "nobody" });
    expect(inbox().map((n) => n.title)).toEqual(["Round 2 needs a reviewer", "Review failed on round 1"]);
  });

  it("keeps a stalled round's notice from hiding a later Stuck one, and reads the stale one", () => {
    const { s, task, inbox } = setup();
    for (let i = 0; i < 2; i++) {
      s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" });
      s.reviews.submit(task.id, { findings: [{ severity: "major", title: `f${i}` }] }, "reviewer");
    }
    const third = s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" });
    s.reviews.setRoundStatus(third.id, "stalled", { actor: "board", error: "nobody" });
    expect(inbox().map((n) => [n.title, n.readAt === null])).toEqual([["Round 3 needs a reviewer", true]]);

    // An agent still submits the stalled round, and it ends Stuck: the old notice is stale.
    s.reviews.submit(task.id, { findings: [{ severity: "major", title: "f3" }] }, "reviewer");
    expect(inbox().map((n) => [n.title, n.readAt === null])).toEqual([
      ["Review stuck on round 3", true],
      ["Round 3 needs a reviewer", false],
    ]);

    // A new cycle clears it.
    s.reviews.openRound(task.id, { trigger: "move", actor: "board" });
    expect(inbox().every((n) => n.readAt !== null)).toBe(true);
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

describe("clearing what is resolved", () => {
  const unread = (inbox: () => InboxNotification[]) =>
    inbox()
      .filter((n) => n.readAt === null)
      .map((n) => n.kind);

  it("reads a thread notification once the thread leaves input or approval", () => {
    const { s, threadLink, inbox, events } = setup();
    s.links.setSnapshot(threadLink.id, thread());
    s.links.setSnapshot(threadLink.id, thread({ status: "input", lastActivityAt: "2026-10-01T11:00:00Z" }));
    expect(unread(inbox)).toEqual(["thread_waiting"]);
    // Still waiting, so still unread.
    s.links.setSnapshot(threadLink.id, thread({ status: "input", lastActivityAt: "2026-10-01T11:00:00Z", title: "x" }));
    expect(unread(inbox)).toEqual(["thread_waiting"]);

    events.length = 0;
    s.links.setSnapshot(threadLink.id, thread({ status: "working", lastActivityAt: "2026-10-01T11:05:00Z" }));
    expect(unread(inbox)).toEqual([]);
    expect(events).toContainEqual({ type: "notifications.changed", unread: 0 });
  });

  it("reads checks and changes notifications when they are resolved", () => {
    const { s, prLink, inbox } = setup();
    s.links.setSnapshot(prLink.id, pr());
    s.links.setSnapshot(
      prLink.id,
      pr({ checks: "failing", headOid: "bbb", reviewDecision: "changes_requested", updatedAt: "2026-10-01T11:00:00Z" }),
    );
    expect(unread(inbox).sort()).toEqual(["pr_changes_requested", "pr_checks_failing"]);

    // Checks pass on a later head.
    s.links.setSnapshot(
      prLink.id,
      pr({ checks: "passing", headOid: "ccc", reviewDecision: "changes_requested", updatedAt: "2026-10-01T11:10:00Z" }),
    );
    expect(unread(inbox)).toEqual(["pr_changes_requested"]);

    // The decision changes.
    s.links.setSnapshot(
      prLink.id,
      pr({ headOid: "ccc", reviewDecision: "approved", updatedAt: "2026-10-01T11:20:00Z" }),
    );
    expect(unread(inbox)).toEqual([]);
  });

  it("reads both when the PR is merged or closed", () => {
    const { s, prLink, inbox } = setup();
    s.links.setSnapshot(prLink.id, pr());
    s.links.setSnapshot(
      prLink.id,
      pr({ checks: "failing", headOid: "bbb", reviewDecision: "changes_requested", updatedAt: "2026-10-01T11:00:00Z" }),
    );
    expect(unread(inbox)).toHaveLength(2);
    s.links.setSnapshot(prLink.id, pr({ state: "closed", checks: "failing", headOid: "bbb" }));
    expect(unread(inbox)).toEqual([]);
  });

  it("notifies again when the same state returns after it was resolved", () => {
    const { s, prLink, task, inbox } = setup();
    s.links.setSnapshot(prLink.id, pr());
    // A CI re-run on the same head: failing, pending, failing again.
    s.links.setSnapshot(prLink.id, pr({ checks: "failing", headOid: "bbb" }));
    s.links.setSnapshot(prLink.id, pr({ checks: "pending", headOid: "bbb" }));
    s.links.setSnapshot(prLink.id, pr({ checks: "failing", headOid: "bbb" }));
    expect(inbox().map((n) => n.readAt === null)).toEqual([true, false]);

    // Also when the user had read the first one by then (opening the task's panel does).
    s.notifications.markTaskRead(task.id);
    s.links.setSnapshot(prLink.id, pr({ checks: "pending", headOid: "bbb" }));
    s.links.setSnapshot(prLink.id, pr({ checks: "failing", headOid: "bbb" }));
    expect(inbox().filter((n) => n.readAt === null)).toHaveLength(1);

    // A failed round that is reopened and fails again.
    const round = s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" });
    s.reviews.setRoundStatus(round.id, "failed", { actor: "board", error: "boom" });
    s.reviews.setRoundStatus(round.id, "pending", { actor: "board" });
    s.reviews.setRoundStatus(round.id, "failed", { actor: "board", error: "boom again" });
    expect(inbox().filter((n) => n.kind === "review_finished" && n.readAt === null)).toHaveLength(1);
  });

  it("reads an agent request when it is cleared", () => {
    const { s, task, inbox } = setup();
    s.attention.request(task.id, "Look", "claude-code");
    expect(unread(inbox)).toEqual(["agent_request"]);
    s.attention.clear(task.id, "user");
    expect(unread(inbox)).toEqual([]);
  });

  it("reads all of a task's notifications when it is Done or archived, but not other tasks'", () => {
    const { s, task, project, inbox, events } = setup();
    const other = s.tasks.create({
      projectId: project.id,
      title: "Other",
      plan: { phases: [{ title: "Build", steps: [{ title: "a" }] }] },
    });
    const note = (taskId: string, key: string) =>
      s.notifications.notify({ kind: "autopilot_notice", taskId, title: key, body: "", dedupeKey: key });
    note(task.id, "a");
    note(task.id, "b");
    note(other.id, "c");
    events.length = 0;

    s.tasks.move(task.id, { status: "done" }, "user");
    expect(
      inbox()
        .filter((n) => n.readAt === null)
        .map((n) => n.title),
    ).toEqual(["c"]);
    expect(events).toContainEqual({ type: "notifications.changed", unread: 1 });

    note(other.id, "d");
    s.tasks.update(other.id, { archived: true }, "user");
    expect(unread(inbox)).toEqual([]);

    // Closing it counts too.
    const closing = s.tasks.create({
      projectId: project.id,
      title: "Closing",
      plan: { phases: [{ title: "Build", steps: [{ title: "a" }] }] },
    });
    note(closing.id, "f");
    s.tasks.close(closing.id, { resolution: "wont_do" }, "user");
    expect(inbox().find((n) => n.title === "f")!.readAt).not.toBeNull();

    // Later touches of a finished task don't quietly read what arrived since.
    note(task.id, "e");
    s.tasks.update(task.id, { title: "Ship it, renamed" }, "user");
    expect(
      inbox()
        .filter((n) => n.readAt === null)
        .map((n) => n.title),
    ).toEqual(["e"]);
  });
});

describe("what the inbox lists", () => {
  it("drops notifications 7 days after they were read, and keeps unread ones until they are pruned", () => {
    let now = new Date("2026-10-01T12:00:00");
    const { s } = setup(() => now);
    const make = (key: string) =>
      s.notifications.notify({ kind: "autopilot_notice", title: key, body: "", dedupeKey: key })!;
    const old = make("old");
    make("unread");

    // Left unread for nine days, then read: it still shows, dimmed, for 7 days from the read.
    now = new Date("2026-10-10T12:00:00");
    s.notifications.markRead(old.id);
    now = new Date("2026-10-16T12:00:00");
    expect(s.notifications.list().items.map((n) => n.title)).toEqual(["unread", "old"]);
    now = new Date("2026-10-18T12:00:00");
    expect(s.notifications.list()).toMatchObject({ items: [{ title: "unread" }], unread: 1 });
  });
});

describe("defaults", () => {
  it("turns Autopilot updates off and the rest on, until the user says otherwise", () => {
    const h = setup();
    const s = h.s;
    const fresh = createTestHarness().services.settings.get().notifications.kinds;
    expect(fresh).toMatchObject({ autopilot_notice: false, autopilot_failed: true, review_finished: true });
    expect(Object.values({ ...fresh, autopilot_notice: true }).every(Boolean)).toBe(true);

    // Saving one switch stores only that one, so the other kinds keep following the defaults.
    s.settings.update({ notifications: { kinds: { suggestion: false } } });
    expect(createRepos(h.db).settings.all().get("notifications")).toEqual({
      muteInQuietHours: true,
      kinds: { autopilot_notice: true, suggestion: false },
    });
    expect(s.settings.get().notifications.kinds).toMatchObject({
      suggestion: false,
      autopilot_notice: true,
      thread_waiting: true,
    });
  });

  it("keeps a full record saved before the defaults changed", () => {
    const h = createTestHarness();
    createRepos(h.db).settings.set("notifications", {
      muteInQuietHours: false,
      kinds: Object.fromEntries(Object.keys(h.services.settings.get().notifications.kinds).map((k) => [k, true])),
    });
    expect(h.services.settings.get().notifications).toMatchObject({
      muteInQuietHours: false,
      kinds: { autopilot_notice: true, thread_waiting: true },
    });
  });

  it("keeps a switch the user saved", () => {
    const h = createTestHarness();
    h.services.settings.update({ notifications: { kinds: { autopilot_notice: true } } });
    h.services.settings.update({ notifications: { muteInQuietHours: false } });
    expect(h.services.settings.get().notifications.kinds.autopilot_notice).toBe(true);
  });
});
