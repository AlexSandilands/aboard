import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, TICKET_SYSTEM_PRESETS, type BoardDump, type PlanInput } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../db/database.ts";
import { AppError } from "../../errors.ts";
import { createTestHarness } from "../../test/harness.ts";
import { EXPORTED_SETTINGS, loadSettings } from "../settings.ts";
import { createRepos } from "../../db/repos/index.ts";
import { dumpFileJson, readDump, readDumpDir, writeDumpDir } from "./files.ts";
import { restoreBoard, restoreBoardLive } from "./restore.ts";

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

const jiraPreset = TICKET_SYSTEM_PRESETS.find((p) => p.system.id === "jira")!.system;

/** A board with a bit of everything a dump has to carry. */
function seed() {
  const h = createTestHarness();
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  s.projects.ensureGeneral();
  s.settings.update({ ticketSystems: [{ ...jiraPreset, linkTemplate: "https://jira.example.com/browse/{key}" }] });
  const a = s.tasks.create({
    projectId: project.id,
    title: "Feature",
    description: "Line one\nline two",
    plan,
    template: "Bug",
    labels: ["ui", "backend"],
    autopilot: true,
    autoMerge: true,
    links: [{ value: "ABC-1" }, { value: "https://github.com/o/r/pull/7" }],
  });
  s.templates.create({
    name: "Weekly review",
    projectId: project.id,
    titlePattern: "Review {{date}}",
    labels: ["ops"],
    phases: [{ title: "Review", steps: [{ title: "Read the board" }] }],
  });
  const b = s.tasks.create({ projectId: project.id, title: "Duplicate", plan, autopilot: false, autoMerge: false });
  s.tasks.close(b.id, { resolution: "duplicate", byTaskId: a.id }, "agent");
  const idea = s.tasks.create({ projectId: project.id, title: "Idea", blockedBy: [a.id] });
  const epic = s.tasks.createEpic({ projectId: project.id, title: "Checkout" }, [idea.id], "agent");
  s.tasks.setDelivery(epic.id, "integration", "epic/4-checkout", "agent");
  s.tasks.addNote(a.id, "handover", "agent");
  s.attention.request(a.id, "Check the plan", "agent");
  s.reviews.submit(
    a.id,
    { summary: "One issue", findings: [{ severity: "major", title: "Bug", file: "x.ts" }] },
    "rev",
  );
  // The reviewer model overrides, so every round trip below carries both columns.
  s.projects.update(project.id, { reviewModel: { tier: "standard" } });
  s.tasks.update(a.id, { reviewModel: { model: "claude-opus-5-5" } }, "agent");
  s.labels.setColor("ui", 120);
  // A recurring rule remembers the task it last made, so it must come back after the tasks.
  const weekly = s.templates.list({ projectId: project.id }).find((t) => t.name === "Weekly review")!;
  const rule = s.recurring.create(project.id, {
    name: "Weekly review",
    templateId: weekly.id,
    schedule: { kind: "weekly", days: [1, 4], time: "09:00" },
    flagAutopilot: true,
  });
  s.recurring.handled(rule.id, { dueAt: "2026-10-12T09:00:00", taskId: a.id });
  // A custom automation and its switch: the switch is an ordinary settings row.
  const custom = s.customAutomations.create({
    name: "Notify",
    trigger: { kind: "status_change", to: "review" },
    filters: { projectIds: [project.id] },
    action: { kind: "shell", command: "./notify.sh" },
  });
  s.autopilot.setScope("board", null, `custom:${custom.id}`, { mode: "on" });
  s.customAutomations.create({
    name: "Check",
    trigger: { kind: "schedule", schedule: { kind: "hourly", everyHours: 6 } },
    action: { kind: "script", language: "python", body: "print(1)\n  # kept as written\n" },
  });
  // An open suggestion: the user hasn't decided yet, so a restore keeps it.
  s.suggestions.suggest(
    {
      target: "builtin:review",
      baseHash: s.suggestions.read("builtin:review").hash,
      proposed: "Be brief.",
      rationale: "Shorter.",
      evidence: ["#1"],
    },
    "improver",
  );
  // Autopilot settings are exported; its runs are history and stay out.
  h.db.exec(`INSERT INTO autopilot_settings (scope_kind, scope_id, automation, mode, config_json, updated_at) VALUES
    ('board', '', 'noop', 'on', '{}', '2026-10-16T00:00:00.000Z'),
    ('project', '${project.id}', 'noop', 'off', '{"days":3}', '2026-10-16T00:00:00.000Z')`);
  s.autopilot.updateEngine({ maxConcurrent: 2, quietHours: { enabled: true } });
  s.autopilot.setPaused(true);
  s.autopilot.record({
    automation: "noop",
    candidate: { dedupeKey: "k", summary: "do it", taskId: a.id },
    dryRun: false,
  });
  s.settings.update({ t3Token: "secret-value", backupDir: "/somewhere" });
  s.settings.update({ keybindings: { back: { key: "q", when: "" } } });
  // Automation variables: the board's are a setting, a project's a column.
  s.settings.update({ automationVariables: [{ name: "jira_key", value: "BRD" }] });
  s.projects.update(project.id, { variables: [{ name: "jira_key", value: "ALP" }] });
  // The pollers' cache, which must stay out of dumps.
  h.db.exec("UPDATE task_links SET snapshot_json = '{\"state\":\"open\"}', synced_at = '2026-10-16T00:00:00.000Z'");
  return { ...h, s, project, a, b, idea };
}

const PRIMARY_KEYS: Record<string, string> = {
  settings: "key",
  projects: "id",
  label_colors: "label",
  counters: "name",
  task_templates: "id",
  autopilot_settings: "scope_kind, scope_id, automation",
  autopilot_recurring: "id",
  autopilot_custom: "id",
  suggestions: "id",
  tasks: "id",
  plan_phases: "id",
  plan_steps: "id",
  task_links: "id",
  task_attachments: "id",
  task_labels: "task_id, label",
  task_relations: "blocker_id, blocked_id",
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
    expect(keys).toContain("ticketSystems");
    expect(keys).toContain("keybindings");
    expect(keys).not.toContain("t3Token");
    expect(keys).not.toContain("backupDir");
    expect(keys).not.toContain("someFutureSecret");
  });

  it("makes every setting a deliberate choice: exported or listed as machine-only", () => {
    // A new setting fails here until it is added to one list or the other.
    const machineOnly = [
      "t3Token",
      "backupEnabled",
      "backupDir",
      "backupRemote",
      "backupIntervalMinutes",
      "machineName",
      "terminal",
      "terminalOpenIn",
      // Goes with its posts, which are never backed up.
      "socialNetwork",
    ];
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
        "relations.json",
        "counters.json",
        "autopilot.json",
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
    const { s, db, a } = seed();
    const dir = tempDir();
    writeDumpDir(dir, s.backup.dump());

    const dbPath = join(tempDir(), "data.sqlite");
    const result = restoreBoard(dbPath, readDumpDir(dir));
    expect(result.previousDb).toBeNull();
    const restored = openDatabase(dbPath);
    try {
      expect(comparableTables(restored)).toEqual(comparableTables(db));
      // Which project is General goes with the board, so the next start doesn't make a second one.
      const general = s.projects.findGeneral();
      expect(general).not.toBeNull();
      expect(createRepos(restored).settings.all().get("generalProjectId")).toBe(general!.id);
      // The Autopilot and auto-merge flags survive: On, Off, and Default (null) for the tasks that never had one.
      expect(restored.prepare("SELECT autopilot, auto_merge FROM tasks ORDER BY number").all()).toEqual([
        { autopilot: 1, auto_merge: 1 },
        { autopilot: 0, auto_merge: 0 },
        { autopilot: null, auto_merge: null },
        { autopilot: null, auto_merge: null },
      ]);
      // An agent's request for attention survives.
      expect(restored.prepare("SELECT attention_message, attention_actor FROM tasks WHERE id = ?").get(a.id)).toEqual({
        attention_message: "Check the plan",
        attention_actor: "agent",
      });
      // An epic's delivery and its branch survive.
      expect(restored.prepare("SELECT delivery, integration_branch FROM tasks WHERE kind = 'epic'").all()).toEqual([
        { delivery: "integration", integration_branch: "epic/4-checkout" },
      ]);
      expect(restored.prepare("SELECT snapshot_json FROM task_links").all()).toEqual(
        expect.arrayContaining([{ snapshot_json: null }]),
      );
      expect(restored.prepare("SELECT 1 FROM settings WHERE key = 't3Token'").get()).toBeUndefined();
      expect(createRepos(restored).settings.all().get("automationVariables")).toEqual([
        { name: "jira_key", value: "BRD" },
      ]);
      expect(
        createRepos(restored)
          .projects.list()
          .find((p) => p.title === "Alpha")?.variables,
      ).toEqual([{ name: "jira_key", value: "ALP" }]);
      expect(restored.prepare("SELECT count(*) AS n FROM autopilot_settings").get()).toEqual({ n: 3 });
      // By name: the two are made in the same millisecond, so their stored order is their random ids'.
      expect(restored.prepare("SELECT name, action_json FROM autopilot_custom ORDER BY name DESC").all()).toEqual([
        {
          name: "Notify",
          action_json: JSON.stringify({ kind: "shell", command: "./notify.sh", timeoutSeconds: 300, inputs: [] }),
        },
        {
          name: "Check",
          action_json: JSON.stringify({
            kind: "script",
            language: "python",
            body: "print(1)\n  # kept as written\n",
            timeoutSeconds: 300,
            inputs: [],
          }),
        },
      ]);
      expect(restored.prepare("SELECT flag_autopilot, last_task_id FROM autopilot_recurring").all()).toEqual([
        { flag_autopilot: 1, last_task_id: a.id },
      ]);
      expect(restored.prepare("SELECT count(*) AS n FROM autopilot_runs").get()).toEqual({ n: 0 });
      const restoredRepos = createRepos(restored);
      // Pause stays with the machine: a restore can't lift it, or set it.
      expect(restoredRepos.settings.all().has("autopilotPaused")).toBe(false);
      expect(restoredRepos.settings.all().get("autopilotEngine")).toMatchObject({ maxConcurrent: 2 });
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

  it("reads a folder written before Recurring tasks, which has no recurring.json", () => {
    const { s } = seed();
    const dir = tempDir();
    writeDumpDir(dir, s.backup.dump());
    expect(readDumpDir(dir).autopilot_recurring).toHaveLength(1);
    rmSync(join(dir, "recurring.json"));
    expect(readDumpDir(dir).autopilot_recurring).toEqual([]);
  });

  it("reads a folder written before suggestions, which has no suggestions.json", () => {
    const { s } = seed();
    const dir = tempDir();
    writeDumpDir(dir, s.backup.dump());
    expect(readDumpDir(dir).suggestions).toHaveLength(1);
    rmSync(join(dir, "suggestions.json"));
    expect(readDumpDir(dir).suggestions).toEqual([]);
  });

  it("keeps a script automation's body as written in the git backup's folder and the dump file", () => {
    const { s } = seed();
    const dir = tempDir();
    const dump = s.backup.dump();
    writeDumpDir(dir, dump);
    const actions = (rows: BoardDump["autopilot_custom"]) => rows.map((row) => JSON.parse(String(row.action_json)));
    const script = {
      kind: "script",
      language: "python",
      body: "print(1)\n  # kept as written\n",
      timeoutSeconds: 300,
      inputs: [],
    };
    expect(actions(readDumpDir(dir).autopilot_custom)).toContainEqual(script);
    const file = join(tempDir(), "dump.json");
    writeFileSync(file, dumpFileJson(dump));
    expect(actions(readDump(file).autopilot_custom)).toContainEqual(script);
  });

  it("reads a folder written before custom automations, which has no custom-automations.json", () => {
    const { s } = seed();
    const dir = tempDir();
    writeDumpDir(dir, s.backup.dump());
    expect(readDumpDir(dir).autopilot_custom).toHaveLength(2);
    rmSync(join(dir, "custom-automations.json"));
    expect(readDumpDir(dir).autopilot_custom).toEqual([]);
  });

  it("reads a folder written before Autopilot, which has no autopilot.json", () => {
    const { s } = seed();
    const dir = tempDir();
    writeDumpDir(dir, s.backup.dump());
    rmSync(join(dir, "autopilot.json"));
    expect(readDumpDir(dir).autopilot_settings).toEqual([]);
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

  it("reads a folder written before templates existed, with no templates.json", () => {
    const { s, db } = seed();
    const dir = tempDir();
    writeDumpDir(dir, s.backup.dump());
    rmSync(join(dir, "templates.json"));
    const dump = readDumpDir(dir);
    expect(dump.task_templates).toEqual([]);
    const dbPath = join(tempDir(), "data.sqlite");
    // An older manifest doesn't count templates, and its tasks and recurring rules don't point at any.
    const { task_templates: _n, autopilot_recurring: _r, ...counts } = dump.manifest.counts;
    const tasks = dump.tasks.map((b) => ({ ...b, task: { ...b.task, template_id: null } }));
    restoreBoard(dbPath, { ...dump, manifest: { ...dump.manifest, counts }, autopilot_recurring: [], tasks });
    const restored = openDatabase(dbPath);
    try {
      expect(restored.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual(
        db.prepare("SELECT count(*) AS n FROM tasks").get(),
      );
    } finally {
      restored.close();
    }
  });

  it("restores a dump taken at an older schema and migrates it forward", () => {
    const { s, a } = seed();
    const dump = s.backup.dump();
    // The board as 005 had it: "idea" instead of "backlog", no suggested model, epic, Autopilot flag, auto-merge,
    // priority, manual or attention request columns, no project planning skill, no relations, no Autopilot settings.
    const {
      autopilot_settings: _a,
      autopilot_recurring: _rc,
      autopilot_custom: _cu,
      suggestions: _sg,
      task_relations: _rel,
      ...counts
    } = dump.manifest.counts;
    const old: BoardDump = {
      ...dump,
      manifest: { ...dump.manifest, schemaVersion: "005_task_labels.sql", counts },
      task_templates: [],
      task_relations: [],
      autopilot_settings: [],
      autopilot_recurring: [],
      autopilot_custom: [],
      suggestions: [],
      projects: dump.projects.map(
        ({ plan_skill_json: _ps, variables_json: _v, review_model_json: _rm, ...project }) => project,
      ),
      tasks: dump.tasks.map((bundle) => {
        const {
          suggested_tier: _t,
          suggested_reason: _r,
          kind: _k,
          parent_id: _p,
          autopilot: _f,
          priority: _pr,
          manual: _mn,
          due_date: _dd,
          auto_merge: _am,
          review_model_json: _rm,
          template_id: _m,
          delivery: _d,
          integration_branch: _b,
          integration_merged_at: _im,
          attention_message: _atm,
          attention_actor: _aa,
          attention_requested_at: _at,
          ...task
        } = bundle.task;
        return { ...bundle, task: { ...task, status: task.status === "backlog" ? "idea" : (task.status ?? null) } };
      }),
      task_events: dump.task_events.map((e) =>
        e.type === "created" ? { ...e, payload_json: String(e.payload_json).replace('"backlog"', '"idea"') } : e,
      ),
    };
    // Before ticket systems: Jira links and a Jira base URL.
    old.settings = [
      ...dump.settings.filter((r) => r.key !== "ticketSystems"),
      { key: "jiraBaseUrl", value_json: '"https://jira.example.com"' },
      // Before the reviewer model was shared with the review subagent.
      { key: "headlessReviewModel", value_json: '{"tier":"deep"}' },
    ];
    old.manifest.counts.settings = old.settings.length;
    old.tasks = old.tasks.map((bundle) => ({
      ...bundle,
      task_links: bundle.task_links.map(({ auto: _auto, ...link }) =>
        link.kind === "ticket"
          ? { ...link, kind: "jira", ref_json: JSON.stringify({ key: JSON.parse(String(link.ref_json)).key }) }
          : link,
      ),
    }));
    expect(old.tasks.some((b) => b.task.status === "idea")).toBe(true);

    const dbPath = join(tempDir(), "data.sqlite");
    restoreBoard(dbPath, old);
    const restored = openDatabase(dbPath);
    try {
      const statuses = restored.prepare("SELECT status FROM tasks").all() as Array<{ status: string }>;
      expect(statuses.map((r) => r.status)).not.toContain("idea");
      // The migrations after the dump's schema seed the starter templates.
      const names = restored.prepare("SELECT name FROM task_templates ORDER BY name").all();
      expect(names).toEqual([{ name: "Bug" }, { name: "Feature" }, { name: "Spike" }]);
      const created = restored
        .prepare("SELECT payload_json FROM task_events WHERE task_id = ? AND type = 'created'")
        .get(a.id) as { payload_json: string };
      expect(created.payload_json).not.toContain("idea");
      expect(
        restored.prepare("SELECT kind, ref_json FROM task_links WHERE task_id = ? ORDER BY kind").all(a.id),
      ).toEqual([
        { kind: "pr", ref_json: expect.any(String) },
        { kind: "ticket", ref_json: '{"system":"jira","key":"ABC-1"}' },
      ]);
      const systems = restored.prepare("SELECT value_json FROM settings WHERE key = 'ticketSystems'").get() as {
        value_json: string;
      };
      expect(JSON.parse(systems.value_json)).toEqual([
        expect.objectContaining({ id: "jira", linkTemplate: "https://jira.example.com/browse/{key}" }),
      ]);
      expect(restored.prepare("SELECT key FROM settings WHERE key = 'jiraBaseUrl'").get()).toBeUndefined();
      expect(restored.prepare("SELECT key, value_json FROM settings WHERE key LIKE '%eviewModel'").all()).toEqual([
        { key: "reviewModel", value_json: '{"tier":"deep"}' },
      ]);
      expect(restored.prepare("SELECT max(name) AS v FROM migrations").get()).toEqual({
        v: dump.manifest.schemaVersion,
      });
    } finally {
      restored.close();
    }
  });
});

describe("backups from before relations existed", () => {
  it("reads a folder with no relations.json and a single file with no task_relations", () => {
    const { s } = seed();
    const dump = s.backup.dump();
    const { task_relations: _r, ...counts } = dump.manifest.counts;
    const oldManifest = { ...dump.manifest, counts };

    const dir = tempDir();
    writeDumpDir(dir, { ...dump, manifest: oldManifest });
    rmSync(join(dir, "relations.json"));
    const fromFolder = readDumpDir(dir);
    expect(fromFolder.task_relations).toEqual([]);

    const file = join(tempDir(), "board.json");
    const { task_relations: _t, ...bare } = dump;
    writeFileSync(file, JSON.stringify({ ...bare, manifest: oldManifest }));
    expect(readDump(file).task_relations).toEqual([]);

    const restored = join(tempDir(), "data.sqlite");
    restoreBoard(restored, fromFolder);
    const db = openDatabase(restored);
    try {
      expect(db.prepare("SELECT count(*) AS n FROM task_relations").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: dump.tasks.length });
    } finally {
      db.close();
    }
  });
});

describe("backup routes", () => {
  it("refuses to restore without a backup repo, and a whole-board restore that isn't confirmed", async () => {
    const { request } = seed();
    expect((await request("/api/backup/history")).status).toBe(400);
    expect((await request("/api/backup/diff?commit=HEAD")).status).toBe(400);
    const unconfirmed = await request("/api/backup/restore-board", { method: "POST", json: { confirm: "yes" } });
    expect(unconfirmed.status).toBe(400);
    const tasks = await request("/api/backup/restore-tasks", { method: "POST", json: { numbers: [1] } });
    expect(tasks.status).toBe(400);
  });

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

  it("puts back what it blocked, and keeps current relations when it replaces a task", () => {
    const { s, a, idea } = seed();
    const dump = s.backup.dump();
    s.tasks.update(a.id, { archived: true }, "user");
    s.tasks.delete(a.id, "user");
    expect(s.tasks.summary(idea.id).blockedBy).toEqual([]);
    s.backup.restoreTask(dump, a.number, { actor: "user" });
    expect(s.tasks.summary(idea.id).blockedBy.map((t) => t.id)).toEqual([a.id]);

    // The relation changed since the backup: a forced restore leaves it as it is now.
    s.tasks.update(idea.id, { removeBlockedBy: [a.id] }, "user");
    s.backup.restoreTask(dump, a.number, { actor: "user", force: true });
    expect(s.tasks.summary(idea.id).blockedBy).toEqual([]);
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

describe("diff", () => {
  it("lists tasks missing from the board and tasks that changed, and nothing for an unchanged board", () => {
    const { s, a, b } = seed();
    const dump = s.backup.dump();
    expect(s.backup.diff(dump)).toEqual({
      counts: { backup: dump.tasks.length, board: dump.tasks.length, missing: 0, changed: 0 },
      tasks: [],
    });

    s.tasks.update(a.id, { title: "Feature, renamed" }, "user");
    s.tasks.update(b.id, { archived: true }, "user");
    s.tasks.delete(b.id, "user");
    const diff = s.backup.diff(dump);
    expect(diff.counts).toMatchObject({ missing: 1, changed: 1, board: dump.tasks.length - 1 });
    expect(diff.tasks).toEqual([
      expect.objectContaining({ number: a.number, title: "Feature", change: "changed", projectOnBoard: true }),
      expect.objectContaining({ number: b.number, title: "Duplicate", change: "missing", projectName: "Alpha" }),
    ]);
  });
});

describe("restoreBoardLive", () => {
  /** The seeded board in a database file, as the server has it open. */
  function fileBoard() {
    const { s, a, idea } = seed();
    const dump = s.backup.dump();
    const dbPath = join(tempDir(), "data.sqlite");
    restoreBoard(dbPath, dump);
    return { dump, dbPath, db: openDatabase(dbPath), a, idea };
  }

  it("replaces the open board with the backup, keeps machine settings and a safety copy of what it replaced", () => {
    const { dump, dbPath, db, a } = fileBoard();
    try {
      const before = comparableTables(db);
      const repos = createRepos(db);
      repos.settings.set("t3Token", "kept-value");
      db.prepare("UPDATE tasks SET title = 'Changed since' WHERE id = ?").run(a.id);
      db.prepare("DELETE FROM projects").run();

      const result = restoreBoardLive(db, dump, new Date("2026-11-03T10:00:00Z"));
      expect(result.safetyCopy).toBe(`${dbPath}.before-restore-2026-11-03T10-00-00-000Z`);
      expect(comparableTables(db)).toEqual(before);
      expect(repos.settings.all().get("t3Token")).toBe("kept-value");
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

      const copy = openDatabase(result.safetyCopy!);
      try {
        expect(copy.prepare("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 0 });
      } finally {
        copy.close();
      }
    } finally {
      db.close();
    }
  });

  it("keeps notifications of tasks that come back and drops those of tasks that don't", () => {
    const { dump, db, a } = fileBoard();
    try {
      const insert = db.prepare(
        "INSERT INTO notifications (id, kind, task_id, title, body, created_at, dedupe_key) VALUES (?, 'task_done', ?, 't', 'b', '2026-01-01', ?)",
      );
      // A task made since the backup: a copy of one under a new id and number.
      const {
        id: _id,
        number: _n,
        ...row
      } = db.prepare("SELECT * FROM tasks WHERE id = ?").get(a.id) as Record<string, string>;
      const columns = ["id", "number", ...Object.keys(row)];
      db.prepare(`INSERT INTO tasks (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
        "new",
        99,
        ...Object.values(row),
      );
      insert.run("n1", a.id, "k1");
      insert.run("n2", "new", "k2");

      restoreBoardLive(db, dump);
      expect(db.prepare("SELECT id FROM notifications ORDER BY id").all()).toEqual([{ id: "n1" }]);
      expect(db.prepare("SELECT 1 FROM tasks WHERE id = 'new'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("rolls back on a failed check and leaves the board as it was", () => {
    const { dump, db } = fileBoard();
    try {
      db.prepare("UPDATE tasks SET title = 'Changed since'").run();
      const before = comparableTables(db);
      const broken: BoardDump = {
        ...dump,
        manifest: { ...dump.manifest, counts: { ...dump.manifest.counts, plan_steps: 1 } },
      };
      expectCode(() => restoreBoardLive(db, broken), "VALIDATION");
      expectCode(() => restoreBoardLive(db, { ...dump, projects: [] }), "VALIDATION");
      expect(comparableTables(db)).toEqual(before);
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    } finally {
      db.close();
    }
  });

  it("publishes board.reset when the service restores the board", () => {
    const { s, a, events } = seed();
    const dump = s.backup.dump();
    s.tasks.update(a.id, { title: "Changed since" }, "user");
    events.length = 0;
    const result = s.backup.restoreBoard(dump, { attachmentsFrom: null });
    expect(result.safetyCopy).toBeNull();
    expect(s.tasks.detail(a.id).title).toBe("Feature");
    expect(events).toEqual([{ type: "board.reset" }]);
  });
});
