import { networkInterfaces } from "node:os";
import { isAbsolute } from "node:path";
import {
  taskLabel,
  type HostedRunnerPairingCode,
  type HostedRunnerSetting,
  type HostedRunnerStatus,
  type UpdateHostedRunnerInput,
} from "@repo/contracts";
import type { AppContext } from "./app.ts";
import { canonicalPath, isInside } from "./autopilot/worktrees.ts";
import { hostedRunnerConfig, hostedRunnerHome, type Config } from "./config.ts";
import { AppError } from "./errors.ts";
import { addressKind } from "./http/addresses.ts";
import { messageOf } from "./integrations/util.ts";
import { mainCheckoutOf } from "./services/projects.ts";
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
  /**
   * Saves the setting and starts, restarts or stops the runner to match. CONFLICT, changing nothing, when that would
   * stop or restart it with runs in flight, unless `force` is set.
   */
  configure(input: UpdateHostedRunnerInput): Promise<HostedRunnerStatus>;
  /** Gives the running runner the board's T3 token again, after the board's changed: both use the one T3 Code. */
  syncT3Token(): void;
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

/**
 * Whether `path` is `dir` or inside it, both as the file system names them: a worktree reached through a symlink, or a
 * Windows short name (`RUNNER~1`) on one side and the long name git wrote on the other, still counts as inside.
 */
const inside = (dir: string, path: string): boolean =>
  isAbsolute(path) && isInside(canonicalPath(path), canonicalPath(dir));

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
      syncT3Token();
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

  /** The same T3 Code serves both: the runner reaches it with the board's token, and knows what that allows. */
  function syncT3Token(): void {
    if (!server) return;
    const board = deps.boardServices().settings;
    const token = board.t3Token();
    const access = board.t3Access();
    const runnerSettings = server.ctx.services.settings;
    if (runnerSettings.t3Token() !== token) runnerSettings.update({ t3Token: token });
    if (runnerSettings.t3Access() !== access) runnerSettings.setT3Access(access);
  }

  /**
   * Whether `path` is the runner's work: one of its clones or worktrees in its data dir, or a worktree of one of its
   * clones made elsewhere (T3 Code makes a thread's worktree in its own folder).
   */
  const runnersPath = (path: string): boolean => {
    if (inside(runnerHome, path)) return true;
    const checkout = isAbsolute(path) ? mainCheckoutOf(path) : null;
    return checkout !== null && inside(runnerHome, checkout.main);
  };

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

    async configure({ force, ...input }) {
      const current = deps.boardServices().settings.hostedRunner();
      const next = { ...current, ...input };
      const runs = server?.ctx.integrations.runnerHost.workInFlight() ?? 0;
      const stops = server !== null && (!next.enabled || next.bind !== runningBind);
      if (stops && runs > 0 && !force) {
        const owner = server!.ctx.services.machineAuth.pairings()[0]?.board.name ?? "another board";
        throw new AppError(
          "CONFLICT",
          `${runs} run${runs === 1 ? "" : "s"} for ${owner} ${runs === 1 ? "is" : "are"} going here, and ` +
            `${next.enabled ? "restarting" : "stopping"} the runner ends ${runs === 1 ? "it" : "them"}. Wait for ` +
            `${runs === 1 ? "it" : "them"} to finish, or do it anyway.`,
        );
      }
      deps.boardServices().settings.setHostedRunner(next);
      await enqueue();
      return this.status();
    },

    start: enqueue,

    syncT3Token,

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
      if (paths.some(runnersPath)) return runner;

      let board = false;
      let held = false;
      const both: string[] = [];
      for (const ref of tasks) {
        const found = lookup(ref);
        // A number on both boards is never guessed, whether the runner holds its task or only refers to it (the
        // epic or a blocker of a task it holds): one call could otherwise act on the wrong board's task.
        if ((found.held || found.reference) && found.board) both.push(ref);
        else if (found.held || found.reference) held = true;
        else if (found.board) board = true;
      }
      if (both.length > 0) {
        const services = server.ctx.services;
        const lines = both.map((ref) => {
          const here = deps.boardServices().tasks.summary(deps.boardServices().tasks.resolveId(ref));
          const there = services.tasks.summary(services.tasks.resolveId(ref));
          const owner = services.machineAuth.pairings()[0]?.board.name ?? "another board";
          const whose =
            services.workingCopies.role(there.id) === "held"
              ? `which this machine holds for ${owner}`
              : `on ${owner}, which a task this machine holds for it refers to`;
          return (
            `${taskLabel(here)} names two tasks: "${here.title}" on this board (id ${here.id}) and "${there.title}", ` +
            `${whose} (id ${there.id}).`
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
