import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOPILOT_ALL_RUNS,
  type AutopilotRun,
  type AutopilotRunPage,
  type DeleteAutopilotRunsResult,
} from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { createRepos } from "../db/repos/index.ts";
import { createTestHarness } from "../test/harness.ts";

const DAY = 24 * 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function setup() {
  const h = createTestHarness();
  const alpha = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const beta = h.services.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
  const repo = createRepos(h.db).autopilotRuns;
  let n = 0;
  const insert = (over: Partial<AutopilotRun> = {}): AutopilotRun => {
    n += 1;
    const createdAt = over.createdAt ?? ago(10 * DAY);
    const run: AutopilotRun = {
      id: `run-${String(n).padStart(3, "0")}`,
      automation: "orchestrate",
      taskId: null,
      projectId: alpha.id,
      dedupeKey: `k${n}`,
      status: "succeeded",
      summary: `summary ${n}`,
      dryRun: false,
      runner: null,
      sessionId: null,
      threadUrl: null,
      worktreePath: null,
      costUsd: null,
      detail: null,
      exitCode: null,
      error: null,
      needsAttention: false,
      dismissedAt: null,
      output: null,
      createdAt,
      startedAt: createdAt,
      finishedAt: createdAt,
      updatedAt: createdAt,
      ...over,
    };
    repo.insert(run);
    return run;
  };
  const history = async (query: string) => h.request(`/api/autopilot/runs/history?${query}`);
  const page = async (query: string) => (await (await history(query)).json()) as AutopilotRunPage;
  const ids = async (query: string) => (await page(query)).runs.map((r) => r.id);
  const del = async (json: unknown) =>
    (await (
      await h.request("/api/autopilot/runs/delete", { method: "POST", json })
    ).json()) as DeleteAutopilotRunsResult;
  const count = () => (h.db.prepare("SELECT count(*) AS n FROM autopilot_runs").get() as { n: number }).n;
  return { h, alpha, beta, insert, history, page, ids, del, count };
}

describe("GET /api/autopilot/runs/history", () => {
  it("pages newest first by (created_at, id), and new runs don't shift the pages", async () => {
    const { insert, page } = setup();
    // Two runs share a millisecond: the id breaks the tie.
    const same = ago(5 * DAY);
    insert({ createdAt: ago(9 * DAY) });
    insert({ createdAt: same });
    insert({ createdAt: same });
    insert({ createdAt: ago(3 * DAY) });
    insert({ createdAt: ago(1 * DAY) });

    const first = await page("automation=orchestrate&limit=2");
    expect(first.runs.map((r) => r.id)).toEqual(["run-005", "run-004"]);
    expect(first.nextCursor).not.toBeNull();

    // A newer run arrives while the user is on the first page.
    insert({ createdAt: ago(1000) });

    const second = await page(`automation=orchestrate&limit=2&cursor=${first.nextCursor}`);
    expect(second.runs.map((r) => r.id)).toEqual(["run-003", "run-002"]);
    const third = await page(`automation=orchestrate&limit=2&cursor=${second.nextCursor}`);
    expect(third.runs.map((r) => r.id)).toEqual(["run-001"]);
    expect(third.nextCursor).toBeNull();
  });

  it("has no next cursor when the page is exactly the rest", async () => {
    const { insert, page } = setup();
    insert();
    insert();
    expect((await page("automation=orchestrate&limit=2")).nextCursor).toBeNull();
  });

  it("filters by automation, with 'all' listing every automation", async () => {
    const { insert, ids } = setup();
    insert({ automation: "orchestrate" });
    insert({ automation: "custom:abc" });
    insert({ automation: "review_prs" });
    expect(await ids("automation=custom:abc")).toEqual(["run-002"]);
    expect(await ids(`automation=${AUTOPILOT_ALL_RUNS}`)).toEqual(["run-003", "run-002", "run-001"]);
    expect(await ids("automation=nothing")).toEqual([]);
  });

  it("filters by project", async () => {
    const { insert, ids, beta } = setup();
    insert();
    insert({ projectId: beta.id });
    insert({ projectId: null });
    expect(await ids(`automation=all&projectId=${beta.id}`)).toEqual(["run-002"]);
  });

  it("filters by time: since is inclusive, until is exclusive", async () => {
    const { insert, ids } = setup();
    insert({ createdAt: "2026-03-01T00:00:00.000Z" });
    insert({ createdAt: "2026-03-02T00:00:00.000Z" });
    insert({ createdAt: "2026-03-03T00:00:00.000Z" });
    const since = encodeURIComponent("2026-03-02T00:00:00.000Z");
    const until = encodeURIComponent("2026-03-03T00:00:00.000Z");
    expect(await ids(`automation=all&since=${since}`)).toEqual(["run-003", "run-002"]);
    expect(await ids(`automation=all&until=${until}`)).toEqual(["run-002", "run-001"]);
    expect(await ids(`automation=all&since=${since}&until=${until}`)).toEqual(["run-002"]);
    // A zone offset is the same instant.
    expect(
      await ids(`automation=all&since=${encodeURIComponent("2026-03-02T02:00:00.000+02:00")}&until=${until}`),
    ).toEqual(["run-002"]);
  });

  it("searches the id, the project's title, #N, and the summary and handover text", async () => {
    const { h, insert, ids, beta } = setup();
    const task = h.services.tasks.create({ projectId: beta.id, title: "T" });
    insert({ summary: "restarted the flaky job" });
    insert({ output: { kind: "scheduled_agent", summary: "triaged", handover: "waiting on the DEPLOY window" } });
    insert({ projectId: beta.id });
    insert({ taskId: task.id, projectId: beta.id });
    expect(await ids("automation=all&q=flaky")).toEqual(["run-001"]);
    expect(await ids("automation=all&q=deploy")).toEqual(["run-002"]);
    expect(await ids("automation=all&q=triaged")).toEqual(["run-002"]);
    expect(await ids("automation=all&q=beta")).toEqual(["run-004", "run-003"]);
    expect(await ids("automation=all&q=run-003")).toEqual(["run-003"]);
    expect(await ids(`automation=all&q=${encodeURIComponent(`#${task.number}`)}`)).toEqual(["run-004"]);
  });

  it("treats % and _ in the search as text", async () => {
    const { insert, ids } = setup();
    insert({ summary: "100% done" });
    insert({ summary: "1000 done" });
    insert({ summary: "a_b" });
    insert({ summary: "axb" });
    expect(await ids("automation=all&q=100%25")).toEqual(["run-001"]);
    expect(await ids("automation=all&q=a_b")).toEqual(["run-003"]);
  });

  it("combines filters", async () => {
    const { insert, ids, beta } = setup();
    insert({ summary: "restarted", createdAt: "2026-03-01T00:00:00.000Z" });
    insert({ summary: "restarted", createdAt: "2026-03-05T00:00:00.000Z" });
    insert({ summary: "restarted", createdAt: "2026-03-05T00:00:00.000Z", projectId: beta.id });
    insert({ summary: "other", createdAt: "2026-03-05T00:00:00.000Z" });
    const since = encodeURIComponent("2026-03-02T00:00:00.000Z");
    expect(await ids(`automation=orchestrate&projectId=${beta.id}&since=${since}&q=restarted`)).toEqual(["run-003"]);
    expect(await ids(`automation=orchestrate&since=${since}&q=restarted`)).toEqual(["run-003", "run-002"]);
  });

  it("answers 400 to bad dates, cursors, limits and a missing automation", async () => {
    const { insert, history } = setup();
    insert();
    expect((await history("automation=all&since=yesterday")).status).toBe(400);
    expect((await history("automation=all&until=2026-03-01")).status).toBe(400);
    expect((await history("automation=all&cursor=not-a-cursor")).status).toBe(400);
    expect((await history(`automation=all&cursor=${Buffer.from("[1,2]").toString("base64url")}`)).status).toBe(400);
    expect((await history("automation=all&limit=0")).status).toBe(400);
    expect((await history("automation=all&limit=101")).status).toBe(400);
    expect((await history("limit=5")).status).toBe(400);
  });
});

describe("POST /api/autopilot/runs/delete", () => {
  it("deletes the runs asked for by id and publishes autopilot.changed", async () => {
    const { h, insert, del, count } = setup();
    insert();
    insert();
    insert();
    h.events.length = 0;
    const result = await del({ ids: ["run-001", "run-003", "missing"] });
    expect(result).toEqual({ preview: false, deleted: 2, kept: 0, keptReasons: [] });
    expect(count()).toBe(1);
    expect(h.events.some((e) => e.type === "autopilot.changed")).toBe(true);
  });

  it("deletes every run matching a filter, and only those", async () => {
    const { insert, del, count, ids } = setup();
    insert({ createdAt: "2026-03-01T00:00:00.000Z" });
    insert({ createdAt: "2026-03-02T00:00:00.000Z" });
    insert({ createdAt: "2026-03-03T00:00:00.000Z" });
    insert({ createdAt: "2026-03-01T00:00:00.000Z", automation: "review_prs" });
    // `until` is exclusive: the run at exactly that time stays.
    const result = await del({ filter: { automation: "orchestrate", until: "2026-03-02T00:00:00.000Z" } });
    expect(result.deleted).toBe(1);
    expect(count()).toBe(3);
    expect(await ids("automation=all")).toEqual(["run-003", "run-002", "run-004"]);
  });

  it("deletes everything of all automations for filter 'all'", async () => {
    const { insert, del, count } = setup();
    insert({ automation: "orchestrate" });
    insert({ automation: "custom:abc" });
    expect((await del({ filter: { automation: AUTOPILOT_ALL_RUNS } })).deleted).toBe(2);
    expect(count()).toBe(0);
  });

  it("a preview counts what would go and deletes nothing", async () => {
    const { h, insert, del, count } = setup();
    insert();
    insert({ status: "running", finishedAt: null });
    h.events.length = 0;
    const result = await del({ filter: { automation: "all" }, preview: true });
    expect(result).toEqual({
      preview: true,
      deleted: 1,
      kept: 1,
      keptReasons: [{ reason: "active", count: 1 }],
    });
    expect(count()).toBe(2);
    expect(h.events).toEqual([]);
  });

  it("keeps runs still queued or running", async () => {
    const { insert, del, count } = setup();
    insert({ status: "queued", finishedAt: null });
    insert({ status: "running", finishedAt: null });
    const result = await del({ filter: { automation: "all" } });
    expect(result).toMatchObject({ deleted: 0, kept: 2, keptReasons: [{ reason: "active", count: 2 }] });
    expect(count()).toBe(2);
  });

  it("keeps a run whose worktree is still on disk, and deletes it once the folder is gone", async () => {
    const { insert, del, count } = setup();
    const dir = mkdtempSync(join(tmpdir(), "aboard-run-worktree-"));
    insert({ runner: "headless", worktreePath: dir });
    insert({ runner: "headless", worktreePath: join(dir, "gone") });
    const result = await del({ filter: { automation: "all" } });
    expect(result).toMatchObject({ deleted: 1, kept: 1, keptReasons: [{ reason: "worktree", count: 1 }] });
    expect(count()).toBe(1);
  });

  it("keeps runs on a task that isn't done, and lets go of them once it is done or archived", async () => {
    const { h, alpha, insert, del, count } = setup();
    const plan = { phases: [{ title: "Do", steps: [{ title: "it" }] }] };
    const open = h.services.tasks.create({ projectId: alpha.id, title: "Open", plan });
    const finished = h.services.tasks.create({ projectId: alpha.id, title: "Finished", plan });
    h.services.tasks.move(finished.id, { status: "done" }, "user");
    insert({ taskId: open.id, automation: "review_prs" });
    insert({ taskId: finished.id, automation: "review_prs" });
    const result = await del({ filter: { automation: "review_prs" } });
    expect(result).toMatchObject({ deleted: 1, kept: 1, keptReasons: [{ reason: "open_task", count: 1 }] });
    expect(count()).toBe(1);
  });

  it("keeps Auto-archive and custom runs on a task, whose keys stop them acting on it again", async () => {
    const { h, alpha, insert, del, count } = setup();
    const plan = { phases: [{ title: "Do", steps: [{ title: "it" }] }] };
    const finished = h.services.tasks.create({ projectId: alpha.id, title: "Finished", plan });
    h.services.tasks.move(finished.id, { status: "done" }, "user");
    insert({ taskId: finished.id, automation: "auto_archive" });
    insert({ taskId: finished.id, automation: "custom:abc" });
    insert({ taskId: finished.id, automation: "review_prs" });
    // A task-less custom run (a schedule slot) is only held by its age.
    insert({ automation: "custom:abc" });
    const result = await del({ filter: { automation: "all" } });
    expect(result).toMatchObject({ deleted: 2, kept: 2, keptReasons: [{ reason: "task_key", count: 2 }] });
    expect(count()).toBe(2);
  });

  it("keeps each scheduled agent's latest successful answer per project", async () => {
    const { insert, del, beta, count } = setup();
    const answer = (at: string, over: Partial<AutopilotRun> = {}) =>
      insert({
        output: { kind: "scheduled_agent", summary: "s", handover: "h" },
        createdAt: at,
        finishedAt: at,
        ...over,
      });
    answer(ago(30 * DAY));
    answer(ago(20 * DAY));
    // The newest run failed and left no answer, so the one before it is still the latest.
    insert({ status: "failed", output: null, createdAt: ago(15 * DAY) });
    // Another project and another automation each keep their own.
    answer(ago(25 * DAY), { projectId: beta.id });
    answer(ago(25 * DAY), { automation: "custom:abc" });
    const result = await del({ filter: { automation: "all" } });
    expect(result).toMatchObject({ deleted: 2, kept: 3, keptReasons: [{ reason: "latest_answer", count: 3 }] });
    expect(count()).toBe(3);
  });

  it("keeps runs less than a day old", async () => {
    const { insert, del, count } = setup();
    insert({ createdAt: ago(2 * 60 * 60_000) });
    insert({ createdAt: ago(2 * DAY) });
    const result = await del({ filter: { automation: "all" } });
    expect(result).toMatchObject({ deleted: 1, kept: 1, keptReasons: [{ reason: "recent", count: 1 }] });
    expect(count()).toBe(1);
  });

  it("applies the same rules to ids as to a filter", async () => {
    const { insert, del, count } = setup();
    insert({ status: "running", finishedAt: null });
    insert();
    const result = await del({ ids: ["run-001", "run-002"] });
    expect(result).toMatchObject({ deleted: 1, kept: 1 });
    expect(count()).toBe(1);
  });

  it("answers 400 unless it gets ids or a filter, and not both", async () => {
    const { h } = setup();
    const post = (json: unknown) => h.request("/api/autopilot/runs/delete", { method: "POST", json });
    expect((await post({})).status).toBe(400);
    expect((await post({ ids: [] })).status).toBe(400);
    expect((await post({ ids: Array.from({ length: 501 }, (_, i) => `r${i}`) })).status).toBe(400);
    expect((await post({ ids: ["a"], filter: { automation: "all" } })).status).toBe(400);
    expect((await post({ filter: { automation: "all", since: "yesterday" } })).status).toBe(400);
    expect((await post({ filter: {} })).status).toBe(400);
  });
});
