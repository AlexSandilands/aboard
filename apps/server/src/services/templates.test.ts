import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.ts";
import { createTestHarness } from "../test/harness.ts";

function setup() {
  const h = createTestHarness();
  const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const other = h.services.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
  return { ...h, s: h.services, project, other };
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

afterEach(() => vi.useRealTimers());

describe("starter templates", () => {
  it("ships Bug, Spike and Feature, each with a plan", () => {
    const { s } = setup();
    const starters = s.templates.list();
    expect(starters.map((t) => t.name)).toEqual(["Bug", "Feature", "Spike"]);
    const steps = (name: string) =>
      starters.find((t) => t.name === name)!.phases.flatMap((p) => p.steps.map((step) => step.title));
    expect(steps("Bug")).toEqual(["Reproduce", "Fix", "Regression test"]);
    expect(steps("Spike")).toEqual(["Questions", "Investigate", "Write up findings"]);
    expect(steps("Feature")).toEqual(["Design", "Implement", "Tests", "Docs"]);
    expect(starters.every((t) => t.projectId === null)).toBe(true);
    expect(starters.find((t) => t.name === "Bug")!.description).toContain("\n## Expected\n");
  });

  it("can be edited and deleted like any other", () => {
    const { s } = setup();
    const bug = s.templates.list().find((t) => t.name === "Bug")!;
    expect(s.templates.update(bug.id, { name: "Defect" }).name).toBe("Defect");
    s.templates.delete(bug.id);
    expect(s.templates.list().map((t) => t.name)).not.toContain("Defect");
    expectCode(() => s.templates.get(bug.id), "NOT_FOUND");
  });
});

describe("template CRUD", () => {
  it("normalises labels, drops phases without steps and clears blank text", () => {
    const { s } = setup();
    const template = s.templates.create({
      name: "Chore",
      labels: ["Tech Debt", "#ui", "tech-debt"],
      description: "  ",
      planContext: "",
      phases: [
        { title: "Empty", steps: [] },
        {
          title: "Do",
          steps: [
            { title: "Step", notes: "" },
            { title: "Other", notes: "why" },
          ],
        },
      ],
    });
    expect(template).toMatchObject({
      labels: ["tech-debt", "ui"],
      description: null,
      planContext: null,
      projectId: null,
      suggestedTier: null,
    });
    expect(template.phases).toEqual([{ title: "Do", steps: [{ title: "Step" }, { title: "Other", notes: "why" }] }]);
  });

  it("keeps one name per scope, ignoring case, but allows the same name in another scope", () => {
    const { s, project, other } = setup();
    expectCode(() => s.templates.create({ name: "bug" }), "CONFLICT");
    s.templates.create({ name: "Bug", projectId: project.id });
    expectCode(() => s.templates.create({ name: "BUG", projectId: project.id }), "CONFLICT");
    s.templates.create({ name: "Bug", projectId: other.id });
    const spike = s.templates.list().find((t) => t.name === "Spike")!;
    expectCode(() => s.templates.update(spike.id, { name: "feature" }), "CONFLICT");
    expect(s.templates.update(spike.id, { name: "SPIKE" }).name).toBe("SPIKE");
    expectCode(() => s.templates.update(spike.id, { projectId: "nope" }), "NOT_FOUND");
  });

  it("scopes a template to a project and lists board-wide plus that project's", () => {
    const { s, project, other } = setup();
    s.templates.create({ name: "Alpha only", projectId: project.id });
    s.templates.create({ name: "Beta only", projectId: other.id });
    const names = (projectId?: string) => s.templates.list(projectId ? { projectId } : undefined).map((t) => t.name);
    expect(names(project.id)).toEqual(["Bug", "Feature", "Spike", "Alpha only"]);
    expect(names(other.id)).toEqual(["Bug", "Feature", "Spike", "Beta only"]);
    expect(names()).toHaveLength(5);
  });

  it("duplicates into a free name in the same scope", () => {
    const { s, project } = setup();
    const own = s.templates.create({ name: "Mine", projectId: project.id, labels: ["x"] });
    const copy = s.templates.duplicate(own.id);
    expect(copy).toMatchObject({ name: "Mine copy", projectId: project.id, labels: ["x"] });
    expect(copy.id).not.toBe(own.id);
    expect(s.templates.duplicate(own.id).name).toBe("Mine copy 2");
  });

  it("is removed with its project", () => {
    const { s, project } = setup();
    const own = s.templates.create({ name: "Mine", projectId: project.id });
    s.projects.delete(project.id);
    expect(s.templates.list().map((t) => t.id)).not.toContain(own.id);
    expectCode(() => s.templates.get(own.id), "NOT_FOUND");
  });
});

describe("resolving a template", () => {
  it("finds by id or name in any case, preferring the project's over the board's", () => {
    const { s, project, other } = setup();
    const board = s.templates.list().find((t) => t.name === "Bug")!;
    const own = s.templates.create({ name: "Bug", projectId: project.id });
    expect(s.templates.resolve(board.id, project.id).id).toBe(board.id);
    expect(s.templates.resolve("bug", project.id).id).toBe(own.id);
    expect(s.templates.resolve("bug", other.id).id).toBe(board.id);
  });

  it("refuses another project's template and lists what is available", () => {
    const { s, project, other } = setup();
    const beta = s.templates.create({ name: "Beta only", projectId: other.id });
    expectCode(() => s.templates.resolve(beta.id, project.id), "NOT_FOUND");
    expectCode(() => s.templates.resolve("Beta only", project.id), "NOT_FOUND");
    expect(() => s.templates.resolve("Nope", project.id)).toThrow(/Available here: Bug, Feature, Spike\./);
  });
});

describe("creating a task from a template", () => {
  it("copies the fields, renders placeholders, records the template and logs its name", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 6, 12));
    const { s, project } = setup();
    const template = s.templates.create({
      name: "Weekly",
      titlePattern: "Review {{date}} ({{project}})",
      description: "Notes for {{date}}",
      labels: ["ops"],
      planContext: "Why we do this",
      suggestedTier: "light",
      phases: [{ title: "Review", steps: [{ title: "Read the board", notes: "all of it" }, { title: "Tidy" }] }],
    });
    const task = s.tasks.create({ projectId: project.id, template: template.id });
    expect(task).toMatchObject({
      title: "Review 2026-10-06 (Alpha)",
      description: "Notes for 2026-10-06",
      labels: ["ops"],
      planContext: "Why we do this",
      status: "backlog",
      suggestedModel: { tier: "light", reason: null },
    });
    expect(task.phases.map((p) => [p.title, p.steps.map((st) => [st.title, st.notes, st.status])])).toEqual([
      [
        "Review",
        [
          ["Read the board", "all of it", "todo"],
          ["Tidy", null, "todo"],
        ],
      ],
    ]);
    expect(task.events[0]).toMatchObject({ type: "created", payload: { status: "backlog", template: "Weekly" } });
    expect(s.tasks.move(task.id, { status: "planned" }, "user").status).toBe("planned");
  });

  it("lets explicit fields win, and an explicit plan replaces the template's", () => {
    const { s, project } = setup();
    const task = s.tasks.create({
      projectId: project.id,
      template: "Bug",
      title: "Login fails",
      description: "Mine",
      labels: ["auth"],
      plan: { phases: [{ title: "Mine", steps: [{ title: "Only step" }] }] },
    });
    expect(task).toMatchObject({ title: "Login fails", description: "Mine", labels: ["auth"], status: "planned" });
    expect(task.phases.map((p) => p.title)).toEqual(["Mine"]);
    expect(task.phases[0]!.steps.map((st) => st.title)).toEqual(["Only step"]);
    expect(task.suggestedModel).toBeNull();
  });

  it("is Backlog by default and Planned when asked, which needs a plan", () => {
    const { s, project } = setup();
    expect(s.tasks.create({ projectId: project.id, template: "Bug", title: "a" }).status).toBe("backlog");
    const planned = s.tasks.create({ projectId: project.id, template: "Bug", title: "b", status: "planned" });
    expect(planned.status).toBe("planned");
    expect(planned.phases[0]!.steps).toHaveLength(3);
    const plain = s.templates.create({ name: "Plain", description: "Just text" });
    expectCode(
      () => s.tasks.create({ projectId: project.id, template: plain.id, title: "c", status: "planned" }),
      "VALIDATION",
    );
    expectCode(() => s.tasks.create({ projectId: project.id, title: "d", status: "planned" }), "VALIDATION");
  });

  it("needs a title from somewhere", () => {
    const { s, project } = setup();
    expectCode(() => s.tasks.create({ projectId: project.id, template: "Bug" }), "VALIDATION");
    expect(() => s.tasks.create({ projectId: project.id, template: "Bug" })).toThrow(/no title pattern/);
  });

  it("uses a template of the project but not of another project", () => {
    const { s, project, other } = setup();
    s.templates.create({ name: "Alpha only", projectId: project.id, titlePattern: "From Alpha" });
    expect(s.tasks.create({ projectId: project.id, template: "Alpha only" }).title).toBe("From Alpha");
    expectCode(() => s.tasks.create({ projectId: other.id, template: "Alpha only" }), "NOT_FOUND");
  });

  it("can't make an epic, and an imported task takes its labels only", () => {
    const { s, project } = setup();
    expectCode(
      () => s.tasks.create({ projectId: project.id, template: "Bug", title: "E", kind: "epic" }),
      "VALIDATION",
    );
    expectCode(() => s.tasks.create({ projectId: project.id, template: "Bug", sourceUrl: "ABC-1" }), "VALIDATION");
    const plain = s.templates.create({ name: "Plain", description: "Text", labels: ["x"] });
    const imported = s.tasks.create({ projectId: project.id, template: plain.id, sourceUrl: "ABC-1" });
    expect(imported).toMatchObject({ description: null, labels: ["x"] });
  });

  it("leaves existing tasks alone when the template is edited or deleted", () => {
    const { s, project, db } = setup();
    const template = s.templates.create({
      name: "Weekly",
      titlePattern: "Weekly",
      description: "Before",
      labels: ["a"],
      phases: [{ title: "P", steps: [{ title: "One" }] }],
    });
    const task = s.tasks.create({ projectId: project.id, template: template.id });
    s.templates.update(template.id, {
      titlePattern: "Changed",
      description: "After",
      labels: ["b"],
      phases: [{ title: "Q", steps: [{ title: "Two" }] }],
    });
    const same = s.tasks.detail(task.id);
    expect(same).toMatchObject({ title: "Weekly", description: "Before", labels: ["a"] });
    expect(same.phases.map((p) => p.title)).toEqual(["P"]);

    s.templates.delete(template.id);
    expect(s.tasks.detail(task.id).title).toBe("Weekly");
    expect(db.prepare("SELECT template_id FROM tasks WHERE id = ?").get(task.id)).toEqual({ template_id: null });
  });
});

describe("template routes", () => {
  it("lists, creates, updates, duplicates and deletes", async () => {
    const { request, project } = setup();
    const listed = (await (await request("/api/templates")).json()) as Array<{ name: string }>;
    expect(listed.map((t) => t.name)).toEqual(["Bug", "Feature", "Spike"]);

    const created = await request("/api/templates", {
      method: "POST",
      json: { name: "Chore", projectId: project.id, labels: ["Tech Debt"] },
    });
    expect(created.status).toBe(201);
    const chore = (await created.json()) as { id: string; labels: string[] };
    expect(chore.labels).toEqual(["tech-debt"]);

    const scoped = (await (await request(`/api/templates?projectId=${project.id}`)).json()) as unknown[];
    expect(scoped).toHaveLength(4);

    const patched = await request(`/api/templates/${chore.id}`, { method: "PATCH", json: { name: "Chores" } });
    expect(await patched.json()).toMatchObject({ name: "Chores" });
    const clash = await request("/api/templates", { method: "POST", json: { name: "chores", projectId: project.id } });
    expect(clash.status).toBe(409);
    expect((await request("/api/templates", { method: "POST", json: { name: " " } })).status).toBe(400);

    const copy = await request(`/api/templates/${chore.id}/duplicate`, { method: "POST" });
    expect(copy.status).toBe(201);
    expect(await copy.json()).toMatchObject({ name: "Chores copy" });
    expect((await request(`/api/templates/${chore.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await request(`/api/templates/${chore.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("creates a task from a template over REST", async () => {
    const { request, project } = setup();
    const res = await request("/api/tasks", {
      method: "POST",
      json: { projectId: project.id, title: "Crash on save", template: "Bug", status: "planned" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: "planned", labels: ["bug"], title: "Crash on save" });
    const bad = await request("/api/tasks", { method: "POST", json: { projectId: project.id, template: "Nope" } });
    expect(bad.status).toBe(404);
  });
});
