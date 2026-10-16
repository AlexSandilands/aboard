import { ACTOR_HEADER, type ApiErrorBody, type Project, type TaskDetail } from "@repo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../test/harness.ts";

async function setup() {
  const h = createTestHarness();
  const project = h.services.projects.create({ title: "P" });
  const res = await h.request("/api/tasks", {
    method: "POST",
    json: { projectId: project.id, title: "Later" },
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

    // Agents with older instructions still send the old name for Backlog.
    const old = await h.request(`/api/tasks/${h.task.id}/move`, { method: "POST", json: { status: "idea" } });
    expect(old.status).toBe(200);
    expect(((await old.json()) as TaskDetail).status).toBe("backlog");
    const listed = (await (await h.request("/api/tasks?status=idea")).json()) as TaskDetail[];
    expect(listed.map((t) => [t.id, t.status])).toEqual([[h.task.id, "backlog"]]);

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
    const moved = await h.request(`/api/tasks/${h.task.number}/move`, {
      method: "POST",
      json: { status: "in_progress" },
    });
    expect(((await moved.json()) as { status: string }).status).toBe("in_progress");
    const archived = await h.request(`/api/tasks/${h.task.id}`, { method: "PATCH", json: { archived: true } });
    expect(archived.status).toBe(200);
    const board = (await (await h.request("/api/board")).json()) as { tasks: unknown[]; projects: unknown[] };
    expect(board.tasks).toHaveLength(0);
    expect(board.projects).toHaveLength(1);
  });

  it("adds a pasted T3 thread id as a thread link and returns the warning with it", async () => {
    const h = await setup();
    const threadId = "bca46358-2812-4417-93f7-e151c0f96292";
    vi.spyOn(h.integrations, "resolveLinkInput").mockResolvedValue({
      input: { t3Thread: { environmentId: "env-1", threadId } },
      warning: "Linked without checking the thread exists",
    });
    const res = await h.request(`/api/tasks/${h.task.id}/links`, { method: "POST", json: { value: threadId } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      kind: "t3_thread",
      ref: { environmentId: "env-1", threadId },
      warning: "Linked without checking the thread exists",
    });
    // Without T3 detected a bare id is still not a link.
    vi.restoreAllMocks();
    const unknown = await h.request(`/api/tasks/${h.task.id}/links`, { method: "POST", json: { value: threadId } });
    expect(unknown.status).toBe(400);
  });

  it("deletes a task permanently only once it is archived", async () => {
    const h = await setup();
    const active = await h.request(`/api/tasks/%23${h.task.number}`, { method: "DELETE" });
    expect(active.status).toBe(400);
    expect(await errorCode(active)).toBe("VALIDATION");

    await h.request(`/api/tasks/${h.task.id}`, { method: "PATCH", json: { archived: true } });
    expect((await h.request(`/api/tasks/%23${h.task.number}`, { method: "DELETE" })).status).toBe(204);
    expect((await h.request(`/api/tasks/${h.task.id}`)).status).toBe(404);
    const archivedList = (await (await h.request("/api/tasks?includeArchived=true")).json()) as unknown[];
    expect(archivedList).toHaveLength(0);
  });

  it("closes a task by #number reference and validates the pairing", async () => {
    const h = await setup();
    const other = h.services.tasks.create({ projectId: h.project.id, title: "Delivered it" });
    const close = (json: unknown) => h.request(`/api/tasks/${h.task.id}/close`, { method: "POST", json });

    const bad = await close({ resolution: "wont_do", byTask: `#${other.number}` });
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe("VALIDATION");

    const res = await close({ resolution: "completed", byTask: `#${other.number}` });
    expect(res.status).toBe(200);
    expect((await res.json()) as TaskDetail).toMatchObject({
      status: "done",
      resolution: "completed",
      resolvedBy: { id: other.id },
    });
  });

  it("stores an image project icon and rejects unsafe ones", async () => {
    const h = await setup();
    const icon = { kind: "image", dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
    const saved = await h.request(`/api/projects/${h.project.id}`, { method: "PATCH", json: { icon } });
    expect(saved.status).toBe(200);
    const projects = (await (await h.request("/api/projects")).json()) as Project[];
    expect(projects[0]?.icon).toEqual(icon);

    const svg = await h.request(`/api/projects/${h.project.id}`, {
      method: "PATCH",
      json: { icon: { kind: "image", dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" } },
    });
    expect(await errorCode(svg)).toBe("VALIDATION");
  });

  it("validates PR merges before reaching GitHub", async () => {
    const h = await setup();
    const link = h.services.links.add(h.task.id, { value: "https://github.com/o/r/pull/1" }, "user");
    const merge = (json: unknown) => h.request(`/api/links/${link.id}/merge`, { method: "POST", json });
    expect(await errorCode(await merge({ action: "merge" }))).toBe("VALIDATION");
    expect(await errorCode(await merge({ action: "squash-it", method: "squash" }))).toBe("VALIDATION");
    const notReview = await merge({ action: "merge", method: "squash" });
    expect(notReview.status).toBe(400);
    expect(((await notReview.json()) as ApiErrorBody).error.message).toMatch(/in Review/);
    expect(
      await errorCode(await h.request("/api/links/nope/merge", { method: "POST", json: { action: "disable_auto" } })),
    ).toBe("NOT_FOUND");
  });

  it("serves settings without the token", async () => {
    const h = await setup();
    const res = await h.request("/api/settings", { method: "PATCH", json: { t3Token: "tok" } });
    expect(await res.json()).toMatchObject({ t3TokenSet: true });
    const status = await h.request("/api/integrations/status");
    expect(await status.json()).toMatchObject({ t3: { detected: false }, github: { available: false } });
  });

  it("validates T3 thread launches and explains when T3 Code isn't available", async () => {
    const h = await setup();
    const bad = await h.request(`/api/tasks/${h.task.id}/t3-thread`, { method: "POST", json: { prompt: "" } });
    expect(bad.status).toBe(400);
    const options = await h.request(`/api/tasks/${h.task.id}/t3-launch-options`);
    expect(options.status).toBe(400);
    expect(((await options.json()) as ApiErrorBody).error.message).toBe("T3 Code is not running");
    expect((await h.request("/api/tasks/missing/t3-launch-options")).status).toBe(404);
  });
});
