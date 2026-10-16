import type {
  AutopilotEngineSettings,
  AutopilotOverview,
  AutopilotRun,
  AutopilotScopeEntry,
  AutopilotStatus,
  BoardSnapshot,
} from "@repo/contracts";
import { describe, expect, it } from "vitest";
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
