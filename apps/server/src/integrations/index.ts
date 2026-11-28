import { createUsageSweep } from "./usageSweep.ts";
import { randomUUID } from "node:crypto";
import { taskLabel, epicBranchName, planningSessionLabel, type AutopilotRun, type T3ThreadRef } from "@repo/contracts";
import { createWorktreeCleanup } from "../autopilot/cleanup.ts";
import { ensureEpicBranch } from "../autopilot/epicBranch.ts";
import { createDigestGenerator } from "../autopilot/digest.ts";
import { createAutopilotEngine } from "../autopilot/engine.ts";
import { createAutopilotRunner } from "../autopilot/runner.ts";
import type { Automation, Runner } from "../autopilot/types.ts";
import type { RunShell } from "./shellCommand.ts";
import type { RunScript } from "./scriptRunner.ts";
import type { EventBus } from "../bus.ts";
import { boardUrlOf, type Config } from "../config.ts";
import { tasksToPlan } from "../services/planning.ts";
import type { Services } from "../services/types.ts";
import { createAgentModels, type AgentModelProbes } from "./agentModels.ts";
import { createAgentSessionsIntegration, type ProcessProbe } from "./agentSessions.ts";
import { createRepoGate, gateFetches } from "../autopilot/repoGate.ts";
import { createBackupIntegration, defaultRunGit, type RunGit } from "./backup.ts";
import type { RunGh } from "./gh.ts";
import { createBackupSetup } from "./backupSetup.ts";
import type { GitHostReads } from "./gitHost.ts";
import { createGitHosts, gitHostActions, gitHostIssues } from "./gitHosts.ts";
import { createGithubHost } from "./githubHost.ts";
import { createRepoUrls, remoteRepo } from "./gitRemote.ts";
import { createRunTokens } from "../mcp/runTokens.ts";
import { RUN_TOOLS_PATH, type RunToolsContext } from "../mcp/runTools.ts";
import { createPrMerges } from "./prMerge.ts";
import { createPrPoller } from "./prPoller.ts";
import { messageOf } from "./util.ts";
import { mergeTaskPr } from "./mergeTaskPr.ts";
import type { RunAgent } from "./headlessAgent.ts";
import type { RunImport } from "./headlessImport.ts";
import type { RunHeadless } from "./headlessReview.ts";
import { createIssueImporter } from "./issueImport.ts";
import { createMachineClient } from "./machineClient.ts";
import { createMachineSecrets, createMemoryMachineSecrets } from "./machineSecrets.ts";
import { createBridgeChannel } from "./machines/bridgeChannel.ts";
import { createCheckouts, type CloneRepo } from "./machines/checkouts.ts";
import { createMachinesIntegration } from "./machines/index.ts";
import { createMachineSync } from "./machines/sync.ts";
import { createAutopilotSync } from "./machines/autopilotSync.ts";
import { handOverAtStart } from "./machines/startOn.ts";
import { taskRunsOn } from "../services/runOn.ts";
import { createMachineJobs } from "./machines/jobs.ts";
import { createReattacher } from "./machines/reattach.ts";
import { createRemoteWork } from "./machines/remoteWork.ts";
import { createRunnerInteractive } from "./machines/runnerInteractive.ts";
import { withMachineThreads } from "./machines/remoteT3.ts";
import { asRunnerRequest, createRunnerWork } from "./machines/runnerWork.ts";
import { boardPlacement, runnerPlacement } from "../autopilot/placement.ts";
import { runScript } from "./scriptRunner.ts";
import { runShellCommand } from "./shellCommand.ts";
import { createLoginDetector, type LoginProbes } from "./machines/logins.ts";
import { createSelfUpdater, type SelfUpdateDeps } from "./machines/selfUpdate.ts";
import { createRouteOpener, type TunnelDeps } from "./machines/tunnel.ts";
import { createModelPriceService } from "./modelPrices.ts";
import { createProviders, type ProviderProbes } from "./providers.ts";
import { createReviewFallbacks, machineWorktreeOf } from "./reviewFallbacks.ts";
import { createCustomHandoffLauncher } from "./customHandoff.ts";
import { createSessionLaunch } from "./sessionLaunch.ts";
import { createSessionTranscriptReader } from "./sessionTranscript.ts";
import { createSettingsAsker } from "./settingsAsk.ts";
import { createT3Integration, type FetchFn } from "./t3.ts";
import type { OpenSocket } from "./t3Rpc.ts";
import { spawnTerminal, systemTerminalHost, type SpawnTerminal, type TerminalHost } from "./terminal.ts";
import type { Integrations, RunnerHost } from "./types.ts";
import type { Logger } from "./util.ts";
import { AppError } from "../errors.ts";

export interface IntegrationDeps {
  config: Pick<
    Config,
    "t3Home" | "pollers" | "sessionDirs" | "userHome" | "worktreesDir" | "attachmentsDir" | "port" | "webPort"
  > &
    Partial<Pick<Config, "token" | "webDist" | "role" | "releaseUrl" | "hostedBy">> & {
      /** `<data dir>/machine-tokens.json`; null keeps the tokens in memory (an in-memory board). */
      machineSecretsPath?: string | null;
      /** `<data dir>/repos`: where a runner clones the board's projects. */
      reposDir: string;
      /** This board's id (instance.ts), which owns its folder in the backup repo. */
      instanceId: string;
      /** Where the backup setup offers to keep the backup clone: `<data dir>/backup`. */
      backupDefaultDir: string;
      /** `<data dir>/model-prices.json`; null keeps the fetched price list in memory only (an in-memory board). */
      modelPricesPath: string | null;
    };
  bus: EventBus;
  /** Late-bound: services are created after integrations (they read t3Status). */
  services: () => Services;
}

/** Test seams: replace process spawning and network access. */
export interface IntegrationOverrides {
  runGh?: RunGh;
  fetch?: FetchFn;
  /** GitHub's GraphQL API; separate from `fetch`, which reaches T3 Code. */
  githubFetch?: FetchFn;
  /** Fetches LiteLLM's price list. The real `fetch` is passed here and nowhere else; tests pass a fake. */
  modelPricesFetch?: FetchFn;
  openSocket?: OpenSocket;
  runHeadless?: RunHeadless;
  runImport?: RunImport;
  listMcpServers?: (cli: string | null, cwd: string) => Promise<string[]>;
  /** Git for reading project folders: session launch, and the stats' commits (read by the services, see createContext). */
  runGit?: RunGit;
  /** What provider detection runs: the CLIs and the MCP config files. */
  providerProbes?: Partial<ProviderProbes>;
  agentModelProbes?: Partial<AgentModelProbes>;
  /** Process checks for agent sessions' status. */
  processProbe?: ProcessProbe;
  /** The machine "Open in terminal" runs on, and how it starts a terminal. */
  terminalHost?: () => TerminalHost;
  spawnTerminal?: SpawnTerminal;
  /** What run tools read instead of the git host. */
  gitHost?: GitHostReads;
  /** Carries out Autopilot's agent actions; replaces the T3 and headless runners entirely. */
  autopilotRunner?: Runner;
  /** Git for Autopilot's worktrees (the runner and their cleanup). */
  autopilotGit?: RunGit;
  /** Runs one headless Autopilot agent (`claude -p`) to the end. */
  runAgent?: RunAgent;
  /** Replaces the Autopilot catalogue (read by the services, see createContext). */
  automations?: readonly Automation[];
  /** Runs custom automations' shell commands (read by the services, see createContext). */
  runShell?: RunShell;
  /** Runs custom automations' scripts (read by the services, see createContext). */
  runScript?: RunScript;
  /** The clock for notifications (retention, quiet hours; read by the services, see createContext). */
  now?: () => Date;
  /** Reaching connected machines: `ssh`, the tunnel's ports, the network and name lookups. */
  machines?: TunnelDeps & { fetch?: typeof fetch; resolve?: (hostname: string) => Promise<string[]> };
  /** A runner's own checks and update: the programs it probes for logins, and what an update downloads and runs. */
  runnerHost?: {
    logins?: Partial<LoginProbes>;
    update?: Partial<SelfUpdateDeps>;
    clone?: CloneRepo;
  };
  /** The connected machine a task not held yet would run on (`taskRunsOn` unless set), for its dependents' hand-over. */
  machineFor?: (taskId: string) => string | null;
  /** The repository a folder's `origin` names, read on the spot (read by the services, see createContext). */
  readRemote?: (workspaceRoot: string) => { remote: string; remoteUrl: string } | null;
  log?: Logger;
}

/** Builds the git hosts (GitHub: GraphQL with a gh token) and T3 Code integrations, the review watchdog, backup and Autopilot. */
export function createIntegrations(deps: IntegrationDeps, overrides: IntegrationOverrides = {}): Integrations {
  const github = createGithubHost({
    ...(overrides.runGh ? { runGh: overrides.runGh } : {}),
    ...(overrides.githubFetch ? { fetch: overrides.githubFetch } : {}),
  });
  const hosts = createGitHosts([github]);
  const poller = createPrPoller({
    services: deps.services,
    hosts,
    polledElsewhere: (taskId) => {
      if (deps.config.role === "runner") return false;
      const hold = deps.services().holds.get(taskId);
      return hold !== null && machines.can(hold.machineId, "autopilot") !== false;
    },
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  const merges = createPrMerges({
    hosts,
    tasks: () => deps.services().tasks,
    refresh: (link, opts) => poller.reread(link, opts),
  });
  const runTools: RunToolsContext = {
    tokens: createRunTokens(),
    gitHost: overrides.gitHost ? () => overrides.gitHost! : (host) => hosts.forHost(host),
    services: deps.services,
  };
  const isRunner = deps.config.role === "runner";
  /** This server as a link made on it names it, on a runner. */
  const thisMachine = () => ({ id: deps.config.instanceId, name: deps.services().settings.get().machineName });
  const ownT3 = createT3Integration({
    t3Home: deps.config.t3Home,
    bus: deps.bus,
    services: deps.services,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.openSocket ? { openSocket: overrides.openSocket } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
    ...(isRunner ? { always: true, machine: thisMachine } : {}),
  });
  // On a board, the threads of a task a machine holds are in that machine's T3 Code: everything here reaches them
  // through it. Built before the machines are (below), and only called after.
  const t3 = isRunner
    ? ownT3
    : withMachineThreads(ownT3, {
        remote: () => remoteWork,
        sync: () => machineSync,
        services: deps.services,
        ...(overrides.log ? { log: overrides.log } : {}),
      });
  const reviews = createReviewFallbacks({
    services: deps.services,
    t3,
    // Unknown until the machine has answered once: then it is taken to, as every machine on this version does.
    reviewsThere: (machineId) => machines.can(machineId, "runs") !== false,
    ...(deps.config.role === "runner"
      ? {
          worktreeOf: (task) => machineWorktreeOf(task, deps.config.instanceId),
        }
      : {}),
    ...(overrides.runHeadless ? { runHeadless: overrides.runHeadless } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  const importer = createIssueImporter({
    services: deps.services,
    issues: gitHostIssues(hosts),
    ...(overrides.runImport ? { runImport: overrides.runImport } : {}),
    ...(overrides.listMcpServers ? { listMcpServers: overrides.listMcpServers } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  const settingsAsker = createSettingsAsker({
    services: deps.services,
    ...(overrides.runAgent ? { runAgent: overrides.runAgent } : {}),
  });
  const backup = createBackupIntegration({
    services: deps.services,
    attachmentsDir: deps.config.attachmentsDir,
    instanceId: deps.config.instanceId,
    ...(overrides.runGit ? { runGit: overrides.runGit } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  const backupSetup = createBackupSetup({
    services: deps.services,
    host: github,
    runGit: overrides.runGit ?? defaultRunGit,
    defaultDir: deps.config.backupDefaultDir,
    instanceId: deps.config.instanceId,
  });
  const sessions = createAgentSessionsIntegration({
    services: deps.services,
    bus: deps.bus,
    dirs: deps.config.sessionDirs,
    userHome: deps.config.userHome,
    machineId: deps.config.instanceId,
    always: deps.config.role === "runner",
    machine: (instanceId) => {
      const record = deps.services().machines.byInstance(instanceId);
      return record ? { id: record.id, name: record.name, routes: record.routes } : null;
    },
    ...(overrides.machines?.spawn ? { spawnSsh: overrides.machines.spawn } : {}),
    ...(overrides.processProbe ? { probe: overrides.processProbe } : {}),
    ...(overrides.terminalHost ? { host: overrides.terminalHost } : {}),
    ...(overrides.spawnTerminal ? { spawn: overrides.spawnTerminal } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  // Built once the machines are (below); only called after that.
  let remoteWork!: ReturnType<typeof createRemoteWork>;
  const transcripts = createSessionTranscriptReader({
    services: deps.services,
    claudeDir: deps.config.sessionDirs.claudeDir,
    // A session that ran on a connected machine is read there; a runner's own are read here.
    onMachine: (ref, offset) =>
      isRunner || ref.machine?.id === deps.config.instanceId ? null : remoteWork.transcript(ref, offset),
  });
  const sessionLaunch = createSessionLaunch({
    services: deps.services,
    host: overrides.terminalHost ?? systemTerminalHost,
    spawn: overrides.spawnTerminal ?? spawnTerminal,
    runGit: overrides.autopilotGit ?? defaultRunGit,
    worktreesDir: deps.config.worktreesDir,
    // A runner holds no task for another machine; a board opens the sessions of the tasks its machines hold there.
    ...(isRunner ? {} : { remote: () => remoteWork }),
    ...(overrides.machines?.spawn ? { spawnSsh: overrides.machines.spawn } : {}),
    linked: (linkId) => {
      sessions.refresh(deps.services().links.get(linkId)).catch((error: unknown) => {
        (overrides.log ?? console).warn(`[sessions] couldn't refresh ${linkId}: ${messageOf(error)}`);
      });
    },
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  const customHandoffs = createCustomHandoffLauncher({
    services: deps.services,
    boardUrl: () => boardUrlOf(deps.config),
    // Through the object, so tests can stand in for T3 Code here.
    launchThread: (taskId, input, actor) => integrations.launchT3TaskThread(taskId, input, actor),
    taskBranches: (taskId) => sessionLaunch.taskBranches(taskId),
    sessionOptions: (taskId) => sessionLaunch.options(taskId),
    startSession: (taskId, input, actor) => sessionLaunch.start(taskId, input, actor),
  });
  const agentModels = createAgentModels({
    services: deps.services,
    host: overrides.terminalHost ?? systemTerminalHost,
    ...(overrides.agentModelProbes ? { probes: overrides.agentModelProbes } : {}),
  });
  const providers = createProviders({
    services: deps.services,
    mcpUrl: () => `http://127.0.0.1:${deps.config.port}/mcp`,
    host: overrides.terminalHost ?? systemTerminalHost,
    userHome: deps.config.userHome,
    t3Status: () => t3.status(),
    t3Refresh: () => t3.test(),
    models: (harness, refresh) => agentModels.harness(harness, refresh),
    ...(overrides.providerProbes ? { probes: overrides.providerProbes } : {}),
  });
  // An Autopilot session's state comes from its run, which changes without the harness's files changing.
  const refreshSession = (sessionId: string) => {
    sessions.refreshSession(sessionId).catch((error: unknown) => {
      (overrides.log ?? console).warn(`[sessions] couldn't refresh ${sessionId}: ${messageOf(error)}`);
    });
  };
  // An Autopilot run ended: its headless session shows it at once.
  const runEnded = (run: AutopilotRun) => {
    if (run.sessionId) refreshSession(run.sessionId);
  };
  // One `git fetch` per repository at a time, across the runner's worktrees and the engine's own reads.
  const repoGate = createRepoGate();
  const localRunner =
    overrides.autopilotRunner ??
    createAutopilotRunner({
      services: deps.services,
      t3,
      worktreesDir: deps.config.worktreesDir,
      gate: repoGate,
      ...(overrides.autopilotGit ? { runGit: overrides.autopilotGit } : {}),
      ...(overrides.runAgent ? { runAgent: overrides.runAgent } : {}),
      sessionLinked: refreshSession,
      boardMcp: () => ({ url: `http://127.0.0.1:${deps.config.port}/mcp`, token: deps.config.token ?? null }),
      ...(isRunner ? { machine: thisMachine } : {}),
      runTools: {
        mint: (runId, scope, ttlMs) => {
          const { token, revoke } = runTools.tokens.mint(runId, scope, ttlMs);
          return { url: `http://127.0.0.1:${deps.config.port}${RUN_TOOLS_PATH}`, token, revoke };
        },
      },
      ...(overrides.log ? { log: overrides.log } : {}),
    });
  /**
   * On a runner, a task in an epic delivered through an integration branch starts from that branch, made on origin
   * with this machine's own login when it isn't there yet: the board made it when the epic was set up, but it may
   * since have been deleted, and the board may be off.
   */
  const ensureEpicBranchHere = async (taskId: string | null): Promise<void> => {
    if (!taskId) return;
    const s = deps.services();
    const task = s.tasks.summary(taskId);
    const root = s.projects.get(task.projectId).workspaceRoot;
    if (task.kind === "epic" || !task.integrationBranch || !root) return;
    await ensureEpicBranch(overrides.autopilotGit ?? defaultRunGit, root, task.integrationBranch);
  };
  // A board sends the agent work of a task a machine holds to that machine, handing a task set to run on a machine to
  // it as it starts (remote-machines.md#choosing-the-machine); a runner does its work as a runner does (headless, from
  // origin), whether its board sent it or its own Autopilot started it.
  const runner: Runner = isRunner
    ? {
        async start(request, update) {
          const sent = asRunnerRequest(request);
          await ensureEpicBranchHere(sent.run.taskId);
          return localRunner.start(sent, update);
        },
      }
    : {
        start: async (request, update) => {
          await handOverAtStart(deps.services(), machineSync, request);
          return remoteWork.runner(localRunner).start(request, update);
        },
      };
  // Each project folder's `origin`, cached: Review PRs reads it on every pass for other people's PRs.
  const repoUrls = createRepoUrls(overrides.autopilotGit ?? defaultRunGit);
  const autopilot = createAutopilotEngine({
    services: deps.services,
    bus: deps.bus,
    runner,
    runGit: gateFetches(overrides.autopilotGit ?? defaultRunGit, repoGate),
    gitHosts: gitHostActions(hosts, merges, {
      mergeAutoMergeTask: (taskId, input, actor) =>
        mergeTaskPr({ services: deps.services(), merges, hosts }, taskId, input, actor),
      rereadPr: async (link) => {
        if (link.kind === "pr" && link.ref) await poller.reread({ ...link, ref: link.ref }, { quiet: true });
      },
    }),
    // Other people's PRs are the board's to review: a runner reads no repository of its own for them.
    repoOf: async (project) => {
      if (isRunner) return null;
      const url = await repoUrls(project.workspaceRoot);
      return url ? remoteRepo(url) : null;
    },
    runEnded,
    boardUrl: () => boardUrlOf(deps.config),
    // Each candidate is one server's: a runner's Autopilot acts on the tasks it holds (remote-machines.md).
    placement: isRunner
      ? runnerPlacement(deps.services, deps.config.instanceId)
      : boardPlacement(deps.services, (machineId) => machines.can(machineId, "autopilot")),
    reminders: !isRunner,
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  const digests = createDigestGenerator({
    services: deps.services,
    runner,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  const worktrees = createWorktreeCleanup({
    services: deps.services,
    ...(overrides.autopilotGit ? { runGit: overrides.autopilotGit } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  const modelPrices = createModelPriceService({
    cachePath: deps.config.modelPricesPath,
    fetch: overrides.modelPricesFetch ?? ((input, init) => fetch(input, init)),
    enabled: () => deps.services().settings.get().modelPriceFetch,
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  const machineSecrets = deps.config.machineSecretsPath
    ? createMachineSecrets(deps.config.machineSecretsPath)
    : createMemoryMachineSecrets();
  const machines = createMachinesIntegration({
    services: deps.services,
    bus: deps.bus,
    secrets: machineSecrets,
    client: createMachineClient({
      secrets: machineSecrets,
      board: () => ({ instanceId: deps.config.instanceId, name: deps.services().settings.get().machineName }),
      ...(overrides.machines?.fetch ? { fetch: overrides.machines.fetch } : {}),
      ...(overrides.machines?.resolve ? { resolve: overrides.machines.resolve } : {}),
    }),
    open: createRouteOpener(overrides.machines),
    ...(overrides.machines?.spawn ? { spawnSsh: overrides.machines.spawn } : {}),
    releaseUrl: deps.config.releaseUrl ?? null,
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  remoteWork = createRemoteWork({
    services: deps.services,
    machines,
    runGit: overrides.runGit ?? defaultRunGit,
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  // What a runner answers its board with. Built in either role (it costs nothing until asked), used by a runner's.
  let restartRunner: (() => void) | null = null;
  const machineSync = createMachineSync({
    services: deps.services,
    machines,
    work: remoteWork,
    autopilot: {
      sync: (machineId) => autopilotSync.sync(machineId),
      observe: (machineId, held) => autopilotSync.observe(machineId, held),
    },
    // Where a task not held yet would run (its own choice, then its project's): dependents set to the same machine
    // go with a flagged task, so the machine can start them while the board is off.
    machineFor: overrides.machineFor ?? ((taskId) => taskRunsOn(deps.services(), taskId).machineId),
    bus: deps.bus,
    runGit: overrides.runGit ?? defaultRunGit,
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  // Runs a restart left going on a machine: here, where both the job reads and the machine's log are in reach.
  const reattacher = createReattacher({
    services: deps.services,
    work: remoteWork,
    pump: (machineId) => machineSync.pump(machineId),
    runEnded,
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  const autopilotSync = createAutopilotSync({
    services: deps.services,
    machines,
    bus: deps.bus,
    runGit: overrides.runGit ?? defaultRunGit,
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  const jobs = createMachineJobs();
  const workInFlight = () => deps.services().autopilot.status().active.length + jobs.inFlight((kind) => kind !== "run");
  const runnerHost: RunnerHost = {
    jobs,
    workInFlight,
    work: createRunnerWork({
      services: deps.services,
      jobs,
      runner: localRunner,
      // The session's state follows its run, which ended without the harness's files changing.
      runEnded: refreshSession,
      runShell: overrides.runShell ?? runShellCommand,
      runScript: overrides.runScript ?? runScript,
      ...(overrides.log ? { log: overrides.log } : {}),
    }),
    bridge: createBridgeChannel(overrides.now ? { now: overrides.now } : {}),
    checkouts: createCheckouts({
      dir: deps.config.reposDir,
      machineName: () => deps.services().settings.get().machineName,
      ...(overrides.runnerHost?.clone ? { clone: overrides.runnerHost.clone } : {}),
    }),
    logins: createLoginDetector(overrides.runnerHost?.logins),
    updater: createSelfUpdater({
      runsInFlight: workInFlight,
      ...(deps.config.hostedBy ? { withApp: true } : {}),
      restart: () => restartRunner?.(),
      ...(overrides.log ? { log: overrides.log } : {}),
      ...overrides.runnerHost?.update,
    }),
    onRestart: (restart) => {
      restartRunner = restart;
    },
    interactive: createRunnerInteractive({
      services: deps.services,
      t3: ownT3,
      runGit: overrides.autopilotGit ?? defaultRunGit,
      worktreesDir: deps.config.worktreesDir,
      machine: thisMachine,
      ...(deps.config.hostedBy ? { hosted: true } : {}),
      ...(overrides.now ? { now: () => overrides.now!().getTime() } : {}),
    }),
  };
  let started = false;
  const usageSweep = createUsageSweep(() => deps.services().usage, overrides.log ?? console);

  const integrations: Integrations = {
    t3Status: () => t3.status(),
    gitHostStatuses: () => hosts.statuses(),
    prHostHoldsTasks: (host) => hosts.holdsTasks(host),
    prAgentHints: (pr) => hosts.agentHints(pr),
    runTools,
    modelPrices,
    machines,
    machineSync,
    autopilotSync,
    runnerHost,
    remoteWork,
    reattach: async (runs) => {
      await Promise.all(runs.map(({ run, machineId }) => reattacher.reattach(run, machineId)));
    },
    readSessionTranscript: (ref, offset) => transcripts.readSession(ref, offset),
    start() {
      if (!deps.config.pollers || started) return;
      started = true;
      hosts.start();
      poller.start();
      t3.start();
      reviews.start();
      backup.start();
      sessions.start();
      autopilot.start();
      worktrees.start();
      usageSweep.start();
      modelPrices.start();
      // A runner connects to no machines: it is one.
      if (deps.config.role !== "runner") {
        machines.start();
        machineSync.start();
        autopilotSync.start();
      }
      providers.seedFromDetection().catch((error: unknown) => {
        (overrides.log ?? console).warn(`[providers] couldn't add the providers detection found: ${messageOf(error)}`);
      });
    },
    stop() {
      started = false;
      hosts.stop();
      poller.stop();
      t3.stop();
      reviews.stop();
      backup.stop();
      sessions.stop();
      autopilot.stop();
      worktrees.stop();
      usageSweep.stop();
      modelPrices.stop();
      machines.stop();
      machineSync.stop();
      autopilotSync.stop();
      runnerHost.updater.stop();
    },
    t3ThreadUsage: (threadId) => t3.threadUsage(threadId),
    sessionTranscript: (taskId, input) => transcripts.read(taskId, input),
    askSettings: (input) => settingsAsker.ask(input),
    startImport: (taskId) => importer.start(taskId),
    resumeImports: () => importer.resume(),
    listT3Projects: () => t3.listProjects(),
    importT3Projects: (ids) => t3.importProjects(ids),
    async refreshLink(linkId) {
      const link = deps.services().links.get(linkId);
      // A session or thread linked just now has its tokens read at once, not at the next sweep.
      try {
        if (link.kind === "agent_session") deps.services().usage.scanSession(link.ref);
        // A thread in a machine's T3 Code has its tokens read there, and they arrive with the task's changes.
        if (link.kind === "t3_thread" && !link.ref.machine)
          void deps
            .services()
            .usage.scanThread(link.ref.threadId)
            .catch(() => false);
      } catch (error) {
        (overrides.log ?? console).warn(`[usage] ${linkId}: ${messageOf(error)}`);
      }
      if (await poller.refresh(link)) return;
      if (await sessions.refresh(link)) return;
      await t3.refresh(link);
    },
    prLinked(linkId) {
      void poller.pollLink(linkId);
    },
    taskViewed: (taskId) => poller.viewTask(taskId),
    async mergePr(linkId, input) {
      await merges.merge(deps.services().links.get(linkId), input);
    },
    mergeTaskPr: (taskId, input, actor) =>
      mergeTaskPr({ services: deps.services(), merges, hosts }, taskId, input, actor),
    async setEpicDelivery(epicId, delivery, actor) {
      const s = deps.services();
      const epic = s.tasks.summary(epicId);
      if (epic.kind !== "epic")
        throw new AppError("VALIDATION", `${taskLabel(epic)} isn't an epic; only epics have a delivery`);
      if (delivery === "main") return s.tasks.setDelivery(epicId, "main", null, actor);
      // Already on it: nothing to make. A branch kept from an earlier switch is used again.
      if (epic.delivery === "integration" && epic.integrationBranch) return s.tasks.detail(epicId);
      const project = s.projects.get(epic.projectId);
      if (!project.workspaceRoot) {
        throw new AppError(
          "VALIDATION",
          `${project.title} has no workspace folder, so there is no repository to make the epic's branch in`,
        );
      }
      const branch = epicBranchName(epic);
      try {
        await ensureEpicBranch(overrides.autopilotGit ?? defaultRunGit, project.workspaceRoot, branch);
      } catch (error) {
        throw new AppError("VALIDATION", `Couldn't make the epic's branch ${branch}: ${messageOf(error)}`);
      }
      return s.tasks.setDelivery(epicId, "integration", branch, actor);
    },
    testT3: () => t3.test(),
    connectT3: (value) => t3.connect(value),
    async t3LaunchOptions(taskId, handoffId) {
      const choice = handoffId ? customHandoffs.get(handoffId).model : undefined;
      // The task's branches come from git, beside T3's options; a git failure only leaves the pinned group out.
      const [options, taskBranches] = await Promise.all([
        t3.launchOptions(taskId, choice),
        sessionLaunch.taskBranches(taskId).catch(() => []),
      ]);
      return { ...options, taskBranches };
    },
    t3ProjectLaunchOptions: (projectId) => t3.projectLaunchOptions(projectId),
    t3ModelCatalog: () => t3.modelCatalog(),
    startT3Thread: (taskId, input, actor) => t3.startThread(taskId, input, actor),
    startT3ProjectThread: (projectId, input, title) => t3.startProjectThread(projectId, input, title),
    async startT3PlanningThread(projectId, { taskIds, ...input }, actor) {
      const s = deps.services();
      // Checked before the launch, so a list with a task that can't be planned starts nothing.
      const tasks = tasksToPlan(s, projectId, taskIds);
      const title = `${planningSessionLabel(tasks)}: ${s.projects.get(projectId).title}`;
      // Through the object, so tests can stand in for T3 Code here.
      const thread = await integrations.startT3ProjectThread(projectId, input, title);
      const links = tasks.map((task) => s.links.add(task.id, { t3Thread: thread }, actor));
      void t3.pollLive();
      return links;
    },
    launchT3TaskThread: (taskId, input, actor) => t3.launchTaskThread(taskId, input, actor),
    messageT3Thread: (link, text) => t3.sendToThread(link, text, randomUUID()),
    async resolveLinkInput(input) {
      // A thread linked on a runner is in this machine's T3 Code: the link says so, for the board it is shown on.
      const here = (ref: T3ThreadRef): T3ThreadRef => (isRunner ? { ...ref, machine: thisMachine() } : ref);
      if (input.t3Thread) return { input: { ...input, t3Thread: here(input.t3Thread) } };
      // An explicit kind other than t3_thread means the caller chose how to read the value.
      if (!input.value || (input.kind && input.kind !== "t3_thread")) return { input };
      const resolved = await t3.resolveThread(input.value);
      if (!resolved) return { input };
      const { value: _value, ...rest } = input;
      return {
        input: { ...rest, t3Thread: here(resolved.ref) },
        ...(resolved.warning ? { warning: resolved.warning } : {}),
      };
    },
    resumeCommand: (linkId, mode) => sessions.resumeCommand(linkId, mode),
    resumeSession: (linkId, input) => sessions.resume(linkId, input),
    terminalInfo: () => sessions.terminalInfo(),
    providers: (refresh, parts) => providers.status(refresh, parts),
    agentModels: (refresh) => agentModels.status(refresh),
    sessionLaunchOptions: (taskId, handoffId) =>
      sessionLaunch.options(taskId, handoffId ? customHandoffs.get(handoffId).model : undefined),
    startCustomHandoff: (taskId, handoffId, input, actor) => customHandoffs.start(taskId, handoffId, input, actor),
    startSession: (taskId, input, actor) => sessionLaunch.start(taskId, input, actor),
    startPlanningSession: (projectId, input, actor) => sessionLaunch.startPlanning(projectId, input, actor),
    autopilotPass() {
      if (started) void autopilot.pass();
    },
    generateDigest: () => digests.generate(),
    digestsIdle: () => digests.idle(),
    backupStatus: () => backup.status(),
    runBackup: () => backup.run(),
    backupMachines: () => backup.machines(),
    backupHistory: (machine) => backup.history(machine),
    backupDiff: (source) => backup.diff(source),
    restoreBackupTasks: (input, actor) => backup.restoreTasks(input, actor),
    restoreBackupBoard: (input) => backup.restoreBoard(input),
    backupMachineTasks: (machine) => backup.machineTasks(machine),
    importBackupTasks: (input, actor) => backup.importTasks(input, actor),
    backupSetupInfo: () => backupSetup.info(),
    createBackupRepo: (name) => backupSetup.createRepo(name),
    checkBackupRemote: (remote) => backupSetup.checkRemote(remote),
  };
  return integrations;
}
