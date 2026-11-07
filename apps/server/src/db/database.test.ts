import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.ts";

describe("migrations", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("seeds the task number counter from existing tasks", () => {
    dir = mkdtempSync(join(tmpdir(), "board-db-"));
    const path = join(dir, "board.db");
    const db = openDatabase(path);
    // Rewind to before 003 with a task already numbered 41, as an upgraded install would be.
    db.exec(`
      DROP TABLE counters;
      DELETE FROM migrations WHERE name = '003_task_number_counter.sql';
      INSERT INTO projects (id, title, position, created_at, updated_at) VALUES ('p', 'P', 'a0', '', '');
      INSERT INTO tasks (id, number, project_id, title, status, position, created_by, created_at, updated_at, status_changed_at)
        VALUES ('t', 41, 'p', 'T', 'backlog', 'a0', 'user', '', '', '');
    `);
    db.close();

    const reopened = openDatabase(path);
    const row = reopened.prepare("SELECT value FROM counters WHERE name = 'task_number'").get() as { value: number };
    reopened.close();
    expect(row.value).toBe(41);
  });

  it("renames the idea status to backlog without losing child rows", () => {
    dir = mkdtempSync(join(tmpdir(), "board-db-"));
    const path = join(dir, "board.db");
    // Build the database as it stood before 006, the way an upgraded install has it.
    const old = new DatabaseSync(path);
    old.exec("PRAGMA foreign_keys = ON");
    old.exec("CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const migrationsDir = fileURLToPath(new URL("./migrations/", import.meta.url));
    for (const file of readdirSync(migrationsDir).sort()) {
      if (file >= "006") break;
      old.exec(readFileSync(join(migrationsDir, file), "utf8"));
      old.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, '')").run(file);
    }
    old.exec(`
      INSERT INTO projects (id, title, position, created_at, updated_at) VALUES ('p', 'P', 'a0', '', '');
      INSERT INTO tasks (id, number, project_id, title, status, position, created_by, created_at, updated_at, status_changed_at)
        VALUES ('a', 1, 'p', 'A', 'idea', 'a0', 'user', '', '', ''),
               ('b', 2, 'p', 'B', 'done', 'a0', 'user', '', '', '');
      UPDATE tasks SET resolution = 'completed', resolved_by_task_id = 'b' WHERE id = 'a';
      INSERT INTO plan_phases (id, task_id, title, position, created_at, updated_at) VALUES ('ph', 'a', 'Ph', 'a0', '', '');
      INSERT INTO plan_steps (id, phase_id, task_id, title, status, position, updated_at) VALUES ('st', 'ph', 'a', 'St', 'todo', 'a0', '');
      INSERT INTO task_links (id, task_id, kind, url, created_at) VALUES ('l', 'a', 'url', 'https://example.com', '');
      INSERT INTO task_labels (task_id, label) VALUES ('a', 'ui');
      INSERT INTO task_reviews (id, task_id, round, cycle, status, trigger, opened_by, created_at, updated_at)
        VALUES ('r', 'a', 1, 1, 'submitted', 'manual', 'user', '', '');
      INSERT INTO review_findings (id, review_id, task_id, position, severity, title, status, created_at)
        VALUES ('f', 'r', 'a', 1, 'nit', 'F', 'open', '');
      INSERT INTO task_events (task_id, at, actor, type, payload_json) VALUES
        ('a', '', 'user', 'created', '{"status":"idea"}'),
        ('a', '', 'user', 'status_changed', '{"from":"idea","to":"planned"}'),
        ('b', '', 'user', 'closed', '{"resolution":"wont_do","from":"idea"}'),
        ('a', '', 'user', 'note', '{"text":"idea"}');
    `);
    old.close();

    const db = openDatabase(path);
    const all = (sql: string) => db.prepare(sql).all();
    expect(all("SELECT id, status, resolved_by_task_id FROM tasks ORDER BY id")).toEqual([
      { id: "a", status: "backlog", resolved_by_task_id: "b" },
      { id: "b", status: "done", resolved_by_task_id: null },
    ]);
    const children = ["plan_phases", "plan_steps", "task_links", "task_labels", "task_reviews", "review_findings"];
    expect(children.map((table) => [table, all(`SELECT * FROM ${table}`).length])).toEqual(
      children.map((table) => [table, 1]),
    );
    expect(all("SELECT payload_json FROM task_events ORDER BY id").map((r) => r.payload_json)).toEqual([
      '{"status":"backlog"}',
      '{"from":"backlog","to":"planned"}',
      '{"resolution":"wont_do","from":"backlog"}',
      '{"text":"idea"}',
    ]);
    expect(all("PRAGMA foreign_key_check")).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(() => db.exec("UPDATE tasks SET status = 'idea'")).toThrow(/CHECK/);
    // Foreign keys are enforced again: deleting a task still cascades to its children.
    db.exec("DELETE FROM tasks WHERE id = 'a'");
    expect(all("SELECT * FROM plan_steps")).toEqual([]);
    db.close();
  });

  it("re-classifies stored links that now parse as GitHub-style PRs", () => {
    dir = mkdtempSync(join(tmpdir(), "board-db-"));
    const path = join(dir, "board.db");
    const db = openDatabase(path);
    db.exec(`
      DELETE FROM migrations WHERE name = '008_enterprise_pr_links';
      INSERT INTO projects (id, title, position, created_at, updated_at) VALUES ('p', 'P', 'a0', '', '');
      INSERT INTO tasks (id, number, project_id, title, status, position, created_by, created_at, updated_at, status_changed_at)
        VALUES ('t', 1, 'p', 'T', 'backlog', 'a0', 'user', '', '', '');
      INSERT INTO task_links (id, task_id, kind, url, ref_json, created_at) VALUES
        ('ghe', 't', 'url', 'https://ghe.example.com/team/svc/pull/7', NULL, ''),
        ('forced', 't', 'pr', 'https://git.example.org/a/b/pull/2/files', NULL, ''),
        ('dup-url', 't', 'url', 'https://ghe.example.com/team/svc/pull/8', NULL, ''),
        ('dup-pr', 't', 'pr', 'https://ghe.example.com/team/svc/pull/8', NULL, ''),
        ('plain', 't', 'url', 'https://example.com/docs', NULL, ''),
        ('ado', 't', 'pr', 'https://dev.azure.com/o/p/_git/r/pullrequest/3', NULL, '');
    `);
    db.close();

    const reopened = openDatabase(path);
    const rows = reopened.prepare("SELECT id, kind, ref_json FROM task_links ORDER BY id").all();
    reopened.close();
    expect(rows).toEqual([
      { id: "ado", kind: "pr", ref_json: null },
      { id: "dup-pr", kind: "pr", ref_json: '{"host":"ghe.example.com","repo":"team/svc","number":8}' },
      { id: "forced", kind: "pr", ref_json: '{"host":"git.example.org","repo":"a/b","number":2}' },
      { id: "ghe", kind: "pr", ref_json: '{"host":"ghe.example.com","repo":"team/svc","number":7}' },
      { id: "plain", kind: "url", ref_json: null },
    ]);
  });
  describe("ticket systems (036)", () => {
    const before = (setup: string): DatabaseSync => {
      dir = mkdtempSync(join(tmpdir(), "board-db-"));
      const path = join(dir, "board.db");
      const old = openDatabase(path, { migrateTo: "035_task_manual.sql" });
      old.exec(`
        INSERT INTO projects (id, title, position, created_at, updated_at) VALUES ('p', 'P', 'a0', '', '');
        INSERT INTO tasks (id, number, project_id, title, status, position, created_by, created_at, updated_at, status_changed_at)
          VALUES ('t', 1, 'p', 'T', 'backlog', 'a0', 'user', '', '', '');
        ${setup}
      `);
      old.close();
      return openDatabase(path);
    };
    const setting = (db: DatabaseSync, key: string): unknown => {
      const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
        | { value_json: string }
        | undefined;
      return row ? JSON.parse(row.value_json) : undefined;
    };

    it("turns Jira links, imports and settings into a Jira ticket system", () => {
      const db = before(`
        INSERT INTO settings (key, value_json) VALUES
          ('jiraBaseUrl', '"https://jira.example.com/"'),
          ('issueImportJiraTools', '["mcp__atlassian__getJiraIssue","not a rule"]');
        INSERT INTO task_links (id, task_id, kind, url, ref_json, created_at) VALUES
          ('key', 't', 'jira', 'https://jira.example.com/browse/ABC-1', '{"key":"ABC-1"}', ''),
          ('bare', 't', 'jira', 'ABC-2', NULL, ''),
          ('pr', 't', 'pr', 'https://github.com/a/b/pull/1', '{"host":"github.com","repo":"a/b","number":1}', '');
        INSERT INTO task_imports (task_id, source_url, source_kind, status, created_at, updated_at)
          VALUES ('t', 'ABC-1', 'jira', 'done', '', '');
        INSERT INTO task_events (task_id, at, actor, type, payload_json)
          VALUES ('t', '', 'user', 'link_added', '{"kind":"jira","url":"ABC-2"}');
      `);
      expect(db.prepare("SELECT id, kind, ref_json, auto FROM task_links ORDER BY id").all()).toEqual([
        { id: "bare", kind: "ticket", ref_json: '{"system":"jira","key":"ABC-2"}', auto: 0 },
        { id: "key", kind: "ticket", ref_json: '{"system":"jira","key":"ABC-1"}', auto: 0 },
        { id: "pr", kind: "pr", ref_json: '{"host":"github.com","repo":"a/b","number":1}', auto: 0 },
      ]);
      expect(db.prepare("SELECT source_kind, system_id FROM task_imports").all()).toEqual([
        { source_kind: "ticket", system_id: "jira" },
      ]);
      expect(db.prepare("SELECT payload_json FROM task_events").get()).toEqual({
        payload_json: '{"kind":"ticket","url":"ABC-2"}',
      });
      expect(setting(db, "ticketSystems")).toEqual([
        expect.objectContaining({
          id: "jira",
          name: "Jira",
          linkTemplate: "https://jira.example.com/browse/{key}",
          autoLink: false,
          importTools: ["mcp__atlassian__getJiraIssue"],
        }),
      ]);
      expect(setting(db, "jiraBaseUrl")).toBeUndefined();
      expect(setting(db, "issueImportJiraTools")).toBeUndefined();
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      db.close();
    });

    it("makes a system for Jira links even without a base URL, and none without any Jira data", () => {
      const linked = before(`
        INSERT INTO settings (key, value_json) VALUES ('jiraBaseUrl', 'null'), ('issueImportJiraTools', '[]');
        INSERT INTO task_links (id, task_id, kind, url, ref_json, created_at) VALUES ('k', 't', 'jira', 'ABC-1', '{"key":"ABC-1"}', '');
      `);
      const systems = setting(linked, "ticketSystems") as Array<Record<string, unknown>>;
      expect(systems.map((s) => s.id)).toEqual(["jira"]);
      expect(systems[0]).not.toHaveProperty("linkTemplate");
      linked.close();
      rmSync(dir!, { recursive: true, force: true });

      const unused = before(`INSERT INTO settings (key, value_json) VALUES ('jiraBaseUrl', 'null');`);
      expect(setting(unused, "ticketSystems")).toBeUndefined();
      expect(setting(unused, "jiraBaseUrl")).toBeUndefined();
      unused.close();
    });
  });
  describe("providers (040)", () => {
    const before = (setup: string): DatabaseSync => {
      dir = mkdtempSync(join(tmpdir(), "board-db-"));
      const path = join(dir, "board.db");
      const old = openDatabase(path, { migrateTo: "039_review_model.sql" });
      old.exec(`
        INSERT INTO projects (id, title, position, created_at, updated_at) VALUES ('p', 'P', 'a0', '', '');
        INSERT INTO tasks (id, number, project_id, title, status, position, created_by, created_at, updated_at, status_changed_at)
          VALUES ('t', 1, 'p', 'T', 'backlog', 'a0', 'user', '', '', '');
        ${setup}
      `);
      old.close();
      return openDatabase(path);
    };
    const setting = (db: DatabaseSync, key: string): unknown => {
      const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
        | { value_json: string }
        | undefined;
      return row ? JSON.parse(row.value_json) : undefined;
    };

    it("adds nothing to a new install, and leaves it no detection to run", () => {
      dir = mkdtempSync(join(tmpdir(), "board-db-"));
      const db = openDatabase(join(dir, "board.db"));
      expect(setting(db, "providers")).toEqual([]);
      expect(setting(db, "providersDetectSeed")).toBeUndefined();
      db.close();
    });

    it("adds nothing for an install that set nothing, but leaves detection to look", () => {
      const db = before("");
      expect(setting(db, "providers")).toEqual([]);
      expect(setting(db, "providersDetectSeed")).toBe(true);
      db.close();
    });

    it("adds Claude Code alone with its CLI path when that is all that was used", () => {
      const db = before(
        `INSERT INTO settings (key, value_json) VALUES ('headlessReviewCli', '"/opt/claude"'), ('codexCli', 'null');`,
      );
      expect(setting(db, "providers")).toEqual([{ id: "claude-code", enabled: true, cliPath: "/opt/claude" }]);
      expect(setting(db, "headlessReviewCli")).toBeUndefined();
      expect(setting(db, "codexCli")).toBeUndefined();
      db.close();
    });

    it("adds all four from paths, the token, models and linked sessions", () => {
      const tiers = JSON.stringify({
        light: { description: null, t3: { selection: { instanceId: "codex", model: "gpt-5" }, label: "GPT-5" } },
        standard: { description: null, t3: null, cli: { "copilot-cli": "gpt-5.4" } },
        deep: { description: null, t3: null },
      });
      const profiles = JSON.stringify([
        { id: "fast", name: "Fast", labels: [], description: null, t3: null, headless: "codex" },
      ]);
      const db = before(`
        INSERT INTO settings (key, value_json) VALUES
          ('copilotCli', '"  /opt/copilot "'), ('t3Token', '"secret"'), ('modelTiers', '${tiers}'), ('modelProfiles', '${profiles}');
        INSERT INTO task_links (id, task_id, kind, url, ref_json, created_at)
          VALUES ('s', 't', 'agent_session', 'session://x', '{"harness":"claude-code","sessionId":"x","cwd":"/w"}', '');
      `);
      expect(setting(db, "providers")).toEqual([
        { id: "t3-code", enabled: true, cliPath: null },
        { id: "claude-code", enabled: true, cliPath: null },
        { id: "codex", enabled: true, cliPath: null },
        { id: "copilot-cli", enabled: true, cliPath: "/opt/copilot" },
      ]);
      expect(setting(db, "copilotCli")).toBeUndefined();
      db.close();
    });
  });

  describe("merge ready PRs (043)", () => {
    const before = (setup: string): DatabaseSync => {
      dir = mkdtempSync(join(tmpdir(), "board-db-"));
      const path = join(dir, "board.db");
      const old = openDatabase(path, { migrateTo: "042_task_trash.sql" });
      old.exec(`
        INSERT INTO projects (id, title, position, created_at, updated_at)
          VALUES ('a', 'A', 'a0', '', ''), ('b', 'B', 'a1', '', ''), ('c', 'C', 'a2', '', '');
        ${setup}
      `);
      old.close();
      // Before 044 writes Orchestrate's old budget and timeout into its board row.
      return openDatabase(path, { migrateTo: "043_merge_ready_prs" });
    };
    const row = (db: DatabaseSync, automation: string, kind = "board", id = "") => {
      const found = db
        .prepare(
          "SELECT mode, config_json FROM autopilot_settings WHERE automation = ? AND scope_kind = ? AND scope_id = ?",
        )
        .get(automation, kind, id) as { mode: string; config_json: string } | undefined;
      return found ? { mode: found.mode, config: JSON.parse(found.config_json) as unknown } : undefined;
    };
    const orchestrate = (kind: string, id: string, mode: string, config = "{}") =>
      `INSERT INTO autopilot_settings (scope_kind, scope_id, automation, mode, config_json, updated_at) VALUES ('${kind}', '${id}', 'orchestrate', '${mode}', '${config}', '');`;

    it("switches Merge ready PRs on with Into main wherever Orchestrate was on with May merge", () => {
      const db = before(
        orchestrate("board", "", "on", '{"everyMinutes":15}') +
          orchestrate("project", "a", "inherit", '{"mayMerge":false}') +
          orchestrate("project", "b", "off"),
      );
      expect(row(db, "merge_epic_prs")).toEqual({ mode: "on", config: { intoMain: true } });
      // On through the board but with May merge off: it keeps not merging into main.
      expect(row(db, "merge_epic_prs", "project", "a")).toEqual({ mode: "inherit", config: { intoMain: false } });
      // Orchestrate was off there, so nothing merged into main: the board's new Into main doesn't reach it.
      expect(row(db, "merge_epic_prs", "project", "b")).toEqual({ mode: "inherit", config: { intoMain: false } });
      expect(row(db, "orchestrate")).toEqual({ mode: "on", config: { everyMinutes: 15 } });
      expect(row(db, "orchestrate", "project", "a")).toEqual({ mode: "inherit", config: {} });
      db.close();
    });

    it("migrates a project of its own, and keeps an explicit Off for Merge ready PRs", () => {
      const db = before(
        orchestrate("board", "", "on", '{"mayMerge":false}') +
          orchestrate("project", "a", "on") +
          orchestrate("project", "b", "inherit", '{"mayMerge":true}') +
          orchestrate("project", "c", "on", '{"mayMerge":true}') +
          `INSERT INTO autopilot_settings (scope_kind, scope_id, automation, mode, config_json, updated_at)
             VALUES ('project', 'c', 'merge_epic_prs', 'off', '{}', '');`,
      );
      expect(row(db, "merge_epic_prs")).toBeUndefined();
      // Project a inherits the board's May merge (off); b sets its own (on) and is on through the board.
      expect(row(db, "merge_epic_prs", "project", "a")).toBeUndefined();
      expect(row(db, "merge_epic_prs", "project", "b")).toEqual({ mode: "on", config: { intoMain: true } });
      expect(row(db, "merge_epic_prs", "project", "c")).toEqual({ mode: "off", config: { intoMain: true } });
      db.close();
    });

    it("adds no project row where everything came from the board, so a board Off for Merge ready PRs still holds", () => {
      const db = before(
        orchestrate("board", "", "on") +
          orchestrate("project", "a", "inherit", '{"everyMinutes":10}') +
          `INSERT INTO autopilot_settings (scope_kind, scope_id, automation, mode, config_json, updated_at)
             VALUES ('board', '', 'merge_epic_prs', 'off', '{}', '');`,
      );
      expect(row(db, "merge_epic_prs")).toEqual({ mode: "off", config: { intoMain: true } });
      expect(row(db, "merge_epic_prs", "project", "a")).toBeUndefined();
      db.close();
    });

    it("leaves Merge ready PRs alone where Orchestrate was never on", () => {
      const db = before(orchestrate("board", "", "inherit", '{"mayMerge":true}'));
      expect(row(db, "merge_epic_prs")).toBeUndefined();
      db.close();
    });
  });

  describe("operation models (041)", () => {
    const before = (setup: string): DatabaseSync => {
      dir = mkdtempSync(join(tmpdir(), "board-db-"));
      const path = join(dir, "board.db");
      const old = openDatabase(path, { migrateTo: "040_providers_settings" });
      old.exec(`
        INSERT INTO projects (id, title, position, created_at, updated_at, review_model_json)
          VALUES ('p', 'P', 'a0', '', '', '{"tier":"deep"}');
        INSERT INTO tasks (id, number, project_id, title, status, position, created_by, created_at, updated_at, status_changed_at, review_model_json)
          VALUES ('t', 1, 'p', 'T', 'backlog', 'a0', 'user', '', '', '', '"opus"'),
                 ('u', 2, 'p', 'U', 'backlog', 'a1', 'user', '', '', '', NULL);
        ${setup}
      `);
      old.close();
      // Before 044 seeds the PR automations' own budgets.
      return openDatabase(path, { migrateTo: "042_task_trash.sql" });
    };
    const json = (db: DatabaseSync, sql: string, ...params: string[]): unknown => {
      const row = db.prepare(sql).get(...params) as Record<string, string | null> | undefined;
      const value = row ? Object.values(row)[0] : undefined;
      return typeof value === "string" ? JSON.parse(value) : value;
    };
    const setting = (db: DatabaseSync, key: string) => json(db, "SELECT value_json FROM settings WHERE key = ?", key);
    const config = (db: DatabaseSync, automation: string, scope = "board") =>
      json(db, "SELECT config_json FROM autopilot_settings WHERE automation = ? AND scope_kind = ?", automation, scope);

    it("moves the reviewer and import models into operationModels, as what they ran on", () => {
      const db = before(`
        INSERT INTO settings (key, value_json) VALUES ('reviewModel', '"sonnet"'), ('issueImportModel', '{"model":"haiku"}');
      `);
      expect(setting(db, "operationModels")).toEqual({
        reviewer: { provider: "claude-code", model: "sonnet" },
        boardReviewer: { provider: "claude-code", model: "sonnet" },
        issueImport: { provider: "claude-code", model: "haiku" },
      });
      expect(setting(db, "reviewModel")).toBeUndefined();
      expect(setting(db, "issueImportModel")).toBeUndefined();
      db.close();
    });

    it("keeps a board reviewer model saved as From the task on the task's model", () => {
      const db = before(`INSERT INTO settings (key, value_json) VALUES ('reviewModel', '{"from":"task"}');`);
      expect(setting(db, "operationModels")).toEqual({ boardReviewer: "inherit" });
      expect(setting(db, "reviewModel")).toBeUndefined();
      db.close();
    });

    it("gives a reviewer model saved as none the new defaults", () => {
      const db = before(`INSERT INTO settings (key, value_json) VALUES ('reviewModel', 'null');`);
      expect(setting(db, "operationModels")).toBeUndefined();
      db.close();
    });

    it("leaves defaults never saved to the operations' new defaults", () => {
      const db = before("");
      expect(setting(db, "operationModels")).toBeUndefined();
      db.close();
    });

    it("rewrites project and task reviewer overrides", () => {
      const db = before("");
      expect(json(db, "SELECT review_model_json FROM projects WHERE id = 'p'")).toEqual({ tier: "deep" });
      expect(json(db, "SELECT review_model_json FROM tasks WHERE id = 't'")).toEqual({
        provider: "claude-code",
        model: "opus",
      });
      expect(json(db, "SELECT review_model_json FROM tasks WHERE id = 'u'")).toBeNull();
      db.close();
    });

    it("renames a tier's and a custom model's headless harness to its preferred provider", () => {
      const db = before(`
        INSERT INTO settings (key, value_json) VALUES
          ('modelTiers', '{"light":{"description":null,"t3":null,"headless":"codex","cli":{"codex":"gpt-mini"}},"standard":{"description":null,"t3":null},"deep":{"description":null,"t3":null}}'),
          ('modelProfiles', '[{"id":"c","name":"C","labels":[],"description":null,"t3":null,"headless":"copilot-cli"}]');
      `);
      expect(setting(db, "modelTiers")).toMatchObject({
        light: { provider: "codex", cli: { codex: "gpt-mini" } },
        standard: { description: null },
      });
      expect((setting(db, "modelTiers") as { light: object }).light).not.toHaveProperty("headless");
      expect(setting(db, "modelProfiles")).toEqual([
        { id: "c", name: "C", labels: [], description: null, t3: null, provider: "copilot-cli" },
      ]);
      db.close();
    });

    it("folds a typed model into the automation's choice, on the provider it ran on", () => {
      const db = before(`
        INSERT INTO settings (key, value_json) VALUES
          ('modelTiers', '{"light":{"description":null,"t3":null},"standard":{"description":null,"t3":null},"deep":{"description":null,"t3":null,"headless":"codex"}}');
        INSERT INTO autopilot_settings (scope_kind, scope_id, automation, mode, config_json, updated_at) VALUES
          ('board', '', 'start_planned', 'on', '{"runner":"headless","modelChoice":{"tier":"deep"},"model":"gpt-5.5"}', ''),
          ('project', 'p', 'start_planned', 'inherit', '{"modelChoice":{"from":"task"},"model":""}', ''),
          ('board', '', 'review_prs', 'on', '{"modelChoice":{"tier":"deep"},"model":"opus"}', ''),
          ('board', '', 'digest', 'on', '{"mode":"summarised","model":"haiku"}', ''),
          ('board', '', 'fix_prs', 'on', '{"budgetUsd":3}', '');
      `);
      // The deep tier ran headless on Codex, so its typed model was a Codex model.
      expect(config(db, "start_planned")).toEqual({
        runner: "headless",
        modelChoice: { provider: "codex", model: "gpt-5.5" },
      });
      expect(config(db, "start_planned", "project")).toEqual({ modelChoice: "inherit" });
      // Codex can't review PRs headless, so Claude Code always ran them.
      expect(config(db, "review_prs")).toEqual({ modelChoice: { provider: "claude-code", model: "opus" } });
      expect(config(db, "digest")).toEqual({
        mode: "summarised",
        modelChoice: { provider: "claude-code", model: "haiku" },
      });
      expect(config(db, "fix_prs")).toEqual({ budgetUsd: 3 });
      db.close();
    });

    it("turns a custom agent's tier into its model", () => {
      const action = (tier: string | null) =>
        JSON.stringify({ kind: "agent", prompt: "Go", skill: "", tier, onPrBranch: false, allowedTools: [] });
      const db = before(`
        INSERT INTO autopilot_custom (id, name, trigger_json, action_json, armed_at, created_at, updated_at) VALUES
          ('a', 'A', '{"kind":"manual"}', '${action("deep")}', '', '', ''),
          ('b', 'B', '{"kind":"manual"}', '${action(null)}', '', '', ''),
          ('c', 'C', '{"kind":"manual"}', '{"kind":"shell","command":"ls"}', '', '', '');
      `);
      const actionOf = (id: string) => json(db, "SELECT action_json FROM autopilot_custom WHERE id = ?", id);
      expect(actionOf("a")).toEqual({
        kind: "agent",
        prompt: "Go",
        skill: "",
        onPrBranch: false,
        allowedTools: [],
        model: { tier: "deep" },
      });
      expect(actionOf("b")).toMatchObject({ model: "inherit" });
      expect(actionOf("b")).not.toHaveProperty("tier");
      expect(actionOf("c")).toEqual({ kind: "shell", command: "ls" });
      db.close();
    });

    it("adds autopilot_runs.model_json", () => {
      const db = before("");
      const columns = db.prepare("PRAGMA table_info(autopilot_runs)").all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toContain("model_json");
      db.close();
    });
  });

  describe("agent defaults (044)", () => {
    const before = (setup: string): DatabaseSync => {
      dir = mkdtempSync(join(tmpdir(), "board-db-"));
      const path = join(dir, "board.db");
      const old = openDatabase(path, { migrateTo: "042_task_trash.sql" });
      old.exec(setup);
      old.close();
      return openDatabase(path);
    };
    const json = (db: DatabaseSync, sql: string, ...params: string[]): unknown => {
      const row = db.prepare(sql).get(...params) as { value: string } | undefined;
      return row ? JSON.parse(row.value) : undefined;
    };
    const engine = (db: DatabaseSync) =>
      json(db, "SELECT value_json AS value FROM settings WHERE key = 'autopilotEngine'");
    const board = (db: DatabaseSync, automation: string) =>
      json(
        db,
        "SELECT config_json AS value FROM autopilot_settings WHERE scope_kind = 'board' AND automation = ?",
        automation,
      );
    const engineRow = (value: object) =>
      `INSERT INTO settings (key, value_json) VALUES ('autopilotEngine', '${JSON.stringify(value)}');`;

    it("moves changed PR values into Review PRs and Fix PRs, keeping what those set already", () => {
      const db = before(`
        ${engineRow({ maxConcurrent: 2, prReviewRounds: 5, prCommentRounds: 2, prFixThreshold: "minor" })}
        INSERT INTO autopilot_settings (scope_kind, scope_id, automation, mode, config_json, updated_at)
          VALUES ('board', '', 'fix_prs', 'on', '{"onComments":false,"budgetUsd":4}', '');
      `);
      expect(engine(db)).toEqual({ maxConcurrent: 2 });
      expect(board(db, "review_prs")).toEqual({ rounds: 5 });
      expect(board(db, "fix_prs")).toEqual({
        attempts: 5,
        commentAttempts: 2,
        fixThreshold: "minor",
        onComments: false,
        // Set by the user: kept. The timeout it never set keeps Fix PRs' old 30 minutes.
        budgetUsd: 4,
        timeoutMinutes: 30,
      });
      const mode = db.prepare("SELECT mode FROM autopilot_settings WHERE automation = 'fix_prs'").get() as {
        mode: string;
      };
      expect(mode.mode).toBe("on");
      db.close();
    });

    it("moves nothing for PR values left at their defaults", () => {
      const db = before(engineRow({ prReviewRounds: 3, prCommentRounds: 5, prFixThreshold: "major", dryRun: true }));
      expect(engine(db)).toEqual({ dryRun: true });
      expect(board(db, "review_prs")).toBeUndefined();
      expect(board(db, "fix_prs")).toBeUndefined();
      db.close();
    });

    it("keeps the old budgets and timeouts of automations in use, at the scope that doesn't set them", () => {
      const db = before(`
        INSERT INTO projects (id, title, position, created_at, updated_at) VALUES ('p', 'P', 'a0', '', '');
        INSERT INTO autopilot_settings (scope_kind, scope_id, automation, mode, config_json, updated_at) VALUES
          ('project', 'p', 'review_prs', 'on', '{}', ''),
          ('board', '', 'orchestrate', 'on', '{"timeoutMinutes":45}', ''),
          ('board', '', 'digest', 'on', '{"mode":"summarised"}', ''),
          ('board', '', 'start_planned', 'on', '{}', '');
      `);
      expect(board(db, "review_prs")).toEqual({ budgetUsd: 2, timeoutMinutes: 20 });
      expect(board(db, "orchestrate")).toEqual({ budgetUsd: 3, timeoutMinutes: 45 });
      expect(board(db, "digest")).toEqual({ mode: "summarised", budgetUsd: 1, timeoutMinutes: 15 });
      // Its defaults were the board's defaults already.
      expect(board(db, "start_planned")).toEqual({});
      // Never touched, so never on: it takes the board's defaults.
      expect(board(db, "fix_prs")).toBeUndefined();
      expect(engine(db)).toBeUndefined();
      db.close();
    });
  });

  describe("reminders and Recurring tasks without switches (047, 048)", () => {
    const before = (setup: string): DatabaseSync => {
      dir = mkdtempSync(join(tmpdir(), "board-db-"));
      const path = join(dir, "board.db");
      const old = openDatabase(path, { migrateTo: "042_task_trash.sql" });
      old.exec(`
        INSERT INTO projects (id, title, position, created_at, updated_at) VALUES
          ('a', 'A', 'a0', '', ''), ('b', 'B', 'a1', '', ''), ('c', 'C', 'a2', '', '');
        INSERT INTO tasks (id, number, project_id, title, status, position, created_by, created_at, updated_at, status_changed_at, kind)
          VALUES ('e', 1, 'c', 'Epic', 'in_progress', 'a0', 'user', '', '', '', 'epic');
        ${setup}
      `);
      old.close();
      return openDatabase(path);
    };
    const kinds = (db: DatabaseSync) =>
      (
        JSON.parse(
          (db.prepare("SELECT value_json FROM settings WHERE key = 'notifications'").get() as { value_json: string })
            .value_json,
        ) as { kinds: Record<string, boolean> }
      ).kinds;
    const rule = (id: string, projectId: string) =>
      `INSERT INTO autopilot_recurring (id, project_id, name, schedule_json, enabled, last_due_at, created_at, updated_at)
       VALUES ('${id}', '${projectId}', '${id}', '{}', 1, '', '', '');`;
    const enabled = (db: DatabaseSync) =>
      Object.fromEntries(
        (db.prepare("SELECT id, enabled FROM autopilot_recurring").all() as Array<{ id: string; enabled: number }>).map(
          (r) => [r.id, r.enabled === 1],
        ),
      );
    const settingRow = (scope: string, id: string, automation: string, mode: string) =>
      `INSERT INTO autopilot_settings (scope_kind, scope_id, automation, mode, config_json, updated_at) VALUES ('${scope}', '${id}', '${automation}', '${mode}', '{}', '');`;

    it("keeps the defaults on a new install", () => {
      dir = mkdtempSync(join(tmpdir(), "board-db-"));
      const db = openDatabase(join(dir, "board.db"));
      expect(db.prepare("SELECT 1 FROM settings WHERE key = 'notifications'").get()).toBeUndefined();
      db.close();
    });

    it("turns each switch on where its automation was on in some project, off where it never was", () => {
      const db = before(`
        ${settingRow("board", "", "unstick", "on")}
        ${settingRow("project", "a", "unstick", "off")}
        ${settingRow("project", "b", "unstick", "off")}
        ${settingRow("project", "c", "unstick", "inherit")}
        ${settingRow("project", "a", "unblock_dependents", "off")}
      `);
      // Unstick: the board's On reaches project c.
      expect(kinds(db)).toEqual({ thread_waited: true, task_quiet: true, task_unblocked: false });
      expect(
        db.prepare("SELECT 1 FROM autopilot_settings WHERE automation IN ('unstick', 'unblock_dependents')").get(),
      ).toBeUndefined();
      db.close();
    });

    it("is off for an automation only an epic had on when that epic is archived, and on when it isn't", () => {
      const archived = before(`
        ${settingRow("epic", "e", "unblock_dependents", "on")}
        UPDATE tasks SET archived_at = '2026-01-01' WHERE id = 'e';
      `);
      expect(kinds(archived).task_unblocked).toBe(false);
      archived.close();
      rmSync(dir!, { recursive: true, force: true });
      const live = before(settingRow("epic", "e", "unblock_dependents", "on"));
      expect(kinds(live)).toEqual({ thread_waited: false, task_quiet: false, task_unblocked: true });
      live.close();
    });

    it("keeps the other notification settings it finds", () => {
      const db = before(`
        INSERT INTO settings (key, value_json) VALUES ('notifications', '{"muteInQuietHours":false,"kinds":{"suggestion":false}}');
        ${settingRow("project", "a", "unstick", "on")}
      `);
      expect(
        JSON.parse(
          (db.prepare("SELECT value_json FROM settings WHERE key = 'notifications'").get() as { value_json: string })
            .value_json,
        ),
      ).toEqual({
        muteInQuietHours: false,
        kinds: { suggestion: false, thread_waited: true, task_quiet: true, task_unblocked: false },
      });
      db.close();
    });

    it("disables the rules of projects where Recurring tasks was effectively off, and drops its settings", () => {
      const db = before(`
        ${rule("ra", "a")} ${rule("rb", "b")} ${rule("rc", "c")}
        ${settingRow("board", "", "recurring", "on")}
        ${settingRow("project", "b", "recurring", "off")}
      `);
      // The board's On reaches a and c; b switched it off for itself.
      expect(enabled(db)).toEqual({ ra: true, rb: false, rc: true });
      expect(db.prepare("SELECT 1 FROM autopilot_settings WHERE automation = 'recurring'").get()).toBeUndefined();
      db.close();
    });

    it("disables every rule when Recurring tasks was on nowhere, and keeps one a project switched on", () => {
      const off = before(`${rule("ra", "a")} ${rule("rb", "b")}`);
      expect(enabled(off)).toEqual({ ra: false, rb: false });
      off.close();
      rmSync(dir!, { recursive: true, force: true });
      const some = before(`${rule("ra", "a")} ${rule("rb", "b")} ${settingRow("project", "a", "recurring", "on")}`);
      expect(enabled(some)).toEqual({ ra: true, rb: false });
      some.close();
    });
  });
});
