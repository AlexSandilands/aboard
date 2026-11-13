import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { renderTaskDetail } from "../mcp/format.ts";
import { TEST_JIRA } from "../test/fixtures.ts";
import { createTestHarness } from "../test/harness.ts";
import { importLabels } from "./imports.ts";

function setup() {
  const h = createTestHarness();
  const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  h.services.settings.update({ ticketSystems: [TEST_JIRA] });
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

  it("links a ticket key once, however it is written", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, sourceUrl: "https://other.example.com/browse/PROJ-7" });
    expect(task.title).toBe("PROJ-7");
    expect(task.import?.status).toBe("pending");
    s.links.add(task.id, { value: "PROJ-7" }, "user");
    expect(s.tasks.detail(task.id).links.filter((l) => l.kind === "ticket")).toHaveLength(1);
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
    expect(failed.attention).toMatchObject([
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
    s.tasks.delete([task.id], {}, "user");
    s.tasks.purge([task.id], "user");
    expect(s.imports.get(task.id)).toBeNull();
  });
});

describe("importing a milestone", () => {
  const milestone = "https://github.com/acme/app/milestone/7";
  const gh = (n: number) => `https://github.com/acme/app/issues/${n}`;
  const result = (children: string[], total = children.length) => ({
    title: "Checkout v2",
    description: "Ship the new checkout.",
    labels: [],
    epic: { children, total },
  });
  const notes = (task: { events: Array<{ type: string; payload: Record<string, unknown> }> }) =>
    task.events.filter((e) => e.type === "note").map((e) => String(e.payload.text));

  it("titles it after the milestone and links the page as a plain url", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, sourceUrl: milestone });
    expect(task).toMatchObject({ title: "acme/app milestone 7", import: { status: "pending" } });
    expect(task.links).toEqual([expect.objectContaining({ kind: "url", url: milestone })]);
    expect(s.imports.get(task.id)?.sourceKind).toBe("milestone");
  });

  it("becomes an epic of its open issues, each a pending import of its own", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, sourceUrl: milestone });
    const { childImports } = s.imports.complete(task.id, result([gh(1), gh(2), gh(1), "PROJ-9", "nonsense"]));
    const epic = s.tasks.detail(task.id);
    expect(epic).toMatchObject({ kind: "epic", title: "Checkout v2", import: { status: "done" } });
    expect(childImports).toHaveLength(2);
    expect(epic.children.map((c) => [c.title, c.import?.status])).toEqual([
      ["acme/app#1", "pending"],
      ["acme/app#2", "pending"],
    ]);
    // A milestone holds GitHub issues: anything else in its list is dropped.
    expect(notes(epic)).toEqual(["Skipped 2 child issues that weren't a GitHub issue."]);
  });

  it("moves a loose task already linked to one of its issues in, and leaves one in another epic", () => {
    const { s, project } = setup();
    const loose = s.tasks.create({ projectId: project.id, sourceUrl: gh(1) });
    const other = s.tasks.createEpic({ projectId: project.id, title: "Other" }, [], "user");
    const placed = s.tasks.create({ projectId: project.id, sourceUrl: gh(2), epicId: other.id });
    const task = s.tasks.create({ projectId: project.id, sourceUrl: milestone });
    const { childImports } = s.imports.complete(task.id, result([gh(1), gh(2), gh(3)]));
    expect(childImports).toHaveLength(1);
    expect(s.tasks.summary(loose.id).parent?.id).toBe(task.id);
    expect(s.tasks.summary(placed.id).parent?.id).toBe(other.id);
    expect(notes(s.tasks.detail(task.id))).toEqual([
      `Already on the board, so moved into this epic: #${loose.number}.\n\nLeft where they are, not added: acme/app#2 (#${placed.number} is in epic #${other.number}).`,
    ]);
  });

  it("imports the first 50 open issues and says how many there are", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, sourceUrl: milestone });
    const children = Array.from({ length: 50 }, (_, i) => gh(i + 1));
    expect(s.imports.complete(task.id, result(children, 80)).childImports).toHaveLength(50);
    expect(notes(s.tasks.detail(task.id))).toEqual([
      "acme/app milestone 7 has 80 open issues; only the first 50 were imported. Add the rest by pasting their keys or URLs.",
    ]);
  });

  it("stays a task with a note when it has no open issues", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, sourceUrl: milestone });
    expect(s.imports.complete(task.id, result([])).childImports).toEqual([]);
    const done = s.tasks.detail(task.id);
    expect(done).toMatchObject({ kind: "task", title: "Checkout v2", import: { status: "done" } });
    expect(notes(done)).toEqual([
      "acme/app milestone 7 has no open issues, so it was imported as a task. Paste it again once it has some.",
    ]);
  });

  it("stays a task with a note when the task can't become an epic", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, sourceUrl: milestone });
    s.tasks.update(task.id, { priority: true }, "user");
    expect(s.imports.complete(task.id, result([gh(1), gh(2)])).childImports).toEqual([]);
    const done = s.tasks.detail(task.id);
    expect(done.kind).toBe("task");
    expect(notes(done)).toEqual([
      "acme/app milestone 7 has 2 open issues, but this task can't become an epic: it is a priority. Its issues weren't imported.",
    ]);
  });
});
