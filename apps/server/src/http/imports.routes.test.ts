import type { TaskDetail, TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";

// gh never answers, so an import a route starts stays pending while the test looks at it.
function setup() {
  const h = createTestHarness({ integrations: { runGh: () => new Promise(() => {}) } });
  const project = h.services.projects.create({ title: "P", workspaceRoot: "/nonexistent/work" });
  return { ...h, project };
}

describe("issue import REST routes", () => {
  it("creates a task from an issue URL, pending and in Backlog", async () => {
    const h = setup();
    const res = await h.request("/api/tasks", {
      method: "POST",
      json: { projectId: h.project.id, sourceUrl: "https://github.com/acme/app/issues/45" },
    });
    expect(res.status).toBe(201);
    expect((await res.json()) as TaskDetail).toMatchObject({
      title: "acme/app#45",
      status: "backlog",
      import: { status: "pending" },
    });
  });

  it("rejects a source that isn't an issue, and one given with a plan", async () => {
    const h = setup();
    const bad = await h.request("/api/tasks", { method: "POST", json: { projectId: h.project.id, sourceUrl: "nope" } });
    expect(bad.status).toBe(400);
    const planned = await h.request("/api/tasks", {
      method: "POST",
      json: {
        projectId: h.project.id,
        sourceUrl: "PROJ-1",
        plan: { phases: [{ title: "a", steps: [{ title: "b" }] }] },
      },
    });
    expect(planned.status).toBe(400);
    const untitled = await h.request("/api/tasks", { method: "POST", json: { projectId: h.project.id } });
    expect(untitled.status).toBe(400);
  });

  it("retries a failed or pending import, but not a finished one", async () => {
    const h = setup();
    const task = h.services.tasks.create({ projectId: h.project.id, sourceUrl: "PROJ-1" });
    const early = await h.request(`/api/tasks/${task.id}/import/retry`, { method: "POST" });
    expect(early.status).toBe(200);

    h.services.imports.fail(task.id, "No Jira tool available");
    const retried = await h.request(`/api/tasks/${task.id}/import/retry`, { method: "POST" });
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as TaskSummary).import).toMatchObject({ status: "pending", error: null });

    h.services.imports.complete(task.id, { title: "Done", description: null, labels: [] });
    expect((await h.request(`/api/tasks/${task.id}/import/retry`, { method: "POST" })).status).toBe(409);

    const plain = h.services.tasks.create({ projectId: h.project.id, title: "Plain" });
    expect((await h.request(`/api/tasks/${plain.id}/import/retry`, { method: "POST" })).status).toBe(404);
  });
});
