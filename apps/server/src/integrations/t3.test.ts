import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BoardEvent,
  CreateProjectInput,
  LinkInput,
  Project,
  StartT3ThreadInput,
  T3ThreadSnapshot,
  TaskLink,
  TaskSummary,
} from "@repo/contracts";
import { BRAND, normalizeWorkspaceKey } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../bus.ts";
import type { LinkSnapshot } from "../services/types.ts";
import { AppError } from "../errors.ts";
import { fakeSocket, success, type SentFrame } from "../test/fakeT3Socket.ts";
import {
  createT3Integration,
  discoverT3,
  isT3Unavailable,
  mapThreadSnapshot,
  parsePairingCode,
  parseT3Icon,
  readT3ProjectsFromSqlite,
  ShellThread,
  type FetchFn,
  type T3Services,
  type ThreadLink,
} from "./t3.ts";
import { defaultSettings } from "../test/fixtures.ts";

const ENV_ID = "19032d81-04ac-423c-a5b0-f71db3f71200";
const ORIGIN = "http://127.0.0.1:3773";
/** A thread id as T3's "Copy thread ID" gives it. */
const COPIED_ID = "bca46358-2812-4417-93f7-e151c0f96292";

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

  it("keeps the title and defaults the detail fields", () => {
    expect(mapThreadSnapshot(thread({ id: "t", title: "Fix login" }))).toEqual({
      title: "Fix login",
      status: "done",
      settled: false,
      archived: false,
      lastActivityAt: null,
      model: null,
      branch: null,
    });
  });

  it("maps settled, archived, model and branch", () => {
    const snapshot = mapThreadSnapshot(
      thread({
        id: "t",
        settledOverride: "settled",
        archivedAt: "2026-01-02T00:00:00Z",
        modelSelection: { model: "claude-opus-5-5" },
        branch: "feat/x",
      }),
    );
    expect(snapshot).toMatchObject({
      settled: true,
      archived: true,
      model: "claude-opus-5-5",
      branch: "feat/x",
    });
  });

  it("tolerates odd display fields instead of failing the parse", () => {
    const parsed = ShellThread.parse({ ...thread({ id: "t" }), modelSelection: "opus", latestUserMessageAt: 5 });
    expect(mapThreadSnapshot(parsed)).toMatchObject({ model: null, lastActivityAt: null });
  });

  it("does not treat an 'active' override as settled", () => {
    expect(mapThreadSnapshot(thread({ id: "t", settledOverride: "active" })).settled).toBe(false);
  });

  it("takes the newest message or run stamp as last activity", () => {
    const snapshot = mapThreadSnapshot(
      thread({
        id: "t",
        updatedAt: "2026-01-09T00:00:00Z",
        latestUserMessageAt: "2026-01-03T00:00:00Z",
        latestVisibleMessage: { updatedAt: "2026-01-05T00:00:00Z" },
        latestRunCompletedAt: "2026-01-04T00:00:00Z",
      }),
    );
    expect(snapshot.lastActivityAt).toBe("2026-01-05T00:00:00Z");
  });

  it("falls back to updatedAt without any activity stamps", () => {
    expect(mapThreadSnapshot(thread({ id: "t", updatedAt: "2026-01-09T00:00:00Z" })).lastActivityAt).toBe(
      "2026-01-09T00:00:00Z",
    );
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
  const snapshots = new Map<string, LinkSnapshot | null>();
  const projects = [...(opts.projects ?? [])];
  const added: Array<{ taskId: string; input: LinkInput; actor: string }> = [];
  let token = opts.token ?? null;
  const services: T3Services = {
    links: {
      listByKind: (kind) => (opts.links ?? []).filter((l) => l.kind === kind),
      setSnapshot: (id, snapshot) => void snapshots.set(id, snapshot),
      add: (taskId, input, actor) => {
        added.push({ taskId, input, actor });
        return threadLink("l-new", input.t3Thread!.threadId, input.t3Thread!.environmentId);
      },
    },
    settings: {
      get: () => ({ ...defaultSettings, t3TokenSet: Boolean(token) }),
      t3Token: () => token,
      update: (input) => {
        if (input.t3Token !== undefined) token = input.t3Token;
        return { ...defaultSettings, t3TokenSet: Boolean(token) };
      },
    },
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
          reviewSkill: null,
          planSkill: null,
          variables: [],
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
    { ...thread({ id: COPIED_ID }), archivedAt: null },
  ],
  archivedThreads: [
    { ...thread({ id: "th-old", status: "completed", title: "Old" }), archivedAt: "2026-02-01T00:00:00.000Z" },
    { ...thread({ id: "thread:project:p1:old" }), archivedAt: "2026-02-01T00:00:00.000Z" },
  ],
};

function t3Fetch(
  opts: {
    shellStatus?: number;
    onShell?: (init: RequestInit | undefined) => void;
    exchange?: { status: number; body: unknown };
    onExchange?: (init: RequestInit | undefined) => void;
  } = {},
): FetchFn {
  return async (url, init) => {
    if (url.endsWith("/oauth/token")) {
      opts.onExchange?.(init);
      const exchange = opts.exchange ?? {
        status: 200,
        body: {
          access_token: "fresh",
          issued_token_type: "x",
          token_type: "Bearer",
          expires_in: 60,
          scope: "orchestration:read orchestration:operate",
        },
      };
      return json(exchange.body, exchange.status);
    }
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
    expect(snapshots.get("l-run")).toMatchObject({ title: "Build integrations", status: "working" });
    expect(snapshots.get("l-ask")).toMatchObject({ title: "Thread th-ask", status: "input" });
    expect(snapshots.get("l-old")).toMatchObject({ title: "Old", status: "done", archived: true });
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
    expect(await t3.test()).toMatchObject({
      detected: true,
      liveStatus: "error",
      error: "Token expired or revoked. Paste a new pairing link",
    });
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

// Built at runtime so the source holds no pairing-code-shaped literal for secret scanners to flag.
const CODE = "ABCD".repeat(3);

describe("parsePairingCode", () => {
  it("reads the code from desktop and web pairing links and bare codes", () => {
    expect(parsePairingCode(` t3code://app/pair#token=${CODE} `)).toBe(CODE);
    expect(parsePairingCode(`http://127.0.0.1:3773/pair#token=${CODE}`)).toBe(CODE);
    expect(parsePairingCode(CODE)).toBe(CODE);
    expect(parsePairingCode(CODE.toLowerCase())).toBe(CODE);
  });

  it("treats anything else as a bearer token", () => {
    expect(parsePairingCode("header.payload.sig")).toBeNull();
    expect(parsePairingCode("not-a-code")).toBeNull();
    expect(parsePairingCode("8438L44EVD2")).toBeNull();
  });
});

describe("T3 connect", () => {
  const LINK = `t3code://app/pair#token=${CODE}`;

  it("exchanges a pairing link for a token with only the board's scopes, saves it and checks it", async () => {
    const { services } = fakeServices();
    let form = new URLSearchParams();
    let shellAuth: string | undefined;
    const t3 = createT3Integration({
      t3Home: makeT3Home(),
      bus: new EventBus(),
      services: () => services,
      fetch: t3Fetch({
        onExchange: (init) => void (form = new URLSearchParams(init?.body as string)),
        onShell: (init) => void (shellAuth = (init?.headers as Record<string, string> | undefined)?.authorization),
      }),
    });
    const result = await t3.connect(LINK);
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: CODE,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      scope: "orchestration:read orchestration:operate",
      client_label: BRAND.name,
    });
    expect(services.settings.t3Token()).toBe("fresh");
    expect(shellAuth).toBe("Bearer fresh");
    expect(result.settings.t3TokenSet).toBe(true);
    expect(result.t3.liveStatus).toBe("ok");
  });

  it("saves anything that isn't a pairing link as a token without an exchange", async () => {
    const { services } = fakeServices();
    let exchanged = false;
    const t3 = createT3Integration({
      t3Home: makeT3Home(),
      bus: new EventBus(),
      services: () => services,
      fetch: t3Fetch({ onExchange: () => void (exchanged = true) }),
    });
    await t3.connect("  cli-token  ");
    expect(exchanged).toBe(false);
    expect(services.settings.t3Token()).toBe("cli-token");
  });

  it.each([
    [401, { code: "auth_invalid" }, /expired or was already used/],
    [400, { code: "invalid_request", reason: "scope_not_granted" }, /View environment/],
    [500, {}, /HTTP 500/],
  ])("keeps the current token when T3 answers %i", async (status, body, message) => {
    const { services } = fakeServices({ token: "old" });
    const t3 = createT3Integration({
      t3Home: makeT3Home(),
      bus: new EventBus(),
      services: () => services,
      fetch: t3Fetch({ exchange: { status, body } }),
    });
    await expect(t3.connect(LINK)).rejects.toThrow(message);
    expect(services.settings.t3Token()).toBe("old");
  });

  it("needs T3 Code running to exchange a pairing link", async () => {
    const { services } = fakeServices();
    const t3 = createT3Integration({
      t3Home: makeT3Home({ runtime: false }),
      bus: new EventBus(),
      services: () => services,
      fetch: t3Fetch(),
    });
    await expect(t3.connect(LINK)).rejects.toThrow("T3 Code is not running");
  });

  it("connects a read-only link but warns that starting threads needs Operate tasks", async () => {
    const { services } = fakeServices();
    const t3 = createT3Integration({
      t3Home: makeT3Home(),
      bus: new EventBus(),
      services: () => services,
      fetch: t3Fetch({
        exchange: { status: 200, body: { access_token: "fresh", token_type: "Bearer", scope: "orchestration:read" } },
      }),
    });
    const result = await t3.connect(LINK);
    expect(result.warning).toContain("Operate tasks");
  });

  it("rejects a link that carries something other than a pairing code", async () => {
    const { services } = fakeServices();
    const t3 = createT3Integration({
      t3Home: makeT3Home(),
      bus: new EventBus(),
      services: () => services,
      fetch: t3Fetch(),
    });
    await expect(t3.connect("https://example.com/#token=nope")).rejects.toThrow("isn't a T3 pairing link");
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
    reviewSkill: null,
    planSkill: null,
    variables: [],
    position: "a0",
    collapsed: false,
    archivedAt: null,
    createdAt: "",
    updatedAt: "",
  };

  const setup = (reply: (frame: SentFrame) => unknown, token: string | null = "tok", fetch: FetchFn = t3Fetch()) => {
    const fake = fakeServices({ token, projects: [acme] });
    const socket = fakeSocket(reply);
    const t3 = createT3Integration({
      t3Home: makeT3Home(),
      bus: new EventBus(),
      services: () => fake.services,
      fetch,
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
    const commandId = "6f1c7f2e-2d8f-4f0b-9a57-0c7f0e5b1d2a";
    const link = await t3.startThread("task-1", { ...LAUNCH, commandId }, "user");
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]!.tag).toBe("orchestration.launchThread");
    expect(socket.sent[0]!.payload).toMatchObject({
      commandId,
      projectId: "t3-p1",
      title: "#9 Hand off",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
      initialMessage: { text: "Let us work on #9", attachments: [] },
    });
    expect(added).toEqual([
      { taskId: "task-1", input: { t3Thread: { environmentId: ENV_ID, threadId: "th-new" } }, actor: "user" },
    ]);
    expect(link.kind).toBe("t3_thread");
  });

  it("launches a task's thread without the dialog in a new worktree, and links it", async () => {
    const { t3, socket, added } = setup((frame) => {
      if (frame.tag === "server.getConfig") return success(frame.id, SERVER_CONFIG);
      if (frame.tag === "vcs.listRefs") {
        return success(frame.id, {
          isRepo: true,
          refs: [{ name: "main", current: true, isDefault: true, worktreePath: "C:\\Code\\acme" }],
        });
      }
      return success(frame.id, { threadId: "th-auto", resumed: false });
    });
    const commandId = "6f1c7f2e-2d8f-5f0b-9a57-0c7f0e5b1d2a";
    const launched = await t3.launchTaskThread(
      "task-1",
      { prompt: "Let us work on #9", commandId, work: true, baseRef: "feat/x" },
      "orch",
    );
    expect(socket.sent.map((f) => f.tag)).toEqual(["server.getConfig", "vcs.listRefs", "orchestration.launchThread"]);
    expect(socket.sent[2]!.payload).toMatchObject({
      projectId: "t3-p1",
      title: "#9 Hand off",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      runtimeMode: "full-access",
      commandId,
      // A named base is usually another task's local branch, so it isn't taken from origin.
      workspaceStrategy: { type: "worktree", baseRef: "feat/x", startFromOrigin: false },
      initialMessage: { text: "Let us work on #9", attachments: [] },
    });
    expect(added).toEqual([
      { taskId: "task-1", input: { t3Thread: { environmentId: ENV_ID, threadId: "th-auto" } }, actor: "orch" },
    ]);
    expect(launched).toMatchObject({ runtimeMode: "full-access", suggestionUnavailable: null });
  });

  it("titles an unattended launch with the title it was given", async () => {
    const { t3, socket } = setup((frame) => {
      if (frame.tag === "server.getConfig") return success(frame.id, SERVER_CONFIG);
      if (frame.tag === "vcs.listRefs") return success(frame.id, { isRepo: true, refs: [] });
      return success(frame.id, { threadId: "th-auto", resumed: false });
    });
    await t3.launchTaskThread(
      "task-1",
      { prompt: "x", commandId: "c", work: true, baseRef: "main", title: "Autopilot · Start planned · #9" },
      "orch",
    );
    expect(socket.sent.find((f) => f.tag === "orchestration.launchThread")!.payload).toMatchObject({
      title: "Autopilot · Start planned · #9",
    });
  });

  it("starts a thread about a whole project, titled by the caller, without linking it", async () => {
    const { t3, socket, added } = setup((frame) => success(frame.id, { threadId: "th-proj", resumed: false }));
    const ref = await t3.startProjectThread("proj-acme", LAUNCH, "Suggest epics: Acme");
    expect(socket.sent[0]!.payload).toMatchObject({ projectId: "t3-p1", title: "Suggest epics: Acme" });
    expect(ref).toEqual({ environmentId: ENV_ID, threadId: "th-proj" });
    expect(added).toEqual([]);
  });

  it("refuses a launch without the dialog when T3 couldn't list the branches", async () => {
    const { t3, socket, added } = setup((frame) =>
      frame.tag === "server.getConfig" ? success(frame.id, SERVER_CONFIG) : success(frame.id, { unexpected: true }),
    );
    await expect(t3.launchTaskThread("task-1", { prompt: "x", commandId: "c", work: true }, "orch")).rejects.toThrow(
      "couldn't list the project's branches",
    );
    expect(socket.sent.map((f) => f.tag)).not.toContain("orchestration.launchThread");
    expect(added).toEqual([]);
  });

  describe("right after a restart", () => {
    const optionsReply = (frame: SentFrame) =>
      frame.tag === "server.getConfig"
        ? success(frame.id, SERVER_CONFIG)
        : success(frame.id, {
            isRepo: true,
            refs: [{ name: "main", current: true, isDefault: true, worktreePath: "x" }],
          });

    /** T3 doesn't answer the first `failures` requests for `path`, then does. */
    const flaky = (path: string, failures: number): FetchFn => {
      const inner = t3Fetch();
      let left = failures;
      return (url, init) => {
        if (url.endsWith(path) && left-- > 0) return Promise.reject(new Error("connect ECONNREFUSED"));
        return inner(url, init);
      };
    };

    it("looks again when the discovery before it missed T3, instead of reporting it isn't running", async () => {
      const { t3 } = setup(optionsReply, "tok", flaky("/.well-known/t3/environment", 1));
      expect((await t3.discover()).detected).toBe(false);
      expect(t3.status().detected).toBe(false);
      const options = await t3.launchOptions("task-1");
      expect(options.t3ProjectId).toBe("t3-p1");
      expect(t3.status().detected).toBe(true);
    });

    it("a launch that comes while the first discovery is still going sees T3", async () => {
      const inner = t3Fetch();
      const slow: FetchFn = async (url, init) => {
        if (url.endsWith("/.well-known/t3/environment")) await new Promise((resolve) => setTimeout(resolve, 20));
        return inner(url, init);
      };
      const { t3 } = setup(optionsReply, "tok", slow);
      void t3.discover();
      expect((await t3.launchOptions("task-1")).t3ProjectId).toBe("t3-p1");
    });

    it("tags the model catalog and posting into a thread too, after looking again", async () => {
      const { t3 } = setup(optionsReply, "tok", flaky("/.well-known/t3/environment", 99));
      expect(isT3Unavailable(await t3.modelCatalog().catch((e) => e))).toBe(true);
      const link = threadLink("l1", "th-wt") as ThreadLink;
      expect(isT3Unavailable(await t3.sendToThread(link, "x", "c").catch((e) => e))).toBe(true);
      const retried = setup(
        (frame) => (frame.tag === "server.getConfig" ? success(frame.id, SERVER_CONFIG) : undefined),
        "tok",
        flaky("/.well-known/t3/environment", 1),
      );
      await retried.t3.discover();
      expect((await retried.t3.modelCatalog()).providers).toHaveLength(1);
    });

    it("tags a branch listing that lost the connection as unavailable, but not one T3 answered oddly", async () => {
      const ref: { emit?: (type: string) => void } = {};
      const dropped = setup((frame) => {
        if (frame.tag === "server.getConfig") return success(frame.id, SERVER_CONFIG);
        queueMicrotask(() => ref.emit?.("close"));
        return undefined;
      });
      ref.emit = dropped.socket.emit;
      const error = await dropped.t3
        .launchTaskThread("task-1", { prompt: "x", commandId: "c", work: true }, "o")
        .catch((e) => e);
      expect(error.message).toContain("couldn't list the project's branches");
      expect(isT3Unavailable(error)).toBe(true);
      expect(dropped.added).toEqual([]);
    });

    it("looks again when the shell can't be reached, in case T3 moved", async () => {
      const { t3, added } = setup(
        (frame) =>
          frame.tag === "server.getConfig"
            ? success(frame.id, SERVER_CONFIG)
            : frame.tag === "vcs.listRefs"
              ? success(frame.id, { isRepo: true, refs: [] })
              : success(frame.id, { threadId: "th-new", resumed: false }),
        "tok",
        flaky("/api/orchestration/shell", 1),
      );
      await t3.launchTaskThread("task-1", { prompt: "x", commandId: "c", work: true, baseRef: "main" }, "orch");
      expect(added).toHaveLength(1);
    });

    it("tags a T3 that stays unreachable as unavailable, so callers can wait for it", async () => {
      const gone = setup(optionsReply, "tok", flaky("/.well-known/t3/environment", 99));
      const error = await gone.t3
        .launchTaskThread("task-1", { prompt: "x", commandId: "c", work: true }, "o")
        .catch((e) => e);
      expect(error).toMatchObject({ message: "T3 Code is not running" });
      expect(isT3Unavailable(error)).toBe(true);
      const shellGone = setup(optionsReply, "tok", flaky("/api/orchestration/shell", 99));
      expect(isT3Unavailable(await shellGone.t3.launchOptions("task-1").catch((e) => e))).toBe(true);
    });

    it("doesn't tag a real refusal as unavailable", async () => {
      const noToken = setup(optionsReply, null);
      expect(isT3Unavailable(await noToken.t3.launchOptions("task-1").catch((e) => e))).toBe(false);
      const noRefs = setup((frame) =>
        frame.tag === "server.getConfig" ? success(frame.id, SERVER_CONFIG) : success(frame.id, { unexpected: true }),
      );
      const error = await noRefs.t3
        .launchTaskThread("task-1", { prompt: "x", commandId: "c", work: true }, "o")
        .catch((e) => e);
      expect(error.message).toContain("couldn't list the project's branches");
      expect(isT3Unavailable(error)).toBe(false);
    });
  });

  it("tags an unreadable launch result so a retry keeps its commandId", async () => {
    const { t3, added } = setup((frame) => success(frame.id, { unexpected: true }));
    await expect(t3.startThread("task-1", LAUNCH, "user")).rejects.toMatchObject({
      code: "VALIDATION",
      details: { t3: "protocol-after-send" },
    });
    expect(added).toEqual([]);
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

  it("posts a message into a linked thread with T3 choosing how to deliver it", async () => {
    const { t3, socket } = setup((frame) => success(frame.id, { sequence: 1 }));
    await t3.sendToThread(threadLink("l1", "th-wt") as ThreadLink, "Review round 1 is waiting", "cmd-1");
    expect(socket.sent.map((f) => f.tag)).toEqual(["orchestration.dispatchCommand"]);
    expect(socket.sent[0]!.payload).toMatchObject({
      type: "message.dispatch",
      commandId: "cmd-1",
      threadId: "th-wt",
      text: "Review round 1 is waiting",
      attachments: [],
      deliveryIntent: "auto",
    });
    await expect(t3.sendToThread(threadLink("l2", "th-wt", "other-env") as ThreadLink, "x", "c")).rejects.toThrow(
      "different T3 Code environment",
    );
  });

  it("reads a linked thread's worktree from the shell", async () => {
    const { t3 } = setup(() => undefined);
    await t3.discover();
    expect(await t3.threadWorkspace(threadLink("l1", "th-wt") as ThreadLink)).toEqual({
      worktreePath: "C:/Users/me/.t3/worktrees/acme/t3-1",
      branch: "t3/feature",
      runStatus: "completed",
      latestRunId: "run-1",
      lastError: null,
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(await t3.threadWorkspace(threadLink("l2", "th-missing") as ThreadLink)).toBeNull();
  });

  it("asks T3 to prepare a failed run's workspace again", async () => {
    const { t3, socket } = setup((frame) => success(frame.id, { sequence: 1 }));
    await t3.retryPreparation(threadLink("l1", "th-wt") as ThreadLink, "run-1", "autopilot-r1-retry");
    expect(socket.sent.map((f) => f.tag)).toEqual(["orchestration.dispatchCommand"]);
    expect(socket.sent[0]!.payload).toEqual({
      type: "prepared-run.retry",
      commandId: "autopilot-r1-retry",
      threadId: "th-wt",
      runId: "run-1",
    });
  });
});

describe("T3 resolveThread", () => {
  const setup = (opts: { token?: string | null; runtime?: boolean; shellStatus?: number } = {}) => {
    const fake = fakeServices({ token: opts.token === undefined ? "tok" : opts.token });
    return createT3Integration({
      t3Home: makeT3Home({ runtime: opts.runtime ?? true }),
      bus: new EventBus(),
      services: () => fake.services,
      fetch: t3Fetch(opts.shellStatus ? { shellStatus: opts.shellStatus } : {}),
      log: { warn: () => {} },
    });
  };
  const ref = (threadId: string) => ({ environmentId: ENV_ID, threadId });

  it("links an existing thread in the detected environment, archived ones too", async () => {
    const t3 = setup();
    expect(await t3.resolveThread(` ${COPIED_ID} `)).toEqual({ ref: ref(COPIED_ID) });
    expect(await t3.resolveThread("thread:project:p1:old")).toEqual({ ref: ref("thread:project:p1:old") });
  });

  it("takes a browser URL of this T3 and ignores everything else", async () => {
    const t3 = setup();
    expect(await t3.resolveThread(`${ORIGIN}/${ENV_ID}/${COPIED_ID}`)).toEqual({ ref: ref(COPIED_ID) });
    expect(await t3.resolveThread("https://example.com/a/b")).toBeNull();
    expect(await t3.resolveThread("ABC-123")).toBeNull();
    expect(await t3.resolveThread("t3code://threads/env/th-run")).toBeNull();
  });

  it("rejects an id T3 doesn't know", async () => {
    await expect(setup().resolveThread("11111111-2222-4333-8444-555555555555")).rejects.toMatchObject({
      code: "VALIDATION",
      message: "No T3 Code thread with ID 11111111-2222-4333-8444-555555555555",
    });
  });

  it("accepts with a warning when T3 can't be asked", async () => {
    const noToken = await setup({ token: null }).resolveThread(COPIED_ID);
    expect(noToken).toMatchObject({ ref: ref(COPIED_ID), warning: expect.stringContaining("no T3 Code token") });
    const rejected = await setup({ shellStatus: 401 }).resolveThread(COPIED_ID);
    expect(rejected).toMatchObject({ ref: ref(COPIED_ID), warning: expect.stringContaining("Token expired") });
  });

  it("explains that a bare id needs T3 running", async () => {
    await expect(setup({ runtime: false }).resolveThread(COPIED_ID)).rejects.toThrow("T3 Code isn't running");
    expect(await setup({ runtime: false }).resolveThread("https://example.com")).toBeNull();
  });
});

describe("T3 sqlite import", () => {
  const PROJECTS: Array<[string, string, string, string | null, string | null]> = [
    ["a", "Alpha", "C:\\Work\\alpha", '{"kind":"emoji","emoji":"🧪"}', null],
    ["b", "Beta", "/home/me/beta", '{"kind":"lucide","name":"NOT VALID","color":"blue"}', null],
    ["c", "Gone", "/home/me/gone", null, "2026-03-01T00:00:00Z"],
  ];

  it("reads non-deleted projects from a temp copy and cleans it up", () => {
    const home = makeT3Home({ runtime: false, projects: PROJECTS });
    // A private temp root, so copies made by other processes can't show up in the listing.
    const tempRoot = mkdtempSync(join(tmpdir(), `${BRAND.id}-t3root-`));
    expect(readT3ProjectsFromSqlite(home, tempRoot)).toEqual([
      { t3ProjectId: "a", title: "Alpha", workspaceRoot: "C:\\Work\\alpha", icon: { kind: "emoji", emoji: "🧪" } },
      { t3ProjectId: "b", title: "Beta", workspaceRoot: "/home/me/beta", icon: null },
    ]);
    expect(readdirSync(tempRoot)).toEqual([]);
    rmSync(tempRoot, { recursive: true, force: true });
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
