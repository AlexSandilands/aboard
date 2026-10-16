import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { renderTaskDetail } from "../mcp/format.ts";
import { createTestHarness } from "../test/harness.ts";
import { importLabels } from "./imports.ts";

function setup() {
  const h = createTestHarness();
  const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  return { ...h, s: h.services, project };
}

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : "other";
  }
  return null;
};

describe("creating a task from an issue", () => {
  it("titles and links it after a GitHub issue and leaves the import pending, in Backlog", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, sourceUrl: "https://github.com/acme/app/issues/45" });
    expect(task).toMatchObject({
      title: "acme/app#45",
      status: "backlog",
      import: { status: "pending", error: null, sourceUrl: "https://github.com/acme/app/issues/45" },
    });
    expect(task.links).toEqual([
      expect.objectContaining({ kind: "issue", ref: { host: "github.com", repo: "acme/app", number: 45 } }),
    ]);
  });

  it("links a Jira key once, however it is written", () => {
    const { s, project } = setup();
    s.settings.update({ jiraBaseUrl: "https://jira.example.com" });
    const task = s.tasks.create({ projectId: project.id, sourceUrl: "https://other.example.com/browse/PROJ-7" });
    expect(task.title).toBe("PROJ-7");
    expect(task.import?.status).toBe("pending");
    s.links.add(task.id, { value: "PROJ-7" }, "user");
    expect(s.tasks.detail(task.id).links.filter((l) => l.kind === "jira")).toHaveLength(1);
  });

  it("rejects text that is not an issue, and a plan", () => {
    const { s, project } = setup();
    expect(codeOf(() => s.tasks.create({ projectId: project.id, sourceUrl: "fix the login" }))).toBe("VALIDATION");
    expect(codeOf(() => s.tasks.create({ projectId: project.id, sourceUrl: "https://github.com/a/b/pull/1" }))).toBe(
      "VALIDATION",
    );
    expect(
      codeOf(() =>
        s.tasks.create({
          projectId: project.id,
          sourceUrl: "PROJ-1",
          plan: { phases: [{ title: "a", steps: [{ title: "b" }] }] },
        }),
      ),
    ).toBe("VALIDATION");
    expect(codeOf(() => s.tasks.create({ projectId: project.id }))).toBe("VALIDATION");
    expect(s.tasks.summaries()).toEqual([]);
  });

  it("tells an agent that the details are still coming", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, sourceUrl: "PROJ-7" });
    expect(renderTaskDetail(task, project)).toContain("Import: pending.");
    s.imports.complete(task.id, { title: "T", description: null, labels: [] });
    expect(renderTaskDetail(s.tasks.detail(task.id), project)).not.toContain("Import:");
  });

  it("has no import when created the usual way", () => {
    const { s, project } = setup();
    expect(s.tasks.create({ projectId: project.id, title: "Plain" }).import).toBeNull();
  });
});

describe("imports service", () => {
  const issue = "https://github.com/acme/app/issues/45";

  it("fills in the title, description and labels, and marks the import done", () => {
    const { s, project, events } = setup();
    const task = s.tasks.create({ projectId: project.id, sourceUrl: issue, labels: ["ui"] });
    s.imports.complete(task.id, { title: "Fix the export", description: "Exports fail.", labels: ["Bug", "ui"] });
    const done = s.tasks.detail(task.id);
    expect(done).toMatchObject({
      title: "Fix the export",
      description: "Exports fail.",
      labels: ["bug", "ui"],
      import: { status: "done", error: null },
    });
    expect(done.events.map((e) => e.type)).toContain("imported");
    expect(events.some((e) => e.type === "task.upserted" && e.task.id === task.id)).toBe(true);
  });

  it("keeps a title and description the user wrote while the import ran", () => {
    const { s, project } = setup();
    const renamed = s.tasks.create({ projectId: project.id, sourceUrl: issue });
    s.tasks.update(renamed.id, { title: "My own title", description: "My notes" }, "user");
    s.imports.complete(renamed.id, { title: "Imported", description: "Imported body", labels: [] });
    expect(s.tasks.detail(renamed.id)).toMatchObject({ title: "My own title", description: "My notes" });
  });

  it("normalises labels, drops the unusable and caps them at ten", () => {
    expect(importLabels([" UI ", "#bug", "", "x".repeat(40), "ui"])).toEqual(["ui", "bug"]);
    const many = Array.from({ length: 14 }, (_, i) => `l${i}`);
    expect(importLabels(many, ["keep"])).toHaveLength(10);
    expect(importLabels(many, ["keep"])[0]).toBe("keep");
  });

  it("shows a failure as a warning on the card, which Retry clears", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, sourceUrl: issue });
    s.imports.fail(task.id, "gh is not signed in");
    const failed = s.tasks.summary(task.id);
    expect(failed.import).toMatchObject({ status: "failed", error: "gh is not signed in" });
    expect(failed.attention).toEqual([
      { kind: "import_failed", severity: "warning", message: "Import failed: gh is not signed in" },
    ]);
    expect(s.imports.pending()).toEqual([]);

    s.imports.retry(task.id, "user");
    expect(s.tasks.summary(task.id)).toMatchObject({ import: { status: "pending", error: null }, attention: [] });
    expect(s.imports.pending().map((i) => i.taskId)).toEqual([task.id]);
    // Still pending, which is how a stuck one looks: retrying it starts the count over and is harmless.
    s.imports.claim(task.id);
    s.imports.retry(task.id, "user");
    expect(s.imports.get(task.id)?.attempts).toBe(0);
    s.imports.complete(task.id, { title: "T", description: null, labels: [] });
    expect(codeOf(() => s.imports.retry(task.id, "user"))).toBe("CONFLICT");
  });

  it("cuts a very long reason", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, sourceUrl: issue });
    s.imports.fail(task.id, "x".repeat(1000));
    expect(s.tasks.summary(task.id).import?.error).toHaveLength(400);
  });

  it("claims a pending import once per run, counting attempts", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, sourceUrl: issue });
    expect(s.imports.claim(task.id)?.attempts).toBe(1);
    expect(s.imports.claim(task.id)?.attempts).toBe(2);
    s.imports.complete(task.id, { title: "T", description: null, labels: [] });
    expect(s.imports.claim(task.id)).toBeNull();
  });

  it("is dropped with its task, and not offered for archived tasks", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, sourceUrl: issue });
    s.tasks.update(task.id, { archived: true }, "user");
    expect(s.imports.pending()).toEqual([]);
    s.tasks.delete(task.id, "user");
    expect(s.imports.get(task.id)).toBeNull();
  });
});
