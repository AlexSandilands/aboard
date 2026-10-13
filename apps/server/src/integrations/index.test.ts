import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BRAND, type BoardEvent } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../bus.ts";
import { openDatabase } from "../db/database.ts";
import { createServices } from "../services/index.ts";
import type { Services } from "../services/types.ts";
import type { RunGh } from "./github.ts";
import { createIntegrations } from "./index.ts";
import type { FetchFn } from "./t3.ts";

const ENV_ID = "env-1";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup(opts: { runGh?: RunGh; fetch?: FetchFn; withDb?: boolean } = {}) {
  const t3Home = mkdtempSync(join(tmpdir(), `${BRAND.id}-int-`));
  homes.push(t3Home);
  mkdirSync(join(t3Home, "userdata"));
  writeFileSync(join(t3Home, "userdata", "server-runtime.json"), JSON.stringify({ origin: "http://127.0.0.1:3773" }));
  if (opts.withDb) {
    const t3db = new DatabaseSync(join(t3Home, "userdata", "statev2.sqlite"));
    t3db.exec(`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL,
      project_icon_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`);
    t3db.exec(`INSERT INTO projection_projects VALUES
      ('t3-a', 'Alpha', 'C:\\Work\\Alpha', '{"kind":"monogram","text":"AL","color":"teal"}', '2026-01-01', '2026-01-01', NULL),
      ('t3-b', 'Beta', 'C:\\Work\\Beta', NULL, '2026-01-02', '2026-01-02', NULL)`);
    t3db.close();
  }
  const bus = new EventBus();
  const events: BoardEvent[] = [];
  bus.subscribe((e) => events.push(e));
  let services: Services | null = null;
  const integrations = createIntegrations(
    { config: { t3Home, pollers: false }, bus, services: () => services! },
    { log: { warn: () => {} }, ...(opts.runGh ? { runGh: opts.runGh } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) },
  );
  services = createServices({ db: openDatabase(":memory:"), bus, t3Status: () => integrations.t3Status() });
  return { services, integrations, events };
}

const ghPr: RunGh = async (args) =>
  args[0] === "pr"
    ? JSON.stringify({
        number: 5,
        title: "Fix it",
        state: "OPEN",
        isDraft: false,
        reviewDecision: "CHANGES_REQUESTED",
        mergeable: "CONFLICTING",
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }],
        headRefName: "fix",
        updatedAt: "2026-10-01T00:00:00Z",
      })
    : "ok";

describe("createIntegrations with real services", () => {
  it("refreshLink stores a PR snapshot and surfaces attention", async () => {
    const { services, integrations, events } = setup({ runGh: ghPr });
    const project = services.projects.create({ title: "P", workspaceRoot: "C:/p" });
    const task = services.tasks.create({ projectId: project.id, title: "T" });
    const link = services.links.add(task.id, { value: "https://github.com/o/r/pull/5" }, "user");
    events.length = 0;
    await integrations.refreshLink(link.id);
    expect(services.links.get(link.id)).toMatchObject({ snapshot: { title: "Fix it", checks: "failing", mergeable: "conflicting" } });
    expect(services.tasks.summary(task.id).attention.map((a) => a.kind)).toEqual([
      "pr_checks_failing",
      "pr_changes_requested",
      "pr_conflict",
    ]);
    expect(events.some((e) => e.type === "task.upserted")).toBe(true);
  });

  it("refreshLink on a T3 thread link uses the shell API", async () => {
    const fetchFn: FetchFn = async (url) =>
      url.endsWith("/environment")
        ? Response.json({ environmentId: ENV_ID, label: "box" })
        : Response.json({
            projects: [],
            threads: [{ id: "th1", projectId: "p", title: "Agent thread", status: "running", latestRunId: "r", activeProviderThreadId: null, pendingRuntimeRequest: { kind: "permission" } }],
            archivedThreads: [],
          });
    const { services, integrations } = setup({ fetch: fetchFn });
    services.settings.update({ t3Token: "tok" });
    const project = services.projects.create({ title: "P", workspaceRoot: "C:/p" });
    const task = services.tasks.create({ projectId: project.id, title: "T" });
    const link = services.links.add(task.id, { value: `t3code://threads/${ENV_ID}/th1` }, "user");
    await integrations.refreshLink(link.id);
    expect(services.links.get(link.id)).toMatchObject({ snapshot: { title: "Agent thread", status: "approval" } });
    expect(services.tasks.summary(task.id).attention.map((a) => a.kind)).toEqual(["thread_needs_input"]);
    expect(integrations.t3Status()).toMatchObject({ detected: true, environmentId: ENV_ID, liveStatus: "ok" });
  });

  it("imports T3 projects from the sqlite copy and skips existing ones", async () => {
    const { services, integrations } = setup({ withDb: true, fetch: async () => Response.json({}, { status: 503 }) });
    const existing = services.projects.create({ title: "Mine", workspaceRoot: "c:/work/beta" });
    const candidates = await integrations.listT3Projects();
    expect(candidates.map((c) => [c.t3ProjectId, c.existingProjectId])).toEqual([
      ["t3-a", null],
      ["t3-b", existing.id],
    ]);
    const created = await integrations.importT3Projects(["t3-a", "t3-b"]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: "Alpha", t3ProjectId: "t3-a", icon: { kind: "monogram", text: "AL", color: "teal" } });
    expect(services.projects.list().map((p) => p.title).sort()).toEqual(["Alpha", "Mine"]);
  });

  it("start() is a no-op when pollers are disabled", () => {
    const { integrations } = setup({ runGh: async () => { throw new Error("should not spawn"); } });
    integrations.start();
    integrations.stop();
  });
});
