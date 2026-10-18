import type {
  AutopilotEngineSettings,
  Digest,
  DigestList,
  AutopilotOverview,
  AutopilotRun,
  AutopilotScopeEntry,
  AutopilotStatus,
  BoardSnapshot,
} from "@repo/contracts";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAutomation } from "../autopilot/types.ts";
import { createTestHarness } from "../test/harness.ts";

const archive = defineAutomation({
  key: "archive",
  title: "Archive",
  description: "Archives old Done tasks.",
  needsAgent: false,
  schema: z.object({ days: z.number().int().min(1) }),
  fields: [{ key: "days", label: "After", kind: "number", min: 1, unit: "days" }],
  defaults: { days: 14 },
  check: () => [],
  act: () => ({}),
});

// Acts on no task in an epic, so an epic can't switch it.
const projectWide = defineAutomation({
  key: "project_wide",
  title: "Project-wide",
  description: "Acts per project.",
  needsAgent: false,
  epicScope: false,
  schema: z.object({}),
  fields: [],
  defaults: {},
  check: () => [],
  act: () => ({}),
});

function setup(opts: { withProjectWide?: boolean } = {}) {
  const automations = opts.withProjectWide ? [archive, projectWide] : [archive];
  const h = createTestHarness({ integrations: { automations } });
  const project = h.services.projects.create({ title: "P", workspaceRoot: "/work/p" });
  return { ...h, project };
}

describe("Autopilot REST routes", () => {
  it("serves the catalogue and engine settings, and validates engine updates", async () => {
    const h = setup();
    const overview = (await (await h.request("/api/autopilot")).json()) as AutopilotOverview;
    expect(overview).toMatchObject({
      paused: false,
      engine: { maxConcurrent: 1, dryRun: false, quietHours: { enabled: false }, prReviewRounds: 3 },
      automations: [{ key: "archive", needsAgent: false, epicScope: true, defaults: { days: 14 } }],
    });

    const res = await h.request("/api/autopilot/engine", {
      method: "PATCH",
      json: { maxConcurrent: 2, quietHours: { enabled: true, start: "21:30" }, prFixThreshold: "minor" },
    });
    expect((await res.json()) as AutopilotEngineSettings).toMatchObject({
      maxConcurrent: 2,
      quietHours: { enabled: true, start: "21:30", end: "07:00" },
      prFixThreshold: "minor",
    });
    for (const json of [{ maxConcurrent: 0 }, { quietHours: { start: "25:00" } }, { prFixThreshold: "huge" }]) {
      expect((await h.request("/api/autopilot/engine", { method: "PATCH", json })).status).toBe(400);
    }
  });

  it("pauses and resumes, publishing autopilot.changed, and the board snapshot carries it", async () => {
    const h = setup();
    const paused = (await (await h.request("/api/autopilot/pause", { method: "POST" })).json()) as AutopilotStatus;
    expect(paused).toEqual({ paused: true, active: [] });
    expect(h.events.at(-1)).toEqual({ type: "autopilot.changed", autopilot: { paused: true, active: [] } });
    expect(((await (await h.request("/api/board")).json()) as BoardSnapshot).autopilot.paused).toBe(true);
    await h.request("/api/autopilot/resume", { method: "POST" });
    expect(h.services.autopilot.status().paused).toBe(false);
  });

  it("sets switches per scope and shows what inherit resolves to", async () => {
    const h = setup();
    const put = (path: string, json: unknown) => h.request(path, { method: "PUT", json });
    expect((await put("/api/autopilot/board/archive", { mode: "on", config: { days: 7 } })).status).toBe(200);

    const lane = (await (await h.request(`/api/autopilot/projects/${h.project.id}`)).json()) as AutopilotScopeEntry[];
    expect(lane).toEqual([
      {
        automation: "archive",
        mode: "inherit",
        config: {},
        enabled: true,
        source: "board",
        effectiveConfig: { days: 7 },
      },
    ]);

    const off = await put(`/api/autopilot/projects/${h.project.id}/archive`, { mode: "off", config: { days: 2 } });
    expect((await off.json()) as AutopilotScopeEntry[]).toMatchObject([
      { mode: "off", enabled: false, source: "project", effectiveConfig: { days: 2 } },
    ]);

    // Back to inherit with no config of its own: the row goes.
    await put(`/api/autopilot/projects/${h.project.id}/archive`, { mode: "inherit", config: {} });
    expect(h.db.prepare("SELECT count(*) AS n FROM autopilot_settings").get()).toEqual({ n: 1 });
  });

  it("rejects unknown automations, scopes, config keys and bad values", async () => {
    const h = setup();
    const put = (path: string, json: unknown) => h.request(path, { method: "PUT", json });
    expect((await put("/api/autopilot/board/nope", { mode: "on" })).status).toBe(404);
    expect((await put("/api/autopilot/projects/missing/archive", { mode: "on" })).status).toBe(404);
    expect((await put("/api/autopilot/board/archive", { mode: "sometimes" })).status).toBe(400);
    expect((await put("/api/autopilot/board/archive", { config: { weeks: 2 } })).status).toBe(400);
    expect((await put("/api/autopilot/board/archive", { config: { days: 0 } })).status).toBe(400);
  });

  it("serves an epic's switches, resolved through its project and the board", async () => {
    const h = setup();
    const epic = h.services.tasks.createEpic({ projectId: h.project.id, title: "E" }, [], "agent");
    const path = `/api/autopilot/projects/${h.project.id}/epics/${epic.id}`;
    await h.request("/api/autopilot/board/archive", { method: "PUT", json: { mode: "on", config: { days: 7 } } });
    await h.request(`/api/autopilot/projects/${h.project.id}/archive`, {
      method: "PUT",
      json: { config: { days: 3 } },
    });

    const inherited = (await (await h.request(path)).json()) as AutopilotScopeEntry[];
    expect(inherited).toEqual([
      {
        automation: "archive",
        mode: "inherit",
        config: {},
        enabled: true,
        source: "board",
        effectiveConfig: { days: 3 },
      },
    ]);

    const off = await h.request(`${path}/archive`, { method: "PUT", json: { mode: "off", config: { days: 1 } } });
    expect((await off.json()) as AutopilotScopeEntry[]).toMatchObject([
      { mode: "off", enabled: false, source: "epic", effectiveConfig: { days: 1 } },
    ]);
    // The project's own entry is untouched.
    const project = (await (
      await h.request(`/api/autopilot/projects/${h.project.id}`)
    ).json()) as AutopilotScopeEntry[];
    expect(project).toMatchObject([{ enabled: true, source: "board", effectiveConfig: { days: 3 } }]);

    await h.request(`${path}/archive`, { method: "PUT", json: { mode: "inherit", config: {} } });
    expect(h.db.prepare("SELECT count(*) AS n FROM autopilot_settings WHERE scope_kind = 'epic'").get()).toEqual({
      n: 0,
    });
  });

  it("describes which automations an epic can switch, leaves the others out of its scope and refuses to set them", async () => {
    const h = setup({ withProjectWide: true });
    const overview = (await (await h.request("/api/autopilot")).json()) as AutopilotOverview;
    expect(overview.automations.map((a) => [a.key, a.epicScope])).toEqual([
      ["archive", true],
      ["project_wide", false],
    ]);

    const epic = h.services.tasks.createEpic({ projectId: h.project.id, title: "E" }, [], "agent");
    const path = `/api/autopilot/projects/${h.project.id}/epics/${epic.id}`;
    const entries = (await (await h.request(path)).json()) as AutopilotScopeEntry[];
    expect(entries.map((e) => e.automation)).toEqual(["archive"]);
    // The board and the project still list both.
    const project = (await (
      await h.request(`/api/autopilot/projects/${h.project.id}`)
    ).json()) as AutopilotScopeEntry[];
    expect(project.map((e) => e.automation)).toEqual(["archive", "project_wide"]);

    const refused = await h.request(`${path}/project_wide`, { method: "PUT", json: { mode: "on" } });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(/doesn't apply to epics/);
    expect((await h.request(`${path}/archive`, { method: "PUT", json: { mode: "on" } })).status).toBe(200);
    expect(h.db.prepare("SELECT automation FROM autopilot_settings").all()).toEqual([{ automation: "archive" }]);
  });

  it("ignores an epic row for an automation that stops applying to epics", () => {
    const h = setup({ withProjectWide: true });
    const epic = h.services.tasks.createEpic({ projectId: h.project.id, title: "E" }, [], "agent");
    // A row left from before the flag was set.
    h.db
      .prepare(
        "INSERT INTO autopilot_settings VALUES ('epic', ?, 'project_wide', 'on', '{}', '2026-01-01T00:00:00.000Z')",
      )
      .run(epic.id);
    const automation = h.services.autopilot.automations().find((a) => a.key === "project_wide")!;
    expect(h.services.autopilot.resolve(automation, h.project.id, epic.id).enabled).toBe(false);
    expect(h.services.autopilot.projectsWithEpicOn(automation).size).toBe(0);
  });

  it("only accepts an epic that is in the project", async () => {
    const h = setup();
    const other = h.services.projects.create({ title: "Q", workspaceRoot: "/work/q" });
    const epic = h.services.tasks.createEpic({ projectId: other.id, title: "E" }, [], "agent");
    const task = h.services.tasks.create({ projectId: h.project.id, title: "T" });
    const put = (path: string) => h.request(path, { method: "PUT", json: { mode: "on" } });
    const base = `/api/autopilot/projects/${h.project.id}/epics`;
    // An epic of another project, a plain task, and an id that doesn't exist.
    for (const id of [epic.id, task.id, "missing"]) {
      expect((await h.request(`${base}/${id}`)).status).toBe(404);
      expect((await put(`${base}/${id}/archive`)).status).toBe(404);
    }
    expect((await put(`/api/autopilot/projects/missing/epics/${epic.id}/archive`)).status).toBe(404);
    expect(() => h.services.autopilot.scope("epic", epic.id)).toThrow(/not found/);
    expect(h.db.prepare("SELECT count(*) AS n FROM autopilot_settings").get()).toEqual({ n: 0 });
  });

  it("drops an epic's switches when the epic is deleted", () => {
    const h = setup();
    const epic = h.services.tasks.createEpic({ projectId: h.project.id, title: "E" }, [], "agent");
    h.services.autopilot.setScope("epic", epic.id, "archive", { mode: "on" }, h.project.id);
    h.services.tasks.update(epic.id, { archived: true }, "user");
    h.services.tasks.delete(epic.id, "user");
    expect(h.db.prepare("SELECT count(*) AS n FROM autopilot_settings").get()).toEqual({ n: 0 });
  });

  it("drops a project's switches when the project is deleted", () => {
    const h = setup();
    h.services.autopilot.setScope("project", h.project.id, "archive", { mode: "on" });
    h.services.projects.delete(h.project.id);
    expect(h.db.prepare("SELECT count(*) AS n FROM autopilot_settings").get()).toEqual({ n: 0 });
  });

  it("lists runs by task or project, newest first", async () => {
    const h = setup();
    const task = h.services.tasks.create({ projectId: h.project.id, title: "T" });
    for (const key of ["a", "b"]) {
      h.services.autopilot.record({
        automation: "archive",
        candidate: { dedupeKey: key, summary: `archive ${key}`, taskId: task.id, projectId: h.project.id },
        dryRun: false,
      });
    }
    const byTask = (await (await h.request(`/api/autopilot/runs?taskId=%23${task.number}`)).json()) as AutopilotRun[];
    expect(byTask.map((r) => r.dedupeKey)).toHaveLength(2);
    const byProject = await h.request(`/api/autopilot/runs?projectId=${h.project.id}&limit=1`);
    expect(((await byProject.json()) as AutopilotRun[]).length).toBe(1);
    expect((await h.request("/api/autopilot/runs")).status).toBe(400);
  });

  it("dismisses a flagged run once, and refuses an unflagged or unknown one", async () => {
    const h = setup();
    const task = h.services.tasks.create({ projectId: h.project.id, title: "T" });
    const run = (key: string, flagged: boolean) => {
      const made = h.services.autopilot.record({
        automation: "archive",
        candidate: { dedupeKey: key, summary: key, taskId: task.id, projectId: h.project.id },
        dryRun: false,
      })!;
      h.services.autopilot.start(made.id);
      return h.services.autopilot.finish(made.id, flagged ? { status: "failed", needsAttention: true } : {});
    };
    const fine = run("fine", false);
    const flagged = run("flagged", true);
    const dismiss = (id: string) => h.request(`/api/autopilot/runs/${id}/dismiss`, { method: "POST" });

    expect((await dismiss(fine.id)).status).toBe(409);
    expect((await dismiss("nope")).status).toBe(404);
    const done = await dismiss(flagged.id);
    expect(done.status).toBe(200);
    expect(((await done.json()) as AutopilotRun).dismissedAt).not.toBeNull();
    // Idempotent: a second tab dismissing the same flag is not an error.
    expect((await dismiss(flagged.id)).status).toBe(200);
  });
});

describe("Digest REST routes", () => {
  const put = (h: ReturnType<typeof createTestHarness>, config: Record<string, unknown>) =>
    h.request("/api/autopilot/board/digest", { method: "PUT", json: { mode: "on", config } });

  it("makes a plain digest on request, lists it unread newest first, and marks it read", async () => {
    const h = createTestHarness();
    const project = h.services.projects.create({ title: "P", workspaceRoot: "/work/p" });
    h.services.tasks.create({
      projectId: project.id,
      title: "T",
      plan: { phases: [{ title: "a", steps: [{ title: "b" }] }] },
    });
    expect(await (await h.request("/api/autopilot/digests")).json()).toEqual({ items: [], unread: 0 });

    const made = await h.request("/api/autopilot/digests", { method: "POST" });
    expect(made.status).toBe(201);
    const { digest } = (await made.json()) as { digest: Digest };
    expect(digest).toMatchObject({ mode: "plain", trigger: "manual", readAt: null });
    expect(digest.bodyMd).toContain("# Digest:");

    const list = (await (await h.request("/api/autopilot/digests")).json()) as DigestList;
    expect(list).toMatchObject({ items: [{ id: digest.id }], unread: 1 });
    const read = await h.request(`/api/autopilot/digests/${digest.id}/read`, { method: "POST" });
    expect(((await read.json()) as Digest).readAt).not.toBeNull();
    expect(((await (await h.request("/api/autopilot/digests")).json()) as DigestList).unread).toBe(0);
    expect((await h.request("/api/autopilot/digests/nope/read", { method: "POST" })).status).toBe(404);
  });

  it("answers 202 while an agent writes it, and 409 for a second request meanwhile", async () => {
    let release: ((stdout: string) => void) | null = null;
    const h = createTestHarness({
      integrations: { runAgent: () => new Promise((resolve) => (release = resolve)) },
    });
    const project = h.services.projects.create({ title: "P", workspaceRoot: "/work/p" });
    h.services.tasks.create({
      projectId: project.id,
      title: "T",
      plan: { phases: [{ title: "a", steps: [{ title: "b" }] }] },
    });
    const task = h.services.tasks.summaries({})[0]!;
    h.services.tasks.move(task.id, { status: "in_progress" }, "agent");
    expect((await put(h, { mode: "summarised" })).status).toBe(200);

    const started = await h.request("/api/autopilot/digests", { method: "POST" });
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual({ digest: null });
    expect((await h.request("/api/autopilot/digests", { method: "POST" })).status).toBe(409);
    // The agent starts once its folder is made.
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!(JSON.stringify({ type: "result", subtype: "success", result: "All quiet.", total_cost_usd: 0.1 }));
    await h.integrations.digestsIdle();
    const list = (await (await h.request("/api/autopilot/digests")).json()) as DigestList;
    expect(list.items).toMatchObject([{ mode: "summarised", bodyMd: "All quiet.\n", costUsd: 0.1 }]);
  });

  it("describes the settings, and refuses a time or skill that isn't one", async () => {
    const h = createTestHarness();
    const overview = (await (await h.request("/api/autopilot")).json()) as AutopilotOverview;
    const entry = overview.automations.find((a) => a.key === "digest")!;
    expect(entry).toMatchObject({
      needsAgent: false,
      epicScope: false,
      defaults: { mode: "plain", time: "09:00", weekdaysOnly: false },
    });
    expect(entry.fields.map((f) => f.kind)).toEqual(["select", "time", "boolean", "skill", "number", "number", "text"]);

    expect((await put(h, { time: "9am" })).status).toBe(400);
    expect((await put(h, { mode: "chatty" })).status).toBe(400);
    expect((await put(h, { skill: { source: "global" } })).status).toBe(400);
    expect((await put(h, { time: "07:30", weekdaysOnly: true })).status).toBe(200);
  });
});
