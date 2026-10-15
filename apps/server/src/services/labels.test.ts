import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { createTestHarness } from "../test/harness.ts";

function setup() {
  const h = createTestHarness();
  const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  return { ...h, s: h.services, project };
}

const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe("task labels", () => {
  it("normalises, dedupes and sorts labels on create", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, title: "A", labels: ["UI", "#backend", "ui", "Tech debt"] });
    expect(task.labels).toEqual(["backend", "tech-debt", "ui"]);
    expect(task.events.map((e) => e.type)).toEqual(["created", "labels_changed"]);
  });

  it("replaces the list on update, logging what was added and removed", () => {
    const { s, project, events } = setup();
    const task = s.tasks.create({ projectId: project.id, title: "A", labels: ["ui", "server"] });
    events.length = 0;
    const updated = s.tasks.update(task.id, { labels: ["server", "docs"] }, "agent");
    expect(updated.labels).toEqual(["docs", "server"]);
    expect(updated.events.at(-1)).toMatchObject({
      type: "labels_changed",
      actor: "agent",
      payload: { added: ["docs"], removed: ["ui"] },
    });
    const upserted = events.find((e) => e.type === "task.upserted");
    expect(upserted?.type === "task.upserted" && upserted.task.labels).toEqual(["docs", "server"]);
  });

  it("logs nothing when the set is unchanged", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, title: "A", labels: ["ui"] });
    const updated = s.tasks.update(task.id, { labels: ["UI"] }, "user");
    expect(updated.events.filter((e) => e.type === "labels_changed")).toHaveLength(1);
  });

  it("rejects empty, over-long and too many labels", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, title: "A" });
    expectCode(() => s.tasks.update(task.id, { labels: [" "] }, "user"), "VALIDATION");
    expectCode(() => s.tasks.update(task.id, { labels: ["x".repeat(40)] }, "user"), "VALIDATION");
    const many = Array.from({ length: 11 }, (_, i) => `l${i}`);
    expectCode(() => s.tasks.update(task.id, { labels: many }, "user"), "VALIDATION");
    expect(s.tasks.detail(task.id).labels).toEqual([]);
  });

  it("filters summaries by any of the labels and matches labels in free text", () => {
    const { s, project } = setup();
    const ui = s.tasks.create({ projectId: project.id, title: "One", labels: ["ui"] });
    const server = s.tasks.create({ projectId: project.id, title: "Two", labels: ["server"] });
    s.tasks.create({ projectId: project.id, title: "Three", labels: ["docs"] });
    const ids = (labels: string[]) => s.tasks.summaries({ labels }).map((t) => t.id);
    expect(ids(["UI", "server"])).toEqual([ui.id, server.id]);
    const many = Array.from({ length: 12 }, (_, i) => `l${i}`);
    expect(ids([...many, " ", "x".repeat(40), "docs"])).toHaveLength(1);
    expect(s.tasks.summaries({ query: "serv" }).map((t) => t.id)).toEqual([server.id]);
  });

  it("counts usage on active tasks only", () => {
    const { s, project } = setup();
    s.tasks.create({ projectId: project.id, title: "A", labels: ["ui", "server"] });
    const b = s.tasks.create({ projectId: project.id, title: "B", labels: ["ui"] });
    const c = s.tasks.create({ projectId: project.id, title: "C", labels: ["docs"] });
    s.tasks.update(c.id, { archived: true }, "user");
    expect(s.labels.usage()).toEqual([
      { name: "server", count: 1, hue: null },
      { name: "ui", count: 2, hue: null },
    ]);
    s.tasks.update(b.id, { labels: [] }, "user");
    expect(s.labels.usage().find((u) => u.name === "ui")?.count).toBe(1);
  });
});

describe("label colours", () => {
  it("sets and resets an override, publishing the full map", () => {
    const { s, project, events } = setup();
    s.tasks.create({ projectId: project.id, title: "A", labels: ["ui"] });
    events.length = 0;
    expect(s.labels.setColor("UI", 200)).toEqual({ ui: 200 });
    expect(s.labels.setColor("ui", 120)).toEqual({ ui: 120 });
    expect(events).toEqual([
      { type: "labels.colors_changed", labelColors: { ui: 200 } },
      { type: "labels.colors_changed", labelColors: { ui: 120 } },
    ]);
    expect(s.board.snapshot().labelColors).toEqual({ ui: 120 });
    expect(s.labels.usage()).toEqual([{ name: "ui", count: 1, hue: 120 }]);

    events.length = 0;
    expect(s.labels.clearColor("ui")).toEqual({});
    expect(s.labels.clearColor("ui")).toEqual({});
    expect(events).toEqual([{ type: "labels.colors_changed", labelColors: {} }]);
  });

  it("rejects a hue out of range", () => {
    const { s } = setup();
    expectCode(() => s.labels.setColor("ui", 360), "VALIDATION");
    expectCode(() => s.labels.setColor("ui", 1.5), "VALIDATION");
    expect(s.labels.colors()).toEqual({});
  });

  it("serves labels over REST", async () => {
    const { s, project, request } = setup();
    s.tasks.create({ projectId: project.id, title: "A", labels: ["ui"] });
    const put = await request("/api/labels/ui/color", { method: "PUT", json: { hue: 30 } });
    expect(await put.json()).toEqual({ ui: 30 });
    const list = await request("/api/labels");
    expect(await list.json()).toEqual([{ name: "ui", count: 1, hue: 30 }]);
    const del = await request("/api/labels/ui/color", { method: "DELETE" });
    expect(await del.json()).toEqual({});
    const tasks = await request("/api/tasks?labels=docs,UI");
    expect(((await tasks.json()) as Array<{ title: string }>).map((t) => t.title)).toEqual(["A"]);
  });
});
