import { ACTOR_HEADER, type ApiErrorBody, type TaskDetail } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";

async function setup() {
  const h = createTestHarness();
  const project = h.services.projects.create({ title: "P" });
  const res = await h.request("/api/tasks", {
    method: "POST",
    json: { projectId: project.id, title: "Idea" },
    headers: { [ACTOR_HEADER]: "codex" },
  });
  expect(res.status).toBe(201);
  const task = (await res.json()) as TaskDetail;
  return { ...h, project, task };
}

const errorCode = async (res: Response) => ((await res.json()) as ApiErrorBody).error.code;

describe("REST", () => {
  it("creates with the header actor and fetches by #number", async () => {
    const h = await setup();
    expect(h.task.createdBy).toBe("codex");
    const res = await h.request(`/api/tasks/%23${h.task.number}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as TaskDetail).id).toBe(h.task.id);
  });

  it("maps domain and validation errors", async () => {
    const h = await setup();
    const missing = await h.request("/api/tasks/999");
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("NOT_FOUND");

    const gated = await h.request(`/api/tasks/${h.task.id}/move`, { method: "POST", json: { status: "planned" } });
    expect(gated.status).toBe(422);
    expect(await errorCode(gated)).toBe("PLAN_REQUIRED");

    const invalid = await h.request(`/api/tasks/${h.task.id}/move`, { method: "POST", json: { status: "bogus" } });
    expect(invalid.status).toBe(400);
    const body = (await invalid.json()) as ApiErrorBody;
    expect(body.error.code).toBe("VALIDATION");
    expect(Array.isArray(body.error.details)).toBe(true);

    const malformed = await h.request("/api/projects", {
      method: "POST",
      body: "{nope",
      headers: { "content-type": "application/json" },
    });
    expect(malformed.status).toBe(400);
  });

  it("supports the plan → move → archive flow", async () => {
    const h = await setup();
    const planned = await h.request(`/api/tasks/${h.task.id}/plan`, {
      method: "PUT",
      json: { phases: [{ title: "One", steps: [{ title: "a" }] }] },
    });
    expect(planned.status).toBe(200);
    const moved = await h.request(`/api/tasks/${h.task.number}/move`, { method: "POST", json: { status: "in_progress" } });
    expect(((await moved.json()) as { status: string }).status).toBe("in_progress");
    expect((await h.request(`/api/tasks/${h.task.id}`, { method: "DELETE" })).status).toBe(204);
    const board = (await (await h.request("/api/board")).json()) as { tasks: unknown[]; projects: unknown[] };
    expect(board.tasks).toHaveLength(0);
    expect(board.projects).toHaveLength(1);
  });

  it("serves settings without the token", async () => {
    const h = await setup();
    const res = await h.request("/api/settings", { method: "PATCH", json: { t3Token: "tok" } });
    expect(await res.json()).toMatchObject({ t3TokenSet: true });
    const status = await h.request("/api/integrations/status");
    expect(await status.json()).toMatchObject({ t3: { detected: false }, github: { available: false } });
  });
});
