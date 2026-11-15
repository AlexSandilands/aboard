import { realpathSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import {
  taskLabel,
  type HostedRunnerPairingCode,
  type HostedRunnerSetting,
  type HostedRunnerStatus,
  type UpdateHostedRunnerInput,
} from "@repo/contracts";
import type { AppContext } from "./app.ts";
import { hostedRunnerConfig, hostedRunnerHome, type Config } from "./config.ts";
import { AppError } from "./errors.ts";
import { addressKind } from "./http/addresses.ts";
import { messageOf } from "./integrations/util.ts";
import type { Services } from "./services/types.ts";

// A board that also runs tasks for another board (docs/features/remote-machines.md#a-board-that-is-also-a-runner).
// With "Let other machines run tasks here" on, the board's process starts a second server in the runner role: its
// own data dir (`<board data dir>/runner`), database, port, pairing and tokens, so nothing it holds for the other
// board is written to this board's tables, backups or stats. Agents on this machine still call the board's
// `127.0.0.1` MCP, which hands a call about a task the runner holds to the runner (`route`).

/** A server this module started: the runner, with its context so the board can read who it works for. */
export interface HostedServer {
  url: string;
  port: number;
  ctx: AppContext;
  close(): Promise<void>;
}

export interface HostedRunnerDeps {
  /** The board's config, as it runs (its port known). */
  board: Config;
  boardInstanceId: string;
  boardServices: () => Services;
  /** startServer, passed in so this module needn't import the server that imports it. */
  start(config: Config): Promise<HostedServer>;
  /** The runner started, stopped or changed what it shows. */
  changed(): void;
  log?: Pick<Console, "info" | "warn">;
}

/** Where a call belongs. `ambiguous` carries the sentence to answer it with. */
export type HostedRoute = { to: "board" } | { to: "runner"; url: string } | { to: "ambiguous"; message: string };

/** What a call names, for `route`. */
export interface CallNames {
  /** Task references (`#42`, `E7`, a uuid). */
  tasks: readonly string[];
  /** Folders: a workspacePath, a session's cwd. */
  paths: readonly string[];
  projectIds: readonly string[];
}

export interface HostedRunner {
  status(): HostedRunnerStatus;
  /** Saves the setting and starts, restarts or stops the runner to match. */
  configure(input: UpdateHostedRunnerInput): Promise<HostedRunnerStatus>;
  /** Starts the runner when the setting is on: at the board's start. A failure is kept in the status, not thrown. */
  start(): Promise<void>;
  /** A one-time code for another board. CONFLICT unless the runner is running. */
  pairingCode(): HostedRunnerPairingCode;
  /** Drops the board it works for: its token stops working at once. */
  unpair(): HostedRunnerStatus;
  /** Which store a call on this board's MCP or API belongs to. */
  route(names: CallNames): HostedRoute;
  /** Whether the runner runs now, so the board can tell its agents. */
  running(): boolean;
  close(): Promise<void>;
}

/** The machine's address on the tailnet, if it has one. */
function tailnetAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === "IPv4" && !entry.internal && addressKind(entry.address) === "tailnet") return entry.address;
    }
  }
  return null;
}

/** `path` as it really is, when it exists: a worktree reached through a symlink still counts as inside. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const inside = (dir: string, path: string): boolean => {
  if (!isAbsolute(path)) return false;
  const rel = relative(real(dir), real(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export function createHostedRunner(deps: HostedRunnerDeps): HostedRunner {
  const log = deps.log ?? console;
  let server: HostedServer | null = null;
  /** The bind it was started with, to restart it when the setting changes. */
  let runningBind: HostedRunnerSetting["bind"] | null = null;
  let state: HostedRunnerStatus["state"] = "off";
  let error: string | null = null;
  let closed = false;
  // One start or stop at a time, in the order asked.
  let queue: Promise<void> = Promise.resolve();
  const runnerHome = hostedRunnerHome(deps.board);
  const port = () => deps.board.hostedRunnerPort ?? 0;

  async function stop(): Promise<void> {
    const current = server;
    server = null;
    runningBind = null;
    if (current) await current.close();
  }

  async function apply(): Promise<void> {
    const setting = deps.boardServices().settings.hostedRunner();
    if (closed || !setting.enabled) {
      await stop();
      state = "off";
      error = null;
      deps.changed();
      return;
    }
    if (server && runningBind === setting.bind) return;
    await stop();
    state = "starting";
    error = null;
    deps.changed();
    try {
      const config = hostedRunnerConfig(deps.board, deps.boardInstanceId, setting.bind);
      const started = await deps.start(config);
      if (closed) {
        await started.close();
        return;
      }
      server = started;
      runningBind = setting.bind;
      state = "running";
      // The same T3 Code serves both: the runner reaches it with the board's token.
      const token = deps.boardServices().settings.t3Token();
      const runnerSettings = started.ctx.services.settings;
      if (token && runnerSettings.t3Token() !== token) runnerSettings.update({ t3Token: token });
      log.info(`[runner] running tasks for another board on ${started.url} (data: ${config.homeDir})`);
    } catch (cause) {
      state = "failed";
      const message = messageOf(cause);
      error = /EADDRINUSE/.test(message)
        ? `Port ${port()} is in use, maybe by another runner on this machine. Stop it, or start this board with ` +
          "another runner port."
        : message;
      log.warn(`[runner] couldn't start: ${message}`);
    }
    deps.changed();
  }

  const enqueue = (): Promise<void> => {
    queue = queue.then(apply, apply);
    return queue;
  };

  const runnerServices = (): Services => {
    if (!server) throw new AppError("CONFLICT", "Other machines can't run tasks here: the setting is off.");
    return server.ctx.services;
  };

  /** What `ref` names on each side: on the board, and as a task the runner holds or only refers to. */
  function lookup(ref: string): { board: string | null; held: string | null; reference: string | null } {
    const find = (services: Services): string | null => {
      try {
        return services.tasks.resolveId(ref);
      } catch {
        return null;
      }
    };
    const board = find(deps.boardServices());
    const runner = server ? find(server.ctx.services) : null;
    const role = runner ? server!.ctx.services.workingCopies.role(runner) : null;
    return { board, held: role === "held" ? runner : null, reference: role === "held" ? null : runner };
  }

  return {
    status() {
      const setting = deps.boardServices().settings.hostedRunner();
      const services = server?.ctx.services ?? null;
      const [pairing] = services?.machineAuth.pairings() ?? [];
      const tailnet = server && runningBind === "private" ? tailnetAddress() : null;
      return {
        enabled: setting.enabled,
        bind: setting.bind,
        state,
        error,
        port: server?.port ?? port(),
        url: server?.url ?? null,
        tailscaleUrl: tailnet && server ? `http://${tailnet}:${server.port}` : null,
        instanceId: server?.ctx.instanceId ?? null,
        name: services?.settings.get().machineName ?? null,
        board: pairing ? { ...pairing.board, pairedAt: pairing.pairedAt, lastUsedAt: pairing.lastUsedAt } : null,
        heldTasks: services?.workingCopies.heldIds().length ?? 0,
        runsInFlight: server?.ctx.integrations.runnerHost.workInFlight() ?? 0,
      };
    },

    async configure(input) {
      const current = deps.boardServices().settings.hostedRunner();
      deps.boardServices().settings.setHostedRunner({ ...current, ...input });
      await enqueue();
      return this.status();
    },

    start: enqueue,

    pairingCode() {
      const services = runnerServices();
      const { code, expiresAt } = services.machineAuth.createPairingCode();
      const status = this.status();
      return { code, expiresAt, url: status.url ?? `http://127.0.0.1:${port()}`, tailscaleUrl: status.tailscaleUrl };
    },

    unpair() {
      runnerServices().machineAuth.revokeAll();
      deps.changed();
      return this.status();
    },

    route({ tasks, paths, projectIds }) {
      if (!server) return { to: "board" };
      const runner = { to: "runner" as const, url: server.url };
      // A folder in the runner's data dir is one of its clones or worktrees: whatever else the call names, it is
      // the other board's work.
      if (paths.some((path) => inside(runnerHome, path))) return runner;

      let board = false;
      let held = false;
      const both: string[] = [];
      for (const ref of tasks) {
        const found = lookup(ref);
        if (found.held && found.board) both.push(ref);
        else if (found.held) held = true;
        else if (found.board) board = true;
        // Something the runner only refers to (the epic of a task it holds) is read there when this board has no
        // such task: it is the other board's.
        else if (found.reference) held = true;
      }
      if (both.length > 0) {
        const services = server.ctx.services;
        const lines = both.map((ref) => {
          const here = deps.boardServices().tasks.summary(deps.boardServices().tasks.resolveId(ref));
          const there = services.tasks.summary(services.tasks.resolveId(ref));
          const owner = services.machineAuth.pairings()[0]?.board.name ?? "another board";
          return (
            `${taskLabel(here)} names two tasks: "${here.title}" on this board (id ${here.id}) and "${there.title}", ` +
            `which this machine holds for ${owner} (id ${there.id}).`
          );
        });
        return {
          to: "ambiguous",
          message: `CONFLICT: ${lines.join(" ")} Call again with the id of the one you mean.`,
        };
      }
      if (held && board) {
        return {
          to: "ambiguous",
          message:
            "CONFLICT: this call names tasks on this board and tasks this machine holds for another board. A call " +
            "acts on one board: make one call for each.",
        };
      }
      if (held) return runner;
      if (board) return { to: "board" };
      const services = server.ctx.services;
      const runnerProject = projectIds.some((id) => {
        const has = (s: Services) => s.projects.list().some((p) => p.id === id);
        return has(services) && !has(deps.boardServices());
      });
      return runnerProject ? runner : { to: "board" };
    },

    running: () => server !== null,

    async close() {
      closed = true;
      await enqueue();
    },
  };
}
