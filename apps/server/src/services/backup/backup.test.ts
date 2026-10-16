import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, type BoardDump, type PlanInput } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../db/database.ts";
import { AppError } from "../../errors.ts";
import { createTestHarness } from "../../test/harness.ts";
import { EXPORTED_SETTINGS, loadSettings } from "../settings.ts";
import { createRepos } from "../../db/repos/index.ts";
import { dumpFileJson, readDump, readDumpDir, writeDumpDir } from "./files.ts";
import { restoreBoard } from "./restore.ts";

const plan: PlanInput = {
  phases: [
    { title: "Build", steps: [{ title: "a" }, { title: "b" }] },
    { title: "Ship", steps: [{ title: "c" }] },
  ],
};

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), `${BRAND.id}-backup-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A board with a bit of everything a dump has to carry. */
function seed() {
  const h = createTestHarness();
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const a = s.tasks.create({
    projectId: project.id,
    title: "Feature",
    description: "Line one\nline two",
    plan,
    template: "Bug",
    labels: ["ui", "backend"],
    links: [{ value: "ABC-1" }, { value: "https://github.com/o/r/pull/7" }],
  });
  s.templates.create({
    name: "Weekly review",
    projectId: project.id,
    titlePattern: "Review {{date}}",
    labels: ["ops"],
    phases: [{ title: "Review", steps: [{ title: "Read the board" }] }],
  });
  const b = s.tasks.create({ projectId: project.id, title: "Duplicate", plan });
  s.tasks.close(b.id, { resolution: "duplicate", byTaskId: a.id }, "agent");
  s.tasks.create({ projectId: project.id, title: "Idea" });
  s.tasks.addNote(a.id, "handover", "agent");
  s.reviews.submit(
    a.id,
    { summary: "One issue", findings: [{ severity: "major", title: "Bug", file: "x.ts" }] },
    "rev",
  );
  s.labels.setColor("ui", 120);
  s.settings.update({ jiraBaseUrl: "https://jira.example.com", t3Token: "secret-value", backupDir: "/somewhere" });
  // The pollers' cache, which must stay out of dumps.
  h.db.exec("UPDATE task_links SET snapshot_json = '{\"state\":\"open\"}', synced_at = '2026-10-16T00:00:00.000Z'");
  return { ...h, s, project, a, b };
}

const PRIMARY_KEYS: Record<string, string> = {
  settings: "key",
  projects: "id",
  label_colors: "label",
  counters: "name",
  task_templates: "id",
  tasks: "id",
  plan_phases: "id",
  plan_steps: "id",
  task_links: "id",
  task_labels: "task_id, label",
  task_reviews: "id",
  review_findings: "id",
  task_events: "id",
};

/** Every table's rows as a restore should reproduce them: no link cache, only exported settings. */
function comparableTables(db: Db) {
  return Object.fromEntries(
    Object.entries(PRIMARY_KEYS).map(([table, pk]) => {
      let rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${pk}`).all() as Array<Record<string, unknown>>;
      if (table === "task_links") rows = rows.map(({ snapshot_json: _s, synced_at: _t, ...r }) => r);
      if (table === "settings") rows = rows.filter((r) => EXPORTED_SETTINGS.has(String(r.key)));
      return [table, rows];
    }),
  );
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

const readTree = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((p) => p.endsWith(".json"))
      .map((p) => [p.replaceAll("\\", "/"), readFileSync(join(dir, p), "utf8")]),
  );

describe("settings export", () => {
  it("exports an allow-list: secrets, machine settings and unknown keys stay out", () => {
    const { s, db } = seed();
    db.prepare("INSERT INTO settings (key, value_json) VALUES ('someFutureSecret', '\"x\"')").run();
    const keys = s.backup.dump().settings.map((r) => r.key);
    expect(keys).toContain("jiraBaseUrl");
    expect(keys).not.toContain("t3Token");
    expect(keys).not.toContain("backupDir");
    expect(keys).not.toContain("someFutureSecret");
  });

  it("makes every setting a deliberate choice: exported or listed as machine-only", () => {
    // A new setting fails here until it is added to one list or the other.
    const machineOnly = ["t3Token", "backupEnabled", "backupDir", "backupRemote", "backupIntervalMinutes"];
    const all = Object.keys(loadSettings(createRepos(openDatabase(":memory:"))));
    expect(all.filter((k) => !EXPORTED_SETTINGS.has(k)).sort()).toEqual(machineOnly.sort());
  });
});

describe("dump", () => {
  it("writes a deterministic folder sharded by task and month", () => {
    const { s, a } = seed();
    const dir = tempDir();
    writeDumpDir(dir, s.backup.dump());
    const first = readTree(dir);
    expect(Object.keys(first).sort()).toEqual(
      expect.arrayContaining([
        "manifest.json",
        "settings.json",
        "projects.json",
        "labels.json",
        "counters.json",
        `tasks/${a.createdAt.slice(0, 7)}/task-${a.number}.json`,
        `events/${a.createdAt.slice(0, 7)}.json`,
      ]),
    );
    const taskFile = first[`tasks/${a.createdAt.slice(0, 7)}/task-${a.number}.json`]!;
    expect(taskFile).not.toContain("snapshot_json");
    expect(taskFile.endsWith("}\n")).toBe(true);

    expect(writeDumpDir(dir, s.backup.dump())).toEqual({ written: [], removed: [] });
    expect(readTree(dir)).toEqual(first);
  });

  it("ignores the link cache and rewrites only the task that changed", () => {
    const { s, db, a } = seed();
    const dir = tempDir();
    writeDumpDir(dir, s.backup.dump());

    db.exec("UPDATE task_links SET snapshot_json = '{\"state\":\"merged\"}', synced_at = '2026-10-17T00:00:00.000Z'");
    expect(writeDumpDir(dir, s.backup.dump()).written).toEqual([]);

    // A direct edit, so no event row changes the events file or manifest counts.
    db.prepare(
      "UPDATE plan_steps SET title = 'renamed' WHERE id = (SELECT id FROM plan_steps WHERE task_id = ? LIMIT 1)",
    ).run(a.id);
    expect(writeDumpDir(dir, s.backup.dump()).written).toEqual([
      `tasks/${a.createdAt.slice(0, 7)}/task-${a.number}.json`,
    ]);
  });

  it("removes temp files a crash left behind", () => {
    const { s } = seed();
    const dir = tempDir();
    writeDumpDir(dir, s.backup.dump());
    writeFileSync(join(dir, "projects.json.tmp"), "partial");
    const taskFile = Object.keys(readTree(dir)).find((p) => p.startsWith("tasks/"));
    writeFileSync(join(dir, `${taskFile!}.tmp`), "partial");
    writeDumpDir(dir, s.backup.dump());
    const left = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((p) => p.endsWith(".tmp"));
    expect(left).toEqual([]);
  });

  it("removes the file of a deleted task", () => {
    const { s, b } = seed();
    const dir = tempDir();
    writeDumpDir(dir, s.backup.dump());
    s.tasks.update(b.id, { archived: true }, "user");
    s.tasks.delete(b.id, "user");
    const { removed } = writeDumpDir(dir, s.backup.dump());
    expect(removed).toEqual([`tasks/${b.createdAt.slice(0, 7)}/task-${b.number}.json`]);
  });
});

describe("restore", () => {
  it("round-trips a board through a folder into a new database", () => {
    const { s, db } = seed();
    const dir = tempDir();
    writeDumpDir(dir, s.backup.dump());

    const dbPath = join(tempDir(), "data.sqlite");
    const result = restoreBoard(dbPath, readDumpDir(dir));
    expect(result.previousDb).toBeNull();
    const restored = openDatabase(dbPath);
    try {
      expect(comparableTables(restored)).toEqual(comparableTables(db));
      expect(restored.prepare("SELECT snapshot_json FROM task_links").all()).toEqual(
        expect.arrayContaining([{ snapshot_json: null }]),
      );
      expect(restored.prepare("SELECT 1 FROM settings WHERE key = 't3Token'").get()).toBeUndefined();
    } finally {
      restored.close();
    }
  });

  it("round-trips through the single-file form", () => {
    const { s, db } = seed();
    const file = join(tempDir(), "board.json");
    writeFileSync(file, dumpFileJson(s.backup.dump()));
    const dbPath = join(tempDir(), "data.sqlite");
    restoreBoard(dbPath, readDump(file));
    const restored = openDatabase(dbPath);
    try {
      expect(comparableTables(restored)).toEqual(comparableTables(db));
    } finally {
      restored.close();
    }
  });

  it("refuses to replace a board without force, and keeps machine settings and the old file when forced", () => {
    const { s } = seed();
    const dump = s.backup.dump();
    const dbPath = join(tempDir(), "data.sqlite");
    const existing = openDatabase(dbPath);
    const other = createRepos(existing);
    existing
      .prepare("INSERT INTO projects (id, title, position, created_at, updated_at) VALUES ('p', 'P', 'a0', '', '')")
      .run();
    other.settings.set("t3Token", "kept-value");
    existing.close();

    expectCode(() => restoreBoard(dbPath, dump), "CONFLICT");
    const result = restoreBoard(dbPath, dump, { force: true });
    expect(result.previousDb).toMatch(/data\.sqlite\.before-restore-/);

    const restored = openDatabase(dbPath);
    try {
      expect(restored.prepare("SELECT value_json FROM settings WHERE key = 't3Token'").get()).toEqual({
        value_json: '"kept-value"',
      });
      expect(restored.prepare("SELECT 1 FROM projects WHERE id = 'p'").get()).toBeUndefined();
    } finally {
      restored.close();
    }
  });

  it("rejects dumps from another app, format or a newer schema, and rolls back on a count mismatch", () => {
    const { s } = seed();
    const dump = s.backup.dump();
    const dbPath = join(tempDir(), "data.sqlite");
    const withManifest = (patch: Partial<BoardDump["manifest"]>): BoardDump => ({
      ...dump,
      manifest: { ...dump.manifest, ...patch },
    });
    expectCode(() => restoreBoard(dbPath, withManifest({ app: "other" })), "VALIDATION");
    expectCode(() => restoreBoard(dbPath, withManifest({ format: 99 })), "VALIDATION");
    expectCode(() => restoreBoard(dbPath, withManifest({ schemaVersion: "999_future.sql" })), "VALIDATION");
    expectCode(
      () => restoreBoard(dbPath, withManifest({ counts: { ...dump.manifest.counts, plan_steps: 1 } })),
      "VALIDATION",
    );
    expectCode(() => restoreBoard(dbPath, { ...dump, projects: [] }), "VALIDATION");
    expect(readdirSync(join(dbPath, ".."))).toEqual([]);
  });

  it("restores a dump taken at an older schema and migrates it forward", () => {
    const { s, a } = seed();
    const dump = s.backup.dump();
    // The board as 005 had it: "idea" instead of "backlog", no suggested model or epic columns.
    const old: BoardDump = {
      ...dump,
      manifest: { ...dump.manifest, schemaVersion: "005_task_labels.sql" },
      task_templates: [],
      tasks: dump.tasks.map((bundle) => {
        const {
          suggested_tier: _t,
          suggested_reason: _r,
          kind: _k,
          parent_id: _p,
          template_id: _m,
          ...task
        } = bundle.task;
        return { ...bundle, task: { ...task, status: task.status === "backlog" ? "idea" : (task.status ?? null) } };
      }),
      task_events: dump.task_events.map((e) =>
        e.type === "created" ? { ...e, payload_json: String(e.payload_json).replace('"backlog"', '"idea"') } : e,
      ),
    };
    expect(old.tasks.some((b) => b.task.status === "idea")).toBe(true);

    const dbPath = join(tempDir(), "data.sqlite");
    restoreBoard(dbPath, old);
    const restored = openDatabase(dbPath);
    try {
      const statuses = restored.prepare("SELECT status FROM tasks").all() as Array<{ status: string }>;
      expect(statuses.map((r) => r.status)).not.toContain("idea");
      const created = restored
        .prepare("SELECT payload_json FROM task_events WHERE task_id = ? AND type = 'created'")
        .get(a.id) as { payload_json: string };
      expect(created.payload_json).not.toContain("idea");
      expect(restored.prepare("SELECT max(name) AS v FROM migrations").get()).toEqual({
        v: dump.manifest.schemaVersion,
      });
    } finally {
      restored.close();
    }
  });
});

describe("backup routes", () => {
  it("serves the status, reports a run without a folder, and restores a task over HTTP", async () => {
    const { s, a, request } = seed();
    s.settings.update({ backupDir: "" });
    expect(await (await request("/api/backup/status")).json()).toMatchObject({ lastRunAt: null, running: false });
    const run = (await (await request("/api/backup/run", { method: "POST" })).json()) as { lastError: string };
    expect(run.lastError).toMatch(/backup folder/);

    const dump = s.backup.dump();
    s.tasks.update(a.id, { archived: true }, "user");
    s.tasks.delete(a.id, "user");
    const res = await request("/api/backup/restore-task", { method: "POST", json: { dump, number: a.number } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ taskId: a.id, number: a.number });
    const again = await request("/api/backup/restore-task", { method: "POST", json: { dump, number: a.number } });
    expect(again.status).toBe(409);
  });
});

describe("restoreTask", () => {
  it("puts a deleted task back with its plan, links, labels, reviews and history", () => {
    const { s, a, events } = seed();
    const dump = s.backup.dump();
    const before = s.tasks.detail(a.id);
    s.tasks.update(a.id, { archived: true }, "user");
    s.tasks.delete(a.id, "user");

    events.length = 0;
    const result = s.backup.restoreTask(dump, a.number, { actor: "user" });
    expect(result).toEqual({ taskId: a.id, number: a.number });
    const after = s.tasks.detail(a.id);
    expect(after.phases).toEqual(before.phases);
    expect(after.reviews).toEqual(before.reviews);
    expect(after.labels).toEqual(before.labels);
    expect(after.links.map((l) => l.url)).toEqual(before.links.map((l) => l.url));
    expect(after.events.at(-1)).toMatchObject({ type: "restored", actor: "user" });
    expect(events.some((e) => e.type === "task.upserted")).toBe(true);
  });

  it("brings a task back without its template when the template has been deleted since", () => {
    const { s, db, a } = seed();
    const dump = s.backup.dump();
    const bug = s.templates.list().find((t) => t.name === "Bug")!;
    expect(db.prepare("SELECT template_id FROM tasks WHERE id = ?").get(a.id)).toEqual({ template_id: bug.id });
    s.tasks.update(a.id, { archived: true }, "user");
    s.tasks.delete(a.id, "user");
    s.templates.delete(bug.id);
    s.backup.restoreTask(dump, a.number, { actor: "user" });
    expect(db.prepare("SELECT template_id FROM tasks WHERE id = ?").get(a.id)).toEqual({ template_id: null });
  });

  it("refuses a task still on the board unless forced, and renumbers on a number clash", () => {
    const { s, db, a, b } = seed();
    const dump = s.backup.dump();
    expectCode(() => s.backup.restoreTask(dump, a.number, { actor: "user" }), "CONFLICT");
    expect(s.backup.restoreTask(dump, a.number, { actor: "user", force: true }).number).toBe(a.number);
    // b was closed as a duplicate of a; replacing a keeps that link.
    expect(s.tasks.detail(b.id).resolvedBy?.id).toBe(a.id);

    s.tasks.update(a.id, { archived: true }, "user");
    s.tasks.delete(a.id, "user");
    // Another task now holds the number (as if the counter had been reset).
    db.prepare("UPDATE tasks SET number = ? WHERE id = ?").run(a.number, b.id);
    const restored = s.backup.restoreTask(dump, a.number, { actor: "user" });
    expect(restored.number).toBeGreaterThan(b.number);
    expectCode(() => s.backup.restoreTask(dump, 999, { actor: "user" }), "NOT_FOUND");
  });

  it("puts a task back into its epic, or loose when the epic is gone, and keeps a replaced epic's tasks", () => {
    const { s, project } = seed();
    const epic = s.tasks.create({ projectId: project.id, title: "Epic", kind: "epic" });
    const child = s.tasks.create({ projectId: project.id, title: "Child", plan, epicId: epic.id });
    const dump = s.backup.dump();

    s.tasks.update(child.id, { archived: true }, "user");
    s.tasks.delete(child.id, "user");
    expect(s.tasks.summary(epic.id).status).toBe("backlog");
    s.backup.restoreTask(dump, child.number, { actor: "user" });
    expect(s.tasks.summary(child.id).parent?.id).toBe(epic.id);
    expect(s.tasks.summary(epic.id).status).toBe("planned");

    // Replacing the epic keeps its tasks in it.
    s.backup.restoreTask(dump, epic.number, { actor: "user", force: true });
    expect(s.tasks.summary(child.id).parent?.id).toBe(epic.id);

    // With the epic gone, the task comes back loose.
    s.tasks.update(child.id, { archived: true }, "user");
    s.tasks.delete(child.id, "user");
    s.tasks.update(epic.id, { archived: true }, "user");
    s.tasks.delete(epic.id, "user");
    s.backup.restoreTask(dump, child.number, { actor: "user" });
    expect(s.tasks.summary(child.id).parent).toBeNull();
  });

  it("leaves out of a restored epic any task that moved to another project since", () => {
    const { s, project } = seed();
    const other = s.projects.create({ title: "Other", workspaceRoot: "/work/other" });
    const epic = s.tasks.create({ projectId: project.id, title: "Epic", kind: "epic" });
    const stays = s.tasks.create({ projectId: project.id, title: "Stays", plan, epicId: epic.id });
    const moves = s.tasks.create({ projectId: project.id, title: "Moves", plan, epicId: epic.id });
    const dump = s.backup.dump();

    // The epic moves (taking its tasks along), then one task comes back to the first project in it.
    s.tasks.update(epic.id, { projectId: other.id }, "user");
    s.tasks.update(stays.id, { projectId: project.id, epicId: null }, "user");
    s.tasks.update(stays.id, { projectId: other.id, epicId: epic.id }, "user");
    s.backup.restoreTask(dump, epic.number, { actor: "user", force: true });
    // The restored epic is back in the first project; its tasks that are now elsewhere stay loose.
    expect(s.tasks.summary(epic.id).projectId).toBe(project.id);
    expect(s.tasks.summary(moves.id).parent).toBeNull();
    expect(s.tasks.summary(stays.id).parent).toBeNull();
  });
});
