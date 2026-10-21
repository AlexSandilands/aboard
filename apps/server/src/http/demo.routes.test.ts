import { AUTOPILOT_FIX_PRS, type AutopilotRun, type TaskLink } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";

function setup(demo: boolean) {
  const h = createTestHarness({ demo });
  const project = h.services.projects.create({ title: "P" });
  const task = h.services.tasks.create({ projectId: project.id, title: "Fix the build", actor: "test" });
  const link = h.services.links.add(task.id, { value: "https://github.com/example/shop/pull/87" }, "test");
  h.services.links.setSnapshot(link.id, {
    state: "open",
    title: "Fix the build",
    checks: "failing",
    reviewDecision: null,
    mergeable: "mergeable",
    headRef: "fix/build",
    updatedAt: null,
  });
  return { ...h, task, link };
}

describe("/api/demo", () => {
  it("is not registered outside the sandbox", async () => {
    const h = setup(false);
    const pr = await h.request(`/api/demo/links/${h.link.id}/pr`, { method: "POST", json: { checks: "passing" } });
    expect(pr.status).toBe(404);
    const run = await h.request("/api/demo/autopilot/runs", {
      method: "POST",
      json: { automation: AUTOPILOT_FIX_PRS, taskId: h.task.id, summary: "fix the checks" },
    });
    expect(run.status).toBe(404);
  });

  it("changes a PR's checks and publishes the task", async () => {
    const h = setup(true);
    h.events.length = 0;
    const res = await h.request(`/api/demo/links/${h.link.id}/pr`, { method: "POST", json: { checks: "pending" } });
    expect(res.status).toBe(200);
    const { snapshot } = (await res.json()) as Extract<TaskLink, { kind: "pr" }>;
    expect(snapshot).toMatchObject({ checks: "pending", headRef: "fix/build", state: "open" });
    expect(h.events.some((e) => e.type === "task.upserted" && e.task.id === h.task.id)).toBe(true);
  });

  it("runs a pretend Autopilot run from start to finish", async () => {
    const h = setup(true);
    h.events.length = 0;
    const started = await h.request("/api/demo/autopilot/runs", {
      method: "POST",
      json: { automation: AUTOPILOT_FIX_PRS, taskId: `#${h.task.number}`, summary: "fix the checks" },
    });
    expect(started.status).toBe(201);
    const run = (await started.json()) as AutopilotRun;
    expect(run.status).toBe("running");
    expect(h.services.autopilot.status().active).toMatchObject([{ taskId: h.task.id, projectId: h.task.projectId }]);
    expect(h.events.some((e) => e.type === "autopilot.changed" && e.autopilot.active.length === 1)).toBe(true);

    const finished = await h.request(`/api/demo/autopilot/runs/${run.id}/finish`, {
      method: "POST",
      json: { summary: "Pushed a fix" },
    });
    expect(finished.status).toBe(200);
    expect(((await finished.json()) as AutopilotRun).status).toBe("succeeded");
    expect(h.services.autopilot.status().active).toEqual([]);
  });
});
