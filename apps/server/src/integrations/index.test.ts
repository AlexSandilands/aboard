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
import { createFakeGithub, fakePr } from "../test/fakeGithub.ts";
import type { RunGh } from "./gh.ts";
import { createIntegrations } from "./index.ts";
import type { FetchFn } from "./t3.ts";

const ENV_ID = "env-1";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup(opts: { runGh?: RunGh; fetch?: FetchFn; githubFetch?: FetchFn; withDb?: boolean } = {}) {
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
    {
      config: {
        t3Home,
        pollers: false,
        userHome: "/nonexistent",
        sessionDirs: { claudeDir: "/nonexistent/.claude", copilotDir: "/nonexistent/.copilot" },
        worktreesDir: "/nonexistent/worktrees",
        port: 4317,
        webPort: 5317,
      },
      bus,
      services: () => services!,
    },
    {
      log: { warn: () => {} },
      ...(opts.runGh ? { runGh: opts.runGh } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.githubFetch ? { githubFetch: opts.githubFetch } : {}),
    },
  );
  services = createServices({
    db: openDatabase(":memory:"),
    bus,
    t3Status: () => integrations.t3Status(),
    prHostHoldsTasks: (host) => integrations.prHostHoldsTasks(host),
  });
  return { services, integrations, events };
}

describe("createIntegrations with real services", () => {
  it("refreshLink stores a PR snapshot and surfaces attention", async () => {
    const gh = createFakeGithub();
    gh.prs.set(
      "o/r#5",
      fakePr({
        title: "Fix it",
        reviewDecision: "CHANGES_REQUESTED",
        mergeable: "CONFLICTING",
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: { nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }] },
                },
              },
            },
          ],
        },
      }),
    );
    const { services, integrations, events } = setup({ runGh: gh.runGh, githubFetch: gh.fetch });
    const project = services.projects.create({ title: "P", workspaceRoot: "C:/p" });
    const task = services.tasks.create({ projectId: project.id, title: "T" });
    const link = services.links.add(task.id, { value: "https://github.com/o/r/pull/5" }, "user");
    events.length = 0;
    await integrations.refreshLink(link.id);
    expect(services.links.get(link.id)).toMatchObject({
      snapshot: { title: "Fix it", checks: "failing", mergeable: "conflicting" },
    });
    expect(services.tasks.summary(task.id).attention.map((a) => a.kind)).toEqual([
      "pr_checks_failing",
      "pr_changes_requested",
      "pr_conflict",
    ]);
    expect(events.some((e) => e.type === "task.upserted")).toBe(true);
  });

  it("mergePr merges a Review task's PR and the task moves to Done", async () => {
    const gh = createFakeGithub();
    gh.prs.set("o/r#5", fakePr());
    const { services, integrations } = setup({ runGh: gh.runGh, githubFetch: gh.fetch });
    const project = services.projects.create({ title: "P", workspaceRoot: "C:/p" });
    const task = services.tasks.create({ projectId: project.id, title: "T" });
    services.plans.setPlan(task.id, { phases: [{ title: "Do", steps: [{ title: "It", status: "done" }] }] }, "agent");
    const link = services.links.add(task.id, { value: "https://github.com/o/r/pull/5" }, "agent");
    await integrations.refreshLink(link.id);
    services.tasks.move(task.id, { status: "review" }, "agent");
    await integrations.mergePr(link.id, { action: "merge", method: "squash" });
    expect(gh.mutations.map((m) => m.operation)).toEqual(["MergePullRequest"]);
    expect(services.links.get(link.id)).toMatchObject({ snapshot: { state: "merged" } });
    expect(services.tasks.summary(task.id).status).toBe("done");
  });

  it("refreshLink on a T3 thread link uses the shell API", async () => {
    const fetchFn: FetchFn = async (url) =>
      url.endsWith("/environment")
        ? Response.json({ environmentId: ENV_ID, label: "box" })
        : Response.json({
            projects: [],
            threads: [
              {
                id: "th1",
                projectId: "p",
                title: "Agent thread",
                status: "running",
                latestRunId: "r",
                activeProviderThreadId: null,
                pendingRuntimeRequest: { kind: "permission" },
              },
            ],
            archivedThreads: [],
          });
    const ghCalls: string[][] = [];
    const runGh: RunGh = async (args) => {
      ghCalls.push(args);
      return "";
    };
    const { services, integrations } = setup({ fetch: fetchFn, runGh });
    services.settings.update({ t3Token: "tok" });
    const project = services.projects.create({ title: "P", workspaceRoot: "C:/p" });
    const task = services.tasks.create({ projectId: project.id, title: "T" });
    const link = services.links.add(task.id, { value: `t3code://threads/${ENV_ID}/th1` }, "user");
    await integrations.refreshLink(link.id);
    expect(services.links.get(link.id)).toMatchObject({ snapshot: { title: "Agent thread", status: "approval" } });
    expect(ghCalls).toEqual([]);
    expect(services.tasks.summary(task.id).attention.map((a) => a.kind)).toEqual(["thread_needs_input"]);
    expect(integrations.t3Status()).toMatchObject({ detected: true, environmentId: ENV_ID, liveStatus: "ok" });
  });

  it("resolveLinkInput turns a pasted thread id into a thread link, checked against the shell", async () => {
    const copied = "bca46358-2812-4417-93f7-e151c0f96292";
    const fetchFn: FetchFn = async (url) =>
      url.endsWith("/environment")
        ? Response.json({ environmentId: ENV_ID, label: "box" })
        : Response.json({
            projects: [],
            threads: [{ id: copied, projectId: "p", title: "Mine", status: "completed" }],
            archivedThreads: [],
          });
    const { services, integrations } = setup({ fetch: fetchFn });
    services.settings.update({ t3Token: "tok" });
    const project = services.projects.create({ title: "P", workspaceRoot: "C:/p" });
    const task = services.tasks.create({ projectId: project.id, title: "T" });

    const resolved = await integrations.resolveLinkInput({ value: ` ${copied} `, label: "mine" });
    expect(resolved).toEqual({
      input: { label: "mine", t3Thread: { environmentId: ENV_ID, threadId: copied } },
    });
    expect(services.links.add(task.id, resolved.input, "user")).toMatchObject({
      kind: "t3_thread",
      url: `t3code://threads/${ENV_ID}/${copied}`,
      label: "mine",
      ref: { environmentId: ENV_ID, threadId: copied },
    });

    await expect(integrations.resolveLinkInput({ value: "11111111-2222-4333-8444-555555555555" })).rejects.toThrow(
      "No T3 Code thread with ID",
    );
    // Anything else, or an explicit kind, passes through untouched.
    for (const input of [{ value: "https://example.com" }, { value: copied, kind: "url" as const }]) {
      expect(await integrations.resolveLinkInput(input)).toEqual({ input });
    }
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
    expect(created[0]).toMatchObject({
      title: "Alpha",
      t3ProjectId: "t3-a",
      icon: { kind: "monogram", text: "AL", color: "teal" },
    });
    expect(
      services.projects
        .list()
        .map((p) => p.title)
        .sort(),
    ).toEqual(["Alpha", "Mine"]);
  });

  it("start() is a no-op when pollers are disabled", () => {
    let spawned = 0;
    const { integrations } = setup({
      runGh: async () => {
        spawned += 1;
        throw new Error("should not spawn");
      },
    });
    integrations.start();
    integrations.stop();
    expect(spawned).toBe(0);
  });
});
