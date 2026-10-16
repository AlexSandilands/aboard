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

function setup() {
  const h = createTestHarness({ integrations: { automations: [archive] } });
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
      automations: [{ key: "archive", needsAgent: false, defaults: { days: 14 } }],
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
    expect(() => h.services.autopilot.scope("epic", h.project.id)).toThrow(/epic/);
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
    expect(entry).toMatchObject({ needsAgent: false, defaults: { mode: "plain", time: "09:00", weekdaysOnly: false } });
    expect(entry.fields.map((f) => f.kind)).toEqual(["select", "time", "boolean", "skill", "number", "number", "text"]);

    expect((await put(h, { time: "9am" })).status).toBe(400);
    expect((await put(h, { mode: "chatty" })).status).toBe(400);
    expect((await put(h, { skill: { source: "global" } })).status).toBe(400);
    expect((await put(h, { time: "07:30", weekdaysOnly: true })).status).toBe(200);
  });
});
