import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_HARNESSES,
  AgentSessionRef,
  canFork,
  isRunningSession,
  ResumeSessionInput as ResumeSessionInputSchema,
  resumeArgv,
  type AgentSessionSnapshot,
  type AgentSessionStatus,
  type AutopilotRun,
  type ResumeCommand,
  type ResumeMode,
  type ResumeResult,
  type ResumeSessionInput,
  type TaskLink,
  type TerminalInfo,
} from "@repo/contracts";
import { z } from "zod";
import type { EventBus } from "../bus.ts";
import { AppError } from "../errors.ts";
import type { AutopilotService } from "../services/autopilot.ts";
import type { LinksService, SettingsService } from "../services/types.ts";
import { createTitleReader, tidy } from "./claudeSessionTitle.ts";
import { messageOf } from "./github.ts";
import {
  copyCommand,
  defaultShell,
  displayLaunch,
  readWtSettings,
  resolveTerminal,
  spawnTerminal,
  systemTerminalHost,
  type LaunchSpec,
  type ResolvedTerminal,
  type SpawnTerminal,
  type TerminalHost,
} from "./terminal.ts";
import type { Logger } from "./util.ts";

// Live status of linked Claude Code and Copilot CLI sessions, read from the files each harness keeps while a session
// runs. Neither format is documented, so anything unexpected reads as "unknown" rather than as a guess.

export interface SessionDirs {
  /** Claude Code's config dir: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  claudeDir: string;
  /** Copilot CLI's home: `$COPILOT_HOME`, else `~/.copilot`. */
  copilotDir: string;
}

/** OS process checks, injected so tests don't depend on real pids. */
export interface ProcessProbe {
  isAlive(pid: number): boolean;
  /**
   * When each pid's process started, in the form Claude Code writes as `procStart`. Pids it can't read are left out.
   * Null where the board can't tell (only Windows is checked so far), so pid reuse goes unnoticed there.
   */
  startTimes(pids: readonly number[]): Promise<Map<number, string> | null>;
}

const ClaudeSessionFile = z.object({
  pid: z.number().int().positive(),
  sessionId: z.string(),
  status: z.string().optional(),
  // What the user or `--name` called the session; Claude derives one from the folder and branch otherwise.
  name: z.string().optional(),
  nameSource: z.string().optional(),
  procStart: z.string().optional(),
  entrypoint: z.string().optional(),
});
type ClaudeSessionFile = z.infer<typeof ClaudeSessionFile>;

export interface ClaudeScan {
  sessions: ClaudeSessionFile[];
  /** Pids of `<pid>.json` files we couldn't read; one may be the session we are looking for. */
  unreadable: number[];
}

/** Reads `<claudeDir>/sessions/<pid>.json`. Null when the folder can't be listed. */
export function scanClaudeSessions(claudeDir: string): ClaudeScan | null {
  const dir = join(claudeDir, "sessions");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const scan: ClaudeScan = { sessions: [], unreadable: [] };
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;
    try {
      const parsed = ClaudeSessionFile.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (parsed.success) scan.sessions.push(parsed.data);
      else scan.unreadable.push(Number(match[1]));
    } catch {
      // Being written right now, or not JSON at all.
      scan.unreadable.push(Number(match[1]));
    }
  }
  return scan;
}

/** Claude Code's `status` field mapped to ours; anything new only says it runs. */
const claudeRunStatus = (status: string | undefined): AgentSessionStatus =>
  status === "busy" ? "busy" : status === "idle" ? "idle" : "running";

/** Sessions run by an app on the Agent SDK (T3 Code) say `sdk-ts`, `sdk-py` and so on; the CLI says `cli`. */
const inApp = (entrypoint: string | undefined): boolean => entrypoint?.startsWith("sdk") ?? false;

const SNAPSHOT_UNKNOWN: AgentSessionSnapshot = { status: "unknown", inApp: false };
const SNAPSHOT_NOT_RUNNING: AgentSessionSnapshot = { status: "not_running", inApp: false };

/** How long a pid's start time is trusted before it is read again. Reading it on Windows takes a few seconds. */
export const START_TIME_TTL_MS = 5 * 60_000;

export interface SessionStatusReader {
  /** Snapshots for each ref, keyed by `${harness}:${sessionId}`. */
  read(refs: readonly AgentSessionRef[]): Promise<Map<string, AgentSessionSnapshot>>;
}

export const sessionKey = (ref: Pick<AgentSessionRef, "harness" | "sessionId">) => `${ref.harness}:${ref.sessionId}`;

export function createSessionStatusReader(deps: {
  dirs: SessionDirs;
  probe: ProcessProbe;
  now?: () => number;
}): SessionStatusReader {
  const now = deps.now ?? Date.now;
  // `${pid}:${procStart}` → whether that pid's process is the one that wrote the file, and when we checked.
  const verified = new Map<string, { same: boolean; at: number }>();
  const titles = createTitleReader(deps.dirs.claudeDir);

  /** Drops session files whose pid now belongs to another process. */
  const sameProcess = async (sessions: ClaudeSessionFile[]): Promise<ClaudeSessionFile[]> => {
    const key = (s: ClaudeSessionFile) => `${s.pid}:${s.procStart}`;
    const stale = sessions.filter((s) => {
      const hit = s.procStart ? verified.get(key(s)) : undefined;
      return s.procStart && (!hit || now() - hit.at > START_TIME_TTL_MS);
    });
    if (stale.length) {
      const starts = await deps.probe.startTimes([...new Set(stale.map((s) => s.pid))]).catch(() => null);
      for (const s of stale) {
        const start = starts?.get(s.pid);
        verified.set(key(s), { same: start === undefined || start === s.procStart, at: now() });
      }
    }
    for (const k of verified.keys()) if (!sessions.some((s) => key(s) === k)) verified.delete(k);
    return sessions.filter((s) => !s.procStart || verified.get(key(s))?.same !== false);
  };

  /** A live session's own name, unless Claude only derived it from the folder, then the transcript's title. */
  const titleOf = (ref: AgentSessionRef, live: readonly ClaudeSessionFile[]): string | null => {
    const named = live.find((s) => tidy(s.name) && s.nameSource !== "derived");
    return tidy(named?.name) ?? titles.read(ref.sessionId, ref.cwd);
  };

  const claude = async (refs: readonly AgentSessionRef[], out: Map<string, AgentSessionSnapshot>) => {
    if (!refs.length) return;
    const scan = scanClaudeSessions(deps.dirs.claudeDir);
    if (!scan) {
      for (const ref of refs) {
        const title = titleOf(ref, []);
        out.set(sessionKey(ref), title ? { ...SNAPSHOT_UNKNOWN, title } : SNAPSHOT_UNKNOWN);
      }
      return;
    }
    const wanted = new Set(refs.map((r) => r.sessionId));
    const alive = await sameProcess(
      scan.sessions.filter((s) => wanted.has(s.sessionId.toLowerCase()) && deps.probe.isAlive(s.pid)),
    );
    const unreadableAlive = scan.unreadable.some((pid) => deps.probe.isAlive(pid));
    for (const ref of refs) {
      const mine = alive.filter((s) => s.sessionId.toLowerCase() === ref.sessionId);
      if (mine.length) {
        const statuses = new Set(mine.map((s) => claudeRunStatus(s.status)));
        const status = statuses.has("busy") ? "busy" : statuses.has("idle") ? "idle" : "running";
        const title = titleOf(ref, mine);
        out.set(sessionKey(ref), { status, inApp: mine.some((s) => inApp(s.entrypoint)), ...(title ? { title } : {}) });
      } else {
        const base = unreadableAlive ? SNAPSHOT_UNKNOWN : SNAPSHOT_NOT_RUNNING;
        const title = titleOf(ref, []);
        out.set(sessionKey(ref), title ? { ...base, title } : base);
      }
    }
  };

  /** `<copilotDir>/session-state/<id>/inuse.<pid>.lock` exists while a Copilot CLI process has the session open. */
  const copilot = (ref: AgentSessionRef): AgentSessionSnapshot => {
    const root = join(deps.dirs.copilotDir, "session-state");
    let names: string[];
    try {
      readdirSync(root);
    } catch {
      return SNAPSHOT_UNKNOWN;
    }
    try {
      names = readdirSync(join(root, ref.sessionId));
    } catch {
      // Copilot hasn't written this session (yet), so nothing has it open.
      return SNAPSHOT_NOT_RUNNING;
    }
    const pids = names.flatMap((name) => {
      const match = /^inuse\.(\d+)\.lock$/.exec(name);
      return match ? [Number(match[1])] : [];
    });
    return pids.some((pid) => deps.probe.isAlive(pid)) ? { status: "running", inApp: false } : SNAPSHOT_NOT_RUNNING;
  };

  return {
    async read(refs) {
      const out = new Map<string, AgentSessionSnapshot>();
      await claude(
        refs.filter((r) => r.harness === "claude-code"),
        out,
      );
      for (const ref of refs) if (ref.harness === "copilot-cli") out.set(sessionKey(ref), copilot(ref));
      return out;
    },
  };
}

// ── The real process probe ───────────────────────────────────────────────

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Process start times as Windows FILETIMEs, which is what Claude Code writes as `procStart` there. One PowerShell
 * call for all pids; pids are numbers, so nothing from a file reaches the command as text.
 */
function windowsStartTimes(pids: readonly number[]): Promise<Map<number, string>> {
  const script =
    `Get-Process -Id ${pids.map((pid) => Math.trunc(pid)).join(",")} -ErrorAction SilentlyContinue | ` +
    'ForEach-Object { try { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" } catch {} }';
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 15_000, windowsHide: true },
      (error, stdout) => {
        // Get-Process exits non-zero when some pid is gone; the lines for the rest are still good.
        if (error && !stdout) return reject(error);
        const starts = new Map<number, string>();
        for (const line of stdout.split(/\r?\n/)) {
          const match = /^(\d+) (\d+)$/.exec(line.trim());
          if (match) starts.set(Number(match[1]), match[2]!);
        }
        resolve(starts);
      },
    );
  });
}

export const systemProcessProbe: ProcessProbe = {
  isAlive: isPidAlive,
  startTimes: (pids) => (process.platform === "win32" && pids.length ? windowsStartTimes(pids) : Promise.resolve(null)),
};

// ── The integration: polling and resuming ────────────────────────────────

export const SESSION_INTERVAL_MS = 20_000;
/** A poll that takes this long is given up on, so one hung read (PowerShell, a stalled disk) can't end polling. */
export const SESSION_POLL_TIMEOUT_MS = 30_000;

/** A session id that only shows what a terminal setting would run. */
const EXAMPLE_SESSION_ID = "00000000-0000-4000-8000-000000000000";

export interface AgentSessionServices {
  links: Pick<LinksService, "listByKind" | "setSnapshot" | "get">;
  settings: Pick<SettingsService, "get">;
  autopilot: Pick<AutopilotService, "runForSession">;
}

/**
 * What an Autopilot run says of the headless session it made: working while the run is going, then finished or
 * failed. The process behind it isn't one anyone can read from the harness's files while it runs. A run that never
 * started (skipped, a dry run) has no session, so only queued, running, failed and succeeded come here.
 */
export function runSnapshot(run: Pick<AutopilotRun, "status" | "finishedAt" | "updatedAt">): AgentSessionSnapshot {
  if (run.status === "queued" || run.status === "running") return { status: "busy", inApp: false };
  return {
    status: run.status === "failed" ? "failed" : "finished",
    inApp: false,
    endedAt: run.finishedAt ?? run.updatedAt,
  };
}

const runIsGoing = (run: Pick<AutopilotRun, "status">): boolean => run.status === "queued" || run.status === "running";

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });

type SessionLink = Extract<TaskLink, { kind: "agent_session" }>;

export interface AgentSessionsIntegration {
  /** Reads every linked session's status and stores what changed. */
  pollLive(): Promise<void>;
  /** Refreshes one link. False when it isn't an agent session. */
  refresh(link: TaskLink): Promise<boolean>;
  /** Refreshes the link of this session, if the board has one: its Autopilot run was linked or ended. */
  refreshSession(sessionId: string): Promise<void>;
  /** What to paste to resume by hand, for the shell "Open in terminal" would use. */
  resumeCommand(linkId: string, mode: ResumeMode): ResumeCommand;
  /**
   * Opens the session in a new terminal. Throws CONFLICT when it is running (unless forced, or forking, which
   * starts a new session), VALIDATION when its folder is gone. A terminal that won't start isn't an error: the
   * result carries the command to copy instead.
   */
  resume(linkId: string, input: ResumeSessionInput): Promise<ResumeResult>;
  terminalInfo(): TerminalInfo;
  start(): void;
  stop(): void;
}

export function createAgentSessionsIntegration(deps: {
  services: () => AgentSessionServices;
  bus: Pick<EventBus, "size">;
  dirs: SessionDirs;
  userHome: string;
  probe?: ProcessProbe;
  host?: () => TerminalHost;
  spawn?: SpawnTerminal;
  log?: Logger;
}): AgentSessionsIntegration {
  const reader = createSessionStatusReader({ dirs: deps.dirs, probe: deps.probe ?? systemProcessProbe });
  const host = deps.host ?? systemTerminalHost;
  const spawnFn = deps.spawn ?? spawnTerminal;
  const log = deps.log ?? console;
  let polling: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const sessionLinks = (): SessionLink[] =>
    deps
      .services()
      .links.listByKind("agent_session")
      .filter((l): l is SessionLink => l.kind === "agent_session");

  /**
   * Reads and stores each link's status. A session Autopilot ran takes it from the run: working while the run goes,
   * finished or failed once it ended, unless the process is alive again (someone resumed it) and says so itself.
   */
  const store = async (links: readonly SessionLink[]): Promise<Map<string, AgentSessionSnapshot>> => {
    const s = deps.services();
    const runs = new Map(
      links.flatMap((l) => {
        const run = s.autopilot.runForSession(l.ref.sessionId);
        return run ? [[l.id, run] as const] : [];
      }),
    );
    const read = await reader.read(
      links.filter((l) => !runIsGoing(runs.get(l.id) ?? { status: "succeeded" })).map((l) => l.ref),
    );
    const snapshots = new Map<string, AgentSessionSnapshot>();
    for (const link of links) {
      const key = sessionKey(link.ref);
      const run = runs.get(link.id);
      const live = read.get(key);
      // A run's snapshot says nothing of the session's title, which a label-less link falls back on: keep the one read.
      const fromRun = run && (runIsGoing(run) || !isRunningSession(live?.status));
      const snapshot = !run
        ? live
        : fromRun
          ? { ...runSnapshot(run), ...(live?.title ? { title: live.title } : {}) }
          : live;
      if (!snapshot) continue;
      snapshots.set(key, snapshot);
      s.links.setSnapshot(link.id, snapshot);
    }
    return snapshots;
  };

  const pollLive = (): Promise<void> => {
    // A poll that times out is only given up on, not stopped: if it finishes later it may overwrite a newer
    // snapshot, which the next poll corrects.
    // `.finally` runs after this assignment even when the poll has nothing to await; resetting inside the async
    // function would run first in that case and leave `polling` set for good.
    polling ??= withTimeout(
      (async () => {
        const links = sessionLinks();
        if (links.length) await store(links);
      })(),
      SESSION_POLL_TIMEOUT_MS,
    )
      .catch((error: unknown) => log.warn(`[sessions] poll failed: ${messageOf(error)}`))
      .finally(() => {
        polling = null;
      });
    return polling;
  };

  /** The stored link, checked again: the command is built from it alone, never from the request. */
  const sessionOf = (linkId: string, mode: ResumeMode): { link: SessionLink; ref: AgentSessionRef } => {
    const link = deps.services().links.get(linkId);
    if (link.kind !== "agent_session") throw new AppError("VALIDATION", "Not an agent session link");
    const parsed = AgentSessionRef.safeParse(link.ref);
    if (!parsed.success) throw new AppError("VALIDATION", "The link's session id or folder isn't valid");
    if (mode === "fork" && !canFork(parsed.data.harness)) {
      throw new AppError("VALIDATION", `${AGENT_HARNESSES[parsed.data.harness].label} sessions can't be forked`);
    }
    return { link, ref: parsed.data };
  };

  const terminal = (): { resolved: ResolvedTerminal | null; error: string | null; host: TerminalHost } => {
    const h = host();
    try {
      const settings = deps.services().settings.get();
      return { resolved: resolveTerminal(settings.terminal, h, settings.terminalOpenIn), error: null, host: h };
    } catch (error) {
      return { resolved: null, error: messageOf(error), host: h };
    }
  };

  const copyFor = (resolved: ResolvedTerminal | null, h: TerminalHost, ref: AgentSessionRef, mode: ResumeMode) =>
    copyCommand(resolved?.shell ?? defaultShell(h.platform), resumeArgv(ref, mode), ref.cwd);

  return {
    pollLive,

    async refresh(link) {
      if (link.kind !== "agent_session") return false;
      await store([link]);
      return true;
    },

    async refreshSession(sessionId) {
      const links = sessionLinks().filter((l) => l.ref.sessionId === sessionId.toLowerCase());
      if (links.length) await store(links);
    },

    resumeCommand(linkId, mode) {
      const { ref } = sessionOf(linkId, mode);
      const { resolved, host: h } = terminal();
      return { command: copyFor(resolved, h, ref, mode), cwd: ref.cwd };
    },

    async resume(linkId, input) {
      const { mode, force } = ResumeSessionInputSchema.parse(input);
      const { link, ref } = sessionOf(linkId, mode);
      if (!isDirectory(ref.cwd)) throw new AppError("VALIDATION", `The session's folder no longer exists: ${ref.cwd}`);
      // Check now rather than trust the last poll: opening a running session twice makes two writers on one history.
      const snapshot = (await store([link])).get(sessionKey(ref));
      if (mode === "resume" && !force && isRunningSession(snapshot?.status)) {
        throw new AppError("CONFLICT", "The session is still running", snapshot);
      }
      const { resolved, error, host: h } = terminal();
      const command = copyFor(resolved, h, ref, mode);
      if (!resolved) return { launched: false, command, error };
      let spec: LaunchSpec;
      try {
        spec = resolved.launch(resumeArgv(ref, mode), ref.cwd);
      } catch (launchError) {
        // A folder this terminal can't be given safely: the user can still run the command by hand.
        return { launched: false, command, error: messageOf(launchError) };
      }
      try {
        await spawnFn(spec);
        return { launched: true, command, error: null };
      } catch (spawnError) {
        log.warn(`[sessions] couldn't start ${displayLaunch(spec, h.platform)}: ${messageOf(spawnError)}`);
        return { launched: false, command, error: `Couldn't start ${resolved.label}: ${messageOf(spawnError)}` };
      }
    },

    terminalInfo() {
      const { resolved, error, host: h } = terminal();
      let autoLabel: string;
      try {
        autoLabel = resolveTerminal({ kind: "auto" }, h).label;
      } catch (autoError) {
        autoLabel = messageOf(autoError);
      }
      const wt = h.platform === "win32" ? readWtSettings(h) : null;
      const example = resumeArgv({ harness: "claude-code", sessionId: EXAMPLE_SESSION_ID }, "resume");
      let preview: string | null = null;
      let previewError = error;
      if (resolved) {
        try {
          preview = displayLaunch(resolved.launch(example, deps.userHome), h.platform);
        } catch (launchError) {
          previewError = messageOf(launchError);
        }
      }
      return {
        platform: h.platform,
        autoLabel,
        profiles: (wt?.profiles ?? []).map(({ guid, name, shell }) => ({ guid, name, shell })),
        defaultProfile: wt?.defaultProfile ?? null,
        preview,
        error: previewError,
      };
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (deps.bus.size > 0) void pollLive();
      }, SESSION_INTERVAL_MS).unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
