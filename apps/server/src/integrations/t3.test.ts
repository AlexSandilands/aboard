import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BoardEvent,
  CreateProjectInput,
  LinkInput,
  PrSnapshot,
  Project,
  StartT3ThreadInput,
  T3ThreadSnapshot,
  TaskLink,
  TaskSummary,
} from "@repo/contracts";
import { BRAND, normalizeWorkspaceKey } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../bus.ts";
import { AppError } from "../errors.ts";
import { fakeSocket, success, type SentFrame } from "../test/fakeT3Socket.ts";
import {
  createT3Integration,
  discoverT3,
  mapThreadSnapshot,
  parseT3Icon,
  readT3ProjectsFromSqlite,
  ShellThread,
  type FetchFn,
  type T3Services,
} from "./t3.ts";

const ENV_ID = "19032d81-04ac-423c-a5b0-f71db3f71200";
const ORIGIN = "http://127.0.0.1:3773";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeT3Home(
  opts: { runtime?: boolean; projects?: Array<[string, string, string, string | null, string | null]> } = {},
) {
  const home = mkdtempSync(join(tmpdir(), `${BRAND.id}-t3home-`));
  tempDirs.push(home);
  mkdirSync(join(home, "userdata"));
  if (opts.runtime !== false) {
    writeFileSync(
      join(home, "userdata", "server-runtime.json"),
      JSON.stringify({
        version: 1,
        pid: 1,
        host: "127.0.0.1",
        port: 3773,
        origin: ORIGIN,
        startedAt: "2026-10-12T22:36:33.817Z",
      }),
    );
  }
  if (opts.projects) {
    const db = new DatabaseSync(join(home, "userdata", "statev2.sqlite"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL,
      scripts_json TEXT NOT NULL DEFAULT '[]', project_icon_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`);
    const insert = db.prepare(
      "INSERT INTO projection_projects (project_id, title, workspace_root, project_icon_json, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    opts.projects.forEach(([id, title, root, icon, deletedAt], i) =>
      insert.run(id, title, root, icon, `2026-01-0${i + 1}T00:00:00Z`, "2026-01-01T00:00:00Z", deletedAt),
    );
    // Leave the connection open so the -wal file holds the rows, like a live T3 server.
    openDbs.push(db);
  }
  return home;
}
const openDbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const thread = (overrides: Partial<ShellThread> & { id: string }): ShellThread =>
  ShellThread.parse({
    projectId: "p1",
    title: `Thread ${overrides.id}`,
    status: "completed",
    latestRunId: "run-1",
    activeProviderThreadId: "pt-1",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    ...overrides,
  });

describe("mapThreadSnapshot", () => {
  it.each<[string, Partial<ShellThread>, T3ThreadSnapshot["status"]]>([
    ["approval request", { status: "running", pendingRuntimeRequest: { kind: "command" } }, "approval"],
    ["user input request", { status: "running", pendingRuntimeRequest: { kind: "user_input" } }, "input"],
    [
      "auth refresh is not an approval",
      { status: "running", pendingRuntimeRequest: { kind: "auth_refresh" } },
      "working",
    ],
    ["running", { status: "running" }, "working"],
    ["queued", { status: "queued" }, "working"],
    ["activity run status wins", { status: "completed", activityRunStatus: "starting" }, "working"],
    ["idle shell status", { status: "idle" }, "waiting"],
    ["subagent holds completion", { status: "completed", pendingBackgroundTasks: [{ kind: "subagent" }] }, "waiting"],
    [
      "left-running command does not hold",
      { status: "completed", pendingBackgroundTasks: [{ kind: "command" }] },
      "done",
    ],
    ["failed", { status: "failed" }, "failed"],
    ["usage limited is failed", { status: "failed", lastErrorClass: "usage_limit" }, "failed"],
    ["completed", { status: "completed" }, "done"],
    ["interrupted", { status: "interrupted" }, "idle"],
    ["never ran", { status: "idle", latestRunId: null, activeProviderThreadId: null }, "idle"],
  ])("%s", (_name, overrides, expected) => {
    expect(mapThreadSnapshot(thread({ id: "t", ...overrides })).status).toBe(expected);
  });

  it("keeps the title", () => {
    expect(mapThreadSnapshot(thread({ id: "t", title: "Fix login" }))).toEqual({ title: "Fix login", status: "done" });
  });
});

describe("parseT3Icon", () => {
  it("accepts valid icons and drops invalid ones", () => {
    expect(parseT3Icon('{"kind":"lucide","name":"rocket","color":"blue"}')).toEqual({
      kind: "lucide",
      name: "rocket",
      color: "blue",
    });
    expect(parseT3Icon({ kind: "emoji", emoji: "🚀" })).toEqual({ kind: "emoji", emoji: "🚀" });
    expect(parseT3Icon('{"kind":"lucide","name":"folder","color":"red","monogramText":"TB"}')).toEqual({
      kind: "monogram",
      text: "TB",
      color: "red",
    });
    expect(parseT3Icon('{"kind":"lucide","name":"Bad Name","color":"blue"}')).toBeNull();
    expect(parseT3Icon('{"kind":"hologram"}')).toBeNull();
    expect(parseT3Icon("not json")).toBeNull();
  });
});

describe("discoverT3", () => {
  it("reads server-runtime.json and the environment descriptor", async () => {
    const home = makeT3Home();
    const urls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      urls.push(url);
      return json({ environmentId: ENV_ID, label: "MY-PC", platform: { os: "windows", arch: "x64" } });
    };
    expect(await discoverT3(home, fetchFn)).toEqual({
      detected: true,
      origin: ORIGIN,
      environmentId: ENV_ID,
      label: "MY-PC",
    });
    expect(urls).toEqual([`${ORIGIN}/.well-known/t3/environment`]);
  });

  it("is not detected without a runtime file or when the server is down", async () => {
    const fail: FetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    expect((await discoverT3(makeT3Home({ runtime: false }), fail)).detected).toBe(false);
    expect((await discoverT3(makeT3Home(), fail)).detected).toBe(false);
    expect((await discoverT3(makeT3Home(), async () => json({}, 404))).detected).toBe(false);
  });
});

// ── Integration with fake services ────────────────────────────────────────

function threadLink(id: string, threadId: string, environmentId = ENV_ID): TaskLink {
  return {
    id,
    taskId: "task",
    kind: "t3_thread",
    url: `t3code://threads/${environmentId}/${threadId}`,
    label: null,
    syncedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    ref: { environmentId, threadId },
    snapshot: null,
  };
}

function fakeServices(opts: { token?: string | null; links?: TaskLink[]; projects?: Project[] } = {}) {
  const snapshots = new Map<string, PrSnapshot | T3ThreadSnapshot | null>();
  const projects = [...(opts.projects ?? [])];
  const added: Array<{ taskId: string; input: LinkInput; actor: string }> = [];
  const services: T3Services = {
    links: {
      listByKind: (kind) => (opts.links ?? []).filter((l) => l.kind === kind),
      setSnapshot: (id, snapshot) => void snapshots.set(id, snapshot),
      add: (taskId, input, actor) => {
        added.push({ taskId, input, actor });
        return threadLink("l-new", input.t3Thread!.threadId, input.t3Thread!.environmentId);
      },
    },
    settings: { t3Token: () => opts.token ?? null },
    tasks: {
      summary: (id) => ({ id, number: 9, title: "Hand off", projectId: projects[0]?.id ?? "none" }) as TaskSummary,
    },
    projects: {
      get: (id) => projects.find((p) => p.id === id)!,
      list: () => projects,
      create: (input: CreateProjectInput) => {
        const key = input.workspaceRoot ? normalizeWorkspaceKey(input.workspaceRoot) : null;
        if (key && projects.some((p) => p.workspaceKey === key)) throw new AppError("CONFLICT", "exists");
        const project: Project = {
          id: `proj-${projects.length + 1}`,
          title: input.title ?? "untitled",
          workspaceRoot: input.workspaceRoot ?? null,
          workspaceKey: key,
          icon: input.icon ?? null,
          t3ProjectId: input.t3ProjectId ?? null,
          position: "a0",
          collapsed: false,
          archivedAt: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        };
        projects.push(project);
        return project;
      },
    },
  };
  return { services, snapshots, projects, added };
}

const SHELL_FIXTURE = {
  schemaVersion: 1,
  snapshotSequence: 42,
  projects: [
    {
      id: "t3-p1",
      title: "Acme",
      workspaceRoot: "C:\\Code\\acme",
      defaultModelSelection: null,
      projectIcon: { kind: "lucide", name: "kanban", color: "violet" },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "t3-p2",
      title: "T3 Code",
      workspaceRoot: "C:/Code/t3code",
      defaultModelSelection: null,
      projectIcon: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  threads: [
    {
      ...thread({ id: "th-run", status: "running", title: "Build integrations" }),
      archivedAt: null,
      deletedAt: null,
      itemCount: 3,
    },
    { ...thread({ id: "th-ask", status: "running", pendingRuntimeRequest: { kind: "user_input" } }), archivedAt: null },
    {
      ...thread({ id: "th-wt", projectId: "t3-p1" }),
      worktreePath: "C:/Users/me/.t3/worktrees/acme/t3-1",
      branch: "t3/feature",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: null,
    },
  ],
  archivedThreads: [
    { ...thread({ id: "th-old", status: "completed", title: "Old" }), archivedAt: "2026-02-01T00:00:00.000Z" },
  ],
};

function t3Fetch(opts: { shellStatus?: number; onShell?: (init: RequestInit | undefined) => void } = {}): FetchFn {
  return async (url, init) => {
    if (url.endsWith("/api/auth/websocket-ticket")) return json({ ticket: "tick", expiresAt: "x" });
    if (url.endsWith("/.well-known/t3/environment")) return json({ environmentId: ENV_ID, label: "MY-PC" });
    if (url.endsWith("/api/orchestration/shell")) {
      opts.onShell?.(init);
      return opts.shellStatus && opts.shellStatus !== 200
        ? json({ _tag: "EnvironmentAuthInvalidError" }, opts.shellStatus)
        : json(SHELL_FIXTURE);
    }
    return json({}, 404);
  };
}

describe("T3 integration", () => {
  it("discovers lazily and publishes integrations.changed once per change", async () => {
    const bus = new EventBus();
    const events: BoardEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const { services } = fakeServices();
    const t3 = createT3Integration({ t3Home: makeT3Home(), bus, services: () => services, fetch: t3Fetch() });
    expect(t3.status().detected).toBe(false);
    const status = await t3.discover();
    expect(status).toEqual({
      detected: true,
      origin: ORIGIN,
      environmentId: ENV_ID,
      label: "MY-PC",
      liveStatus: "off",
      error: null,
    });
    await t3.discover();
    expect(events.filter((e) => e.type === "integrations.changed")).toHaveLength(1);
  });

  it("polls the shell with bearer + protocol headers and updates matching thread links", async () => {
    const links = [
      threadLink("l-run", "th-run"),
      threadLink("l-ask", "th-ask"),
      threadLink("l-old", "th-old"),
      threadLink("l-other", "th-run", "other-env"),
      threadLink("l-gone", "missing"),
    ];
    const { services, snapshots } = fakeServices({ token: "tok", links });
    let headers: Record<string, string> = {};
    const t3 = createT3Integration({
      t3Home: makeT3Home(),
      bus: new EventBus(),
      services: () => services,
      fetch: t3Fetch({ onShell: (init) => void (headers = init?.headers as Record<string, string>) }),
    });
    const status = await t3.test();
    expect(status.liveStatus).toBe("ok");
    expect(headers).toMatchObject({ authorization: "Bearer tok", "x-t3-orchestration-protocol": "2" });
    expect(snapshots.get("l-run")).toEqual({ title: "Build integrations", status: "working" });
    expect(snapshots.get("l-ask")).toEqual({ title: "Thread th-ask", status: "input" });
    expect(snapshots.get("l-old")).toEqual({ title: "Old", status: "done" });
    expect(snapshots.has("l-other")).toBe(false);
    expect(snapshots.has("l-gone")).toBe(false);
  });

  it("reports a rejected token", async () => {
    const { services } = fakeServices({ token: "bad" });
    const t3 = createT3Integration({
      t3Home: makeT3Home(),
      bus: new EventBus(),
      services: () => services,
      fetch: t3Fetch({ shellStatus: 401 }),
      log: { warn: () => {} },
    });
    expect(await t3.test()).toMatchObject({ detected: true, liveStatus: "error", error: "Token rejected" });
  });

  it("lists projects from the shell when a token works, marking existing ones", async () => {
    const existing = fakeServices({ token: "tok" });
    existing.services.projects.create({ title: "Mine", workspaceRoot: "c:/code/acme/" });
    const t3 = createT3Integration({
      t3Home: makeT3Home(),
      bus: new EventBus(),
      services: () => existing.services,
      fetch: t3Fetch(),
    });
    const candidates = await t3.listProjects();
    expect(candidates).toEqual([
      {
        t3ProjectId: "t3-p1",
        title: "Acme",
        workspaceRoot: "C:\\Code\\acme",
        icon: { kind: "lucide", name: "kanban", color: "violet" },
        existingProjectId: "proj-1",
      },
      { t3ProjectId: "t3-p2", title: "T3 Code", workspaceRoot: "C:/Code/t3code", icon: null, existingProjectId: null },
    ]);
    const created = await t3.importProjects(["t3-p1", "t3-p2", "unknown"]);
    expect(created.map((p) => [p.title, p.t3ProjectId])).toEqual([["T3 Code", "t3-p2"]]);
  });
});

const SERVER_CONFIG = {
  providers: [
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      displayName: "Claude",
      enabled: true,
      status: "ready",
      models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, isDefault: true }],
    },
  ],
  settings: { favorites: [], defaultModelSelection: null, defaultRuntimeMode: "full-access" },
};

const LAUNCH: StartT3ThreadInput = {
  prompt: "Let us work on #9",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [] },
  runtimeMode: "full-access",
  interactionMode: "plan",
  workspace: { mode: "new_worktree", baseRef: "main", startFromOrigin: true },
};

describe("T3 thread launch", () => {
  const acme: Project = {
    id: "proj-acme",
    title: "Acme",
    workspaceRoot: "c:/code/acme",
    workspaceKey: normalizeWorkspaceKey("c:/code/acme"),
    icon: null,
    t3ProjectId: null,
    position: "a0",
    collapsed: false,
    archivedAt: null,
    createdAt: "",
    updatedAt: "",
  };

  const setup = (reply: (frame: SentFrame) => unknown, token: string | null = "tok") => {
    const fake = fakeServices({ token, projects: [acme] });
    const socket = fakeSocket(reply);
    const t3 = createT3Integration({
      t3Home: makeT3Home(),
      bus: new EventBus(),
      services: () => fake.services,
      fetch: t3Fetch(),
      openSocket: socket.open,
    });
    return { ...fake, socket, t3 };
  };

  it("loads launch options for the T3 project with the same folder", async () => {
    const { t3, socket } = setup((frame) =>
      frame.tag === "server.getConfig"
        ? success(frame.id, SERVER_CONFIG)
        : success(frame.id, {
            isRepo: true,
            refs: [{ name: "main", current: true, isDefault: true, worktreePath: "C:\\Code\\acme" }],
          }),
    );
    const options = await t3.launchOptions("task-1");
    expect(socket.sent.map((f) => [f.tag, f.payload])).toEqual([
      ["server.getConfig", {}],
      ["vcs.listRefs", { cwd: "C:\\Code\\acme", limit: 100 }],
    ]);
    expect(options).toMatchObject({
      t3ProjectId: "t3-p1",
      isRepo: true,
      previousWorktree: { worktreePath: "C:/Users/me/.t3/worktrees/acme/t3-1", branch: "t3/feature" },
      defaults: {
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [] },
        runtimeMode: "full-access",
        envMode: "local",
      },
    });
    expect(socket.closed).toBe(true);
  });

  it("launches a thread and links it to the task", async () => {
    const { t3, socket, added } = setup((frame) => success(frame.id, { threadId: "th-new", resumed: false }));
    const link = await t3.startThread("task-1", LAUNCH, "user");
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]!.tag).toBe("orchestration.launchThread");
    expect(socket.sent[0]!.payload).toMatchObject({
      projectId: "t3-p1",
      title: "#9 Hand off",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      runtimeMode: "full-access",
      interactionMode: "plan",
      workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
      initialMessage: { text: "Let us work on #9", attachments: [] },
    });
    expect(added).toEqual([
      { taskId: "task-1", input: { t3Thread: { environmentId: ENV_ID, threadId: "th-new" } }, actor: "user" },
    ]);
    expect(link.kind).toBe("t3_thread");
  });

  it("explains why a launch can't happen", async () => {
    await expect(setup(() => undefined, null).t3.launchOptions("task-1")).rejects.toThrow("No T3 Code token");
    const forbidden = setup((frame) => ({
      _tag: "Exit",
      requestId: frame.id,
      exit: {
        _tag: "Failure",
        cause: [
          { _tag: "Fail", error: { _tag: "EnvironmentAuthorizationError", requiredScope: "orchestration:operate" } },
        ],
      },
    }));
    await expect(forbidden.t3.startThread("task-1", LAUNCH, "user")).rejects.toThrow(
      "lacks the orchestration:operate scope",
    );
    expect(forbidden.added).toEqual([]);
  });
});

describe("T3 sqlite import", () => {
  const PROJECTS: Array<[string, string, string, string | null, string | null]> = [
    ["a", "Alpha", "C:\\Work\\alpha", '{"kind":"emoji","emoji":"🧪"}', null],
    ["b", "Beta", "/home/me/beta", '{"kind":"lucide","name":"NOT VALID","color":"blue"}', null],
    ["c", "Gone", "/home/me/gone", null, "2026-03-01T00:00:00Z"],
  ];

  const tempCopies = () => readdirSync(tmpdir()).filter((name) => name.startsWith(`${BRAND.id}-t3-`));

  it("reads non-deleted projects from a temp copy and cleans it up", () => {
    const home = makeT3Home({ runtime: false, projects: PROJECTS });
    const before = tempCopies();
    expect(readT3ProjectsFromSqlite(home)).toEqual([
      { t3ProjectId: "a", title: "Alpha", workspaceRoot: "C:\\Work\\alpha", icon: { kind: "emoji", emoji: "🧪" } },
      { t3ProjectId: "b", title: "Beta", workspaceRoot: "/home/me/beta", icon: null },
    ]);
    expect(tempCopies()).toEqual(before);
  });

  it("falls back to the sqlite copy without a token and imports", async () => {
    const home = makeT3Home({ runtime: false, projects: PROJECTS });
    const { services } = fakeServices({ token: null });
    const t3 = createT3Integration({ t3Home: home, bus: new EventBus(), services: () => services, fetch: t3Fetch() });
    const candidates = await t3.listProjects();
    expect(candidates.map((c) => [c.t3ProjectId, c.existingProjectId])).toEqual([
      ["a", null],
      ["b", null],
    ]);
    const created = await t3.importProjects(["a"]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      title: "Alpha",
      workspaceRoot: "C:\\Work\\alpha",
      icon: { kind: "emoji", emoji: "🧪" },
      t3ProjectId: "a",
    });
    expect((await t3.listProjects())[0]!.existingProjectId).toBe(created[0]!.id);
  });

  it("returns nothing when there is no T3 database", () => {
    expect(readT3ProjectsFromSqlite(makeT3Home({ runtime: false }))).toEqual([]);
  });
});
