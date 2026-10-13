import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeWorkspaceKey,
  ProjectIcon,
  type Project,
  type T3IntegrationStatus,
  type T3ProjectCandidate,
  type T3ThreadSnapshot,
  type TaskLink,
} from "@taskboard/contracts";
import { z } from "zod";
import type { EventBus } from "../bus.ts";
import { AppError } from "../errors.ts";
import type { LinksService, ProjectsService, SettingsService } from "../services/types.ts";
import { messageOf } from "./github.ts";
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
});
export type ShellThread = z.infer<typeof ShellThread>;

/** Subset of OrchestrationProjectShell. */
const ShellProject = z.object({
  id: z.string(),
  title: z.string(),
  workspaceRoot: z.string(),
  projectIcon: z.unknown().optional(),
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
    const runtime = RuntimeFile.safeParse(JSON.parse(readFileSync(join(t3Home, "userdata", "server-runtime.json"), "utf8")));
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
    return { detected: true, origin, environmentId: descriptor.data.environmentId, label: descriptor.data.label ?? null };
  } catch {
    return NOT_DETECTED;
  }
}

export class ShellError extends Error {}

/** GET /api/orchestration/shell with a CLI-issued bearer session token (scope orchestration:read). */
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
  if (response.status === 401) throw new ShellError("Token rejected");
  if (response.status === 403) throw new ShellError("Token lacks the orchestration:read scope");
  if (!response.ok) throw new ShellError(`T3 Code returned HTTP ${response.status}`);
  const parsed = ShellSnapshot.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new ShellError("Unexpected response from T3 Code");
  return parsed.data;
}

export interface T3SqliteProject {
  t3ProjectId: string;
  title: string;
  workspaceRoot: string;
  icon: ProjectIcon | null;
}

/**
 * Reads projects from a private temp copy of `statev2.sqlite` (+ -wal/-shm). T3's live
 * database file is never opened. The copy is deleted before returning.
 */
export function readT3ProjectsFromSqlite(t3Home: string): T3SqliteProject[] {
  const source = join(t3Home, "userdata", "statev2.sqlite");
  if (!existsSync(source)) return [];
  const dir = mkdtempSync(join(tmpdir(), "taskboard-t3-"));
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
        .all() as Array<{ project_id: string; title: string; workspace_root: string; project_icon_json: string | null }>;
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
    rmSync(dir, { recursive: true, force: true });
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
  links: Pick<LinksService, "listByKind" | "setSnapshot">;
  settings: Pick<SettingsService, "t3Token">;
  projects: Pick<ProjectsService, "list" | "create">;
}

type ThreadLink = Extract<TaskLink, { kind: "t3_thread" }>;

export interface T3Integration {
  status(): T3IntegrationStatus;
  discover(): Promise<T3IntegrationStatus>;
  /** One live-status poll: shell request + snapshot updates for matching thread links. */
  pollLive(): Promise<void>;
  listProjects(): Promise<T3ProjectCandidate[]>;
  importProjects(ids: string[]): Promise<Project[]>;
  /** Refreshes one thread link. Returns false when it is not a T3 thread link. */
  refresh(link: TaskLink): Promise<boolean>;
  test(): Promise<T3IntegrationStatus>;
  start(): void;
  stop(): void;
}

export function createT3Integration(deps: {
  t3Home: string;
  bus: EventBus;
  services: () => T3Services;
  fetch?: FetchFn;
  log?: Logger;
}): T3Integration {
  const fetchFn: FetchFn = deps.fetch ?? ((input, init) => fetch(input, init));
  const log = deps.log ?? console;
  let discovery: Discovery = NOT_DETECTED;
  let live: { liveStatus: T3IntegrationStatus["liveStatus"]; error: string | null } = { liveStatus: "off", error: null };
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
    return source.map((p) => ({ ...p, existingProjectId: existing.get(normalizeWorkspaceKey(p.workspaceRoot)) ?? null }));
  };

  return {
    status() {
      if (!discovered) void discover();
      return current();
    },
    discover,
    pollLive,
    listProjects,
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
