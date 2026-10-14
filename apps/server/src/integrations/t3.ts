import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BRAND,
  type ConnectT3Result,
  normalizeWorkspaceKey,
  ProjectIcon,
  type Project,
  type StartT3ThreadInput,
  type T3IntegrationStatus,
  type T3LaunchOptions,
  type T3ProjectCandidate,
  type T3ThreadSnapshot,
  type TaskLink,
} from "@repo/contracts";
import { z } from "zod";
import type { EventBus } from "../bus.ts";
import { AppError } from "../errors.ts";
import type { LinksService, ProjectsService, SettingsService, TasksService } from "../services/types.ts";
import { messageOf } from "./github.ts";
import {
  buildLaunchOptions,
  resolveT3Project,
  toWorkspaceStrategy,
  WireLaunchResult,
  WireRefs,
  WireServerConfig,
} from "./t3Launch.ts";
import { openT3Rpc, T3RpcError, type OpenSocket, type T3RpcSession } from "./t3Rpc.ts";
import type { Logger } from "./util.ts";

export const DISCOVERY_INTERVAL_MS = 60_000;
export const LIVE_INTERVAL_MS = 20_000;
const DISCOVERY_TIMEOUT_MS = 2_000;
const SHELL_TIMEOUT_MS = 10_000;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

// ── Wire shapes (lenient subsets of T3 Code's contracts) ─────────────────

const RuntimeFile = z.object({ origin: z.string().min(1) });

const EnvironmentDescriptor = z.object({
  environmentId: z.string().min(1),
  label: z.string().nullish(),
});

/** Subset of OrchestrationV2ThreadShell (t3code packages/contracts/src/orchestrationV2.ts). */
export const ShellThread = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.string(),
  activityRunStatus: z.string().nullish(),
  latestRunId: z.string().nullable().optional(),
  activeProviderThreadId: z.string().nullable().optional(),
  pendingRuntimeRequest: z.object({ kind: z.string() }).loose().nullish(),
  pendingBackgroundTasks: z.array(z.object({ kind: z.string() }).loose()).optional(),
  lastErrorClass: z.string().nullish(),
  branch: z.string().nullish(),
  worktreePath: z.string().nullish(),
  updatedAt: z.string().nullish(),
  archivedAt: z.string().nullish(),
});
export type ShellThread = z.infer<typeof ShellThread>;

/** Subset of OrchestrationProjectShell. */
const ShellProject = z.object({
  id: z.string(),
  title: z.string(),
  workspaceRoot: z.string(),
  projectIcon: z.unknown().optional(),
  defaultModelSelection: z.unknown().optional(),
});

export const ShellSnapshot = z.object({
  threads: z.array(ShellThread),
  archivedThreads: z.array(ShellThread).optional(),
  projects: z.array(ShellProject),
});
export type ShellSnapshot = z.infer<typeof ShellSnapshot>;

// ── Pure mapping ─────────────────────────────────────────────────────────

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * Mirrors T3's sidebar resolution: client-runtime `presentThreadShell`/`shellRuntime`
 * (state/models.ts) feeding web `resolveSidebarThreadStatus` (Sidebar.logic.ts).
 * T3's "ready" splits into "done" (latest run completed) and "idle" (otherwise).
 */
export function mapThreadStatus(thread: ShellThread): T3ThreadSnapshot["status"] {
  const request = thread.pendingRuntimeRequest;
  if (request && request.kind !== "user_input" && request.kind !== "auth_refresh") return "approval";
  if (request?.kind === "user_input") return "input";
  // Subagents/monitors/background tasks hold completion; a left-running command does not.
  const parkAtIdle =
    (thread.pendingBackgroundTasks ?? []).some((task) => task.kind !== "command") && thread.status !== "failed";
  const hasRuntime = (thread.latestRunId ?? null) !== null || (thread.activeProviderThreadId ?? null) !== null;
  if (!hasRuntime && !parkAtIdle) return "idle";
  const runtimeStatus = parkAtIdle ? "idle" : (thread.activityRunStatus ?? thread.status);
  if (ACTIVE_RUN_STATUSES.has(runtimeStatus)) return "working";
  if (runtimeStatus === "idle") return "waiting";
  if (runtimeStatus === "failed") return "failed";
  if (runtimeStatus === "completed") return "done";
  return "idle";
}

export function mapThreadSnapshot(thread: ShellThread): T3ThreadSnapshot {
  return { title: thread.title, status: mapThreadStatus(thread) };
}

/** Parses a T3 project icon into ours, reading T3's legacy lucide+monogramText shape. Invalid → null. */
export function parseT3Icon(raw: unknown): ProjectIcon | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value && typeof value === "object" && "kind" in value && value.kind === "lucide") {
    const legacy = value as { monogramText?: unknown; monogram?: unknown; color?: unknown };
    const text = legacy.monogramText ?? legacy.monogram;
    if (typeof text === "string") value = { kind: "monogram", text, color: legacy.color };
  }
  const parsed = ProjectIcon.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ── Discovery ────────────────────────────────────────────────────────────

export interface Discovery {
  detected: boolean;
  origin: string | null;
  environmentId: string | null;
  label: string | null;
}

const NOT_DETECTED: Discovery = { detected: false, origin: null, environmentId: null, label: null };

/** Reads `<t3Home>/userdata/server-runtime.json` and probes the unauthenticated environment descriptor. */
export async function discoverT3(t3Home: string, fetchFn: FetchFn): Promise<Discovery> {
  let origin: string;
  try {
    const runtime = RuntimeFile.safeParse(
      JSON.parse(readFileSync(join(t3Home, "userdata", "server-runtime.json"), "utf8")),
    );
    if (!runtime.success) return NOT_DETECTED;
    origin = runtime.data.origin.replace(/\/+$/, "");
  } catch {
    return NOT_DETECTED;
  }
  try {
    const response = await fetchFn(`${origin}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) return NOT_DETECTED;
    const descriptor = EnvironmentDescriptor.safeParse(await response.json());
    if (!descriptor.success) return NOT_DETECTED;
    return {
      detected: true,
      origin,
      environmentId: descriptor.data.environmentId,
      label: descriptor.data.label ?? null,
    };
  } catch {
    return NOT_DETECTED;
  }
}

export class ShellError extends Error {}

/** Parses a T3 response; a mismatch means T3's protocol moved on, which the user should hear about. */
function parseWire<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("VALIDATION", `Unexpected ${what} from T3 Code (its protocol may have changed)`);
  }
  return parsed.data;
}

/** GET /api/orchestration/shell with a bearer session token (scope orchestration:read). */
export async function fetchShell(origin: string, token: string, fetchFn: FetchFn): Promise<ShellSnapshot> {
  let response: Response;
  try {
    response = await fetchFn(`${origin}/api/orchestration/shell`, {
      headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2", accept: "application/json" },
      signal: AbortSignal.timeout(SHELL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ShellError(`T3 Code unreachable: ${messageOf(error)}`);
  }
  if (response.status === 401) throw new ShellError("Token expired or revoked. Paste a new pairing link");
  if (response.status === 403) throw new ShellError("Token lacks the orchestration:read scope");
  if (!response.ok) throw new ShellError(`T3 Code returned HTTP ${response.status}`);
  const parsed = ShellSnapshot.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new ShellError("Unexpected response from T3 Code");
  return parsed.data;
}

// ── Pairing ──────────────────────────────────────────────────────────────

/** T3's pairing codes: 12 characters from an alphabet without 0, 1, I and O. */
const PAIRING_CODE = /^[2-9A-HJ-NP-Z]{12}$/;

/** What the board needs: read threads for live status, operate to start them. */
const TOKEN_SCOPES = "orchestration:read orchestration:operate";

const TokenResult = z.object({ access_token: z.string().min(1) });

/**
 * The one-time code in a T3 pairing link (`t3code://app/pair#token=…` or `<origin>/pair#token=…`) or a bare
 * pairing code. Null for anything else, which is taken to be a bearer token minted with the CLI.
 */
export function parsePairingCode(value: string): string | null {
  const trimmed = value.trim();
  const fromLink = /[#?&]token=([^&#\s]+)/.exec(trimmed)?.[1];
  if (fromLink) return fromLink;
  return PAIRING_CODE.test(trimmed) ? trimmed : null;
}

/** Trades a pairing code for a bearer token (OAuth token exchange), asking only for the board's scopes. */
export async function exchangePairingCode(origin: string, code: string, fetchFn: FetchFn): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: code,
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        scope: TOKEN_SCOPES,
        client_label: BRAND.name,
        client_device_type: "bot",
      }).toString(),
      signal: AbortSignal.timeout(SHELL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppError("VALIDATION", `T3 Code unreachable: ${messageOf(error)}`);
  }
  if (response.status === 401) {
    throw new AppError("VALIDATION", "This pairing link has expired or was already used. Create a new one in T3 Code");
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 400 && (body as { reason?: unknown } | null)?.reason === "scope_not_granted") {
    throw new AppError(
      "VALIDATION",
      "This pairing link doesn't allow “View environment” and “Operate tasks”. Create one that does",
    );
  }
  if (!response.ok) throw new AppError("VALIDATION", `T3 Code returned HTTP ${response.status}`);
  return parseWire(TokenResult, body, "token response").access_token;
}

export interface T3SqliteProject {
  t3ProjectId: string;
  title: string;
  workspaceRoot: string;
  icon: ProjectIcon | null;
}

/**
 * Reads projects from a private temp copy of `statev2.sqlite` (+ -wal/-shm). T3's live
 * database file is never opened. The copy is deleted before returning. `tempRoot` is injectable so
 * tests can observe cleanup in a private directory.
 */
export function readT3ProjectsFromSqlite(t3Home: string, tempRoot: string = tmpdir()): T3SqliteProject[] {
  const source = join(t3Home, "userdata", "statev2.sqlite");
  if (!existsSync(source)) return [];
  const dir = mkdtempSync(join(tempRoot, `${BRAND.id}-t3-`));
  try {
    const copy = join(dir, "statev2.sqlite");
    copyFileSync(source, copy);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(source + suffix)) copyFileSync(source + suffix, copy + suffix);
    }
    const db = openCopy(copy);
    try {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(projection_projects)").all() as Array<{ name: string }>).map((c) => c.name),
      );
      if (columns.size === 0) return [];
      const iconColumn = columns.has("project_icon_json") ? "project_icon_json" : "NULL";
      const rows = db
        .prepare(
          `SELECT project_id, title, workspace_root, ${iconColumn} AS project_icon_json
           FROM projection_projects WHERE deleted_at IS NULL ORDER BY created_at ASC`,
        )
        .all() as Array<{
        project_id: string;
        title: string;
        workspace_root: string;
        project_icon_json: string | null;
      }>;
      return rows.map((row) => ({
        t3ProjectId: row.project_id,
        title: row.title,
        workspaceRoot: row.workspace_root,
        icon: row.project_icon_json ? parseT3Icon(row.project_icon_json) : null,
      }));
    } finally {
      db.close();
    }
  } finally {
    // Windows can briefly hold SQLite file handles after close; retry instead of failing.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/**
 * Opens the private copy read-only. A copied WAL database may need recovery that a
 * read-only connection cannot do; since the file is our own copy, fall back to read-write.
 */
function openCopy(path: string): DatabaseSync {
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
    return db;
  } catch {
    return new DatabaseSync(path);
  }
}

// ── Integration ──────────────────────────────────────────────────────────

export interface T3Services {
  links: Pick<LinksService, "listByKind" | "setSnapshot" | "add">;
  settings: Pick<SettingsService, "t3Token" | "update">;
  projects: Pick<ProjectsService, "list" | "create" | "get">;
  tasks: Pick<TasksService, "summary">;
}

type ThreadLink = Extract<TaskLink, { kind: "t3_thread" }>;

export interface T3Integration {
  status(): T3IntegrationStatus;
  discover(): Promise<T3IntegrationStatus>;
  /** One live-status poll: shell request + snapshot updates for matching thread links. */
  pollLive(): Promise<void>;
  listProjects(): Promise<T3ProjectCandidate[]>;
  importProjects(ids: string[]): Promise<Project[]>;
  /** Models, refs and defaults for the "Start in T3 Code" dialog of a task. */
  launchOptions(taskId: string): Promise<T3LaunchOptions>;
  /** Starts a T3 thread for a task with the prompt as its first message, then links it to the task. */
  startThread(taskId: string, input: StartT3ThreadInput, actor: string): Promise<TaskLink>;
  /** Refreshes one thread link. Returns false when it is not a T3 thread link. */
  refresh(link: TaskLink): Promise<boolean>;
  test(): Promise<T3IntegrationStatus>;
  /** Saves a token, exchanging a pairing link or code for one first, then checks it with a live poll. */
  connect(value: string): Promise<ConnectT3Result>;
  start(): void;
  stop(): void;
}

export function createT3Integration(deps: {
  t3Home: string;
  bus: EventBus;
  services: () => T3Services;
  fetch?: FetchFn;
  openSocket?: OpenSocket;
  log?: Logger;
}): T3Integration {
  const fetchFn: FetchFn = deps.fetch ?? ((input, init) => fetch(input, init));
  const log = deps.log ?? console;
  let discovery: Discovery = NOT_DETECTED;
  let live: { liveStatus: T3IntegrationStatus["liveStatus"]; error: string | null } = {
    liveStatus: "off",
    error: null,
  };
  let discovered = false;
  let discovering: Promise<T3IntegrationStatus> | null = null;
  let polling: Promise<void> | null = null;
  const timers: NodeJS.Timeout[] = [];

  const token = (): string | null => {
    try {
      return deps.services().settings.t3Token();
    } catch {
      return null;
    }
  };

  const current = (): T3IntegrationStatus => ({ ...discovery, ...live });

  /** Applies a state change and publishes integrations.changed when the visible status changed. */
  const commit = (next: { discovery?: Discovery; live?: typeof live }) => {
    const before = JSON.stringify(current());
    if (next.discovery) discovery = next.discovery;
    if (next.live) live = next.live;
    // Without a token or a detected server there is no live status to report.
    if (!discovery.detected || !token()) live = { liveStatus: "off", error: null };
    const after = current();
    if (JSON.stringify(after) !== before) deps.bus.publish({ type: "integrations.changed", t3: after });
  };

  const discover = (): Promise<T3IntegrationStatus> => {
    discovering ??= discoverT3(deps.t3Home, fetchFn).then((next) => {
      discovered = true;
      discovering = null;
      commit({ discovery: next });
      return current();
    });
    return discovering;
  };

  const ensureDiscovered = async () => {
    if (!discovered) await discover();
  };

  /** Fetches the shell, recording live status. Null when unavailable. */
  const loadShell = async (): Promise<ShellSnapshot | null> => {
    const bearer = token();
    if (!bearer || !discovery.detected || !discovery.origin) {
      commit({});
      return null;
    }
    try {
      const shell = await fetchShell(discovery.origin, bearer, fetchFn);
      commit({ live: { liveStatus: "ok", error: null } });
      return shell;
    } catch (error) {
      const message = messageOf(error);
      if (live.error !== message) log.warn(`[t3] live status: ${message}`);
      commit({ live: { liveStatus: "error", error: message } });
      return null;
    }
  };

  const applyShell = (shell: ShellSnapshot, links: ReadonlyArray<ThreadLink>) => {
    const threads = new Map<string, ShellThread>();
    for (const thread of [...shell.threads, ...(shell.archivedThreads ?? [])]) threads.set(thread.id, thread);
    const linksService = deps.services().links;
    for (const link of links) {
      if (link.ref.environmentId !== discovery.environmentId) continue;
      const thread = threads.get(link.ref.threadId);
      if (thread) linksService.setSnapshot(link.id, mapThreadSnapshot(thread));
    }
  };

  const threadLinks = (): ThreadLink[] =>
    deps
      .services()
      .links.listByKind("t3_thread")
      .filter((link): link is ThreadLink => link.kind === "t3_thread");

  const pollLive = (): Promise<void> => {
    polling ??= (async () => {
      try {
        await ensureDiscovered();
        const links = threadLinks();
        const shell = await loadShell();
        if (shell) applyShell(shell, links);
      } catch (error) {
        log.warn(`[t3] live poll failed: ${messageOf(error)}`);
      } finally {
        polling = null;
      }
    })();
    return polling;
  };

  /** The task's T3 project and the live shell, or a clear reason why a thread can't be started. */
  const launchContext = async (taskId: string) => {
    await ensureDiscovered();
    const { origin, environmentId } = discovery;
    if (!discovery.detected || !origin || !environmentId) throw new AppError("VALIDATION", "T3 Code is not running");
    const bearer = token();
    if (!bearer) throw new AppError("VALIDATION", "No T3 Code token configured");
    const task = deps.services().tasks.summary(taskId);
    const project = deps.services().projects.get(task.projectId);
    const shell = await loadShell();
    if (!shell) throw new AppError("VALIDATION", live.error ?? "T3 Code is unavailable");
    const t3Project = resolveT3Project(project, shell);
    if (!t3Project) throw new AppError("VALIDATION", `${project.title} isn't a project in T3 Code`);
    return { task, shell, t3Project, origin, environmentId, bearer };
  };

  /** Runs requests on one RPC session, closing it afterwards and turning RPC failures into AppErrors. */
  const withRpc = async <T>(origin: string, bearer: string, run: (rpc: T3RpcSession) => Promise<T>): Promise<T> => {
    let rpc: T3RpcSession | null = null;
    try {
      rpc = await openT3Rpc({
        origin,
        token: bearer,
        fetch: fetchFn,
        ...(deps.openSocket ? { openSocket: deps.openSocket } : {}),
      });
      return await run(rpc);
    } catch (error) {
      if (error instanceof T3RpcError) throw new AppError("VALIDATION", error.message, { t3: error.kind });
      throw error;
    } finally {
      rpc?.close();
    }
  };

  const launchOptions = async (taskId: string): Promise<T3LaunchOptions> => {
    const ctx = await launchContext(taskId);
    return withRpc(ctx.origin, ctx.bearer, async (rpc) => {
      const config = parseWire(WireServerConfig, await rpc.request("server.getConfig", {}), "server config");
      // Refs are optional: a folder that isn't a git repo (or a failed listing) just offers the current checkout.
      const refs = await rpc
        .request("vcs.listRefs", { cwd: ctx.t3Project.workspaceRoot, limit: 100 })
        .then((value) => WireRefs.safeParse(value).data ?? null)
        .catch(() => null);
      return buildLaunchOptions({ config, refs, shell: ctx.shell, t3Project: ctx.t3Project });
    });
  };

  const startThread = async (taskId: string, input: StartT3ThreadInput, actor: string): Promise<TaskLink> => {
    const ctx = await launchContext(taskId);
    const { options, ...selection } = input.modelSelection;
    const result = await withRpc(ctx.origin, ctx.bearer, async (rpc) => {
      const raw = await rpc.request("orchestration.launchThread", {
        commandId: input.commandId ?? randomUUID(),
        projectId: ctx.t3Project.id,
        title: `#${ctx.task.number} ${ctx.task.title}`,
        modelSelection: options.length > 0 ? { ...selection, options } : selection,
        runtimeMode: input.runtimeMode,
        // T3's plan mode sits behind a client beta flag the board can't read; a thread started in it may
        // have no visible way out. "Plan with me" is carried by the prompt instead.
        interactionMode: "default",
        workspaceStrategy: toWorkspaceStrategy(input.workspace),
        initialMessage: { text: input.prompt, attachments: [] },
      });
      // The command was sent, so T3 may have accepted it; tag the failure so a retry keeps the commandId.
      const parsed = WireLaunchResult.safeParse(raw);
      if (!parsed.success) {
        throw new AppError("VALIDATION", "Unexpected launch result from T3 Code (its protocol may have changed)", {
          t3: "protocol-after-send",
        });
      }
      return parsed.data;
    });
    const link = deps
      .services()
      .links.add(taskId, { t3Thread: { environmentId: ctx.environmentId, threadId: result.threadId } }, actor);
    void pollLive();
    return link;
  };

  const listProjects = async (): Promise<T3ProjectCandidate[]> => {
    await ensureDiscovered();
    let source: T3SqliteProject[] | null = null;
    const shell = await loadShell();
    if (shell) {
      source = shell.projects.map((p) => ({
        t3ProjectId: p.id,
        title: p.title,
        workspaceRoot: p.workspaceRoot,
        icon: parseT3Icon(p.projectIcon ?? null),
      }));
    }
    if (!source) {
      try {
        source = readT3ProjectsFromSqlite(deps.t3Home);
      } catch (error) {
        log.warn(`[t3] could not read T3 projects: ${messageOf(error)}`);
        source = [];
      }
    }
    const existing = new Map<string, string>();
    for (const project of deps.services().projects.list({ includeArchived: true })) {
      const key = project.workspaceKey ?? (project.workspaceRoot ? normalizeWorkspaceKey(project.workspaceRoot) : null);
      if (key) existing.set(key, project.id);
    }
    return source.map((p) => ({
      ...p,
      existingProjectId: existing.get(normalizeWorkspaceKey(p.workspaceRoot)) ?? null,
    }));
  };

  return {
    status() {
      if (!discovered) void discover();
      return current();
    },
    discover,
    pollLive,
    listProjects,
    launchOptions,
    startThread,
    async importProjects(ids) {
      const wanted = new Set(ids);
      const candidates = (await listProjects()).filter((c) => wanted.has(c.t3ProjectId) && !c.existingProjectId);
      const projects = deps.services().projects;
      const created: Project[] = [];
      for (const candidate of candidates) {
        try {
          created.push(
            projects.create({
              title: candidate.title,
              workspaceRoot: candidate.workspaceRoot,
              icon: candidate.icon,
              t3ProjectId: candidate.t3ProjectId,
            }),
          );
        } catch (error) {
          if (error instanceof AppError && error.code === "CONFLICT") continue;
          throw error;
        }
      }
      return created;
    },
    async refresh(link) {
      if (link.kind !== "t3_thread") return false;
      await ensureDiscovered();
      if (!discovery.detected) throw new AppError("VALIDATION", "T3 Code is not running");
      if (link.ref.environmentId !== discovery.environmentId) {
        throw new AppError("VALIDATION", "This thread belongs to a different T3 Code environment");
      }
      if (!token()) throw new AppError("VALIDATION", "No T3 Code token configured");
      const shell = await loadShell();
      if (!shell) throw new AppError("VALIDATION", live.error ?? "T3 Code live status unavailable");
      applyShell(shell, [link]);
      return true;
    },
    async test() {
      await discover();
      await pollLive();
      return current();
    },
    async connect(value) {
      const code = parsePairingCode(value);
      let bearer = value.trim();
      if (code) {
        await discover();
        if (!discovery.detected || !discovery.origin) throw new AppError("VALIDATION", "T3 Code is not running");
        bearer = await exchangePairingCode(discovery.origin, code, fetchFn);
      }
      const settings = deps.services().settings.update({ t3Token: bearer });
      // A poll already in flight used the previous token; wait it out so the check uses the new one.
      await polling;
      await pollLive();
      return { settings, t3: current() };
    },
    start() {
      void discover();
      timers.push(setInterval(() => void discover(), DISCOVERY_INTERVAL_MS).unref());
      timers.push(
        setInterval(() => {
          if (deps.bus.size > 0 && token()) void pollLive();
        }, LIVE_INTERVAL_MS).unref(),
      );
    },
    stop() {
      for (const timer of timers.splice(0)) clearInterval(timer);
    },
  };
}
