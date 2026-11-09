import { randomUUID } from "node:crypto";
import { epicBranchName, planningSessionLabel } from "@repo/contracts";
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
import { createProviders, type ProviderProbes } from "./providers.ts";
import { createReviewFallbacks } from "./reviewFallbacks.ts";
import { createSessionLaunch } from "./sessionLaunch.ts";
import { createSessionTranscriptReader } from "./sessionTranscript.ts";
import { createSettingsAsker } from "./settingsAsk.ts";
import { createT3Integration, type FetchFn } from "./t3.ts";
import type { OpenSocket } from "./t3Rpc.ts";
import { spawnTerminal, systemTerminalHost, type SpawnTerminal, type TerminalHost } from "./terminal.ts";
import type { Integrations } from "./types.ts";
import type { Logger } from "./util.ts";
import { AppError } from "../errors.ts";

export interface IntegrationDeps {
  config: Pick<
    Config,
    "t3Home" | "pollers" | "sessionDirs" | "userHome" | "worktreesDir" | "attachmentsDir" | "port" | "webPort"
  > &
    Partial<Pick<Config, "token">> &
    Partial<Pick<Config, "webDist">> & {
      /** This board's id (instance.ts), which owns its folder in the backup repo. */
      instanceId: string;
      /** Where the backup setup offers to keep the backup clone: `<data dir>/backup`. */
      backupDefaultDir: string;
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
  };
  const t3 = createT3Integration({
    t3Home: deps.config.t3Home,
    bus: deps.bus,
    services: deps.services,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.openSocket ? { openSocket: overrides.openSocket } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  const reviews = createReviewFallbacks({
    services: deps.services,
    t3,
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
    ...(overrides.processProbe ? { probe: overrides.processProbe } : {}),
    ...(overrides.terminalHost ? { host: overrides.terminalHost } : {}),
    ...(overrides.spawnTerminal ? { spawn: overrides.spawnTerminal } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  const transcripts = createSessionTranscriptReader({
    services: deps.services,
    claudeDir: deps.config.sessionDirs.claudeDir,
  });
  const sessionLaunch = createSessionLaunch({
    services: deps.services,
    host: overrides.terminalHost ?? systemTerminalHost,
    spawn: overrides.spawnTerminal ?? spawnTerminal,
    runGit: overrides.autopilotGit ?? defaultRunGit,
    worktreesDir: deps.config.worktreesDir,
    linked: (linkId) => {
      sessions.refresh(deps.services().links.get(linkId)).catch((error: unknown) => {
        (overrides.log ?? console).warn(`[sessions] couldn't refresh ${linkId}: ${messageOf(error)}`);
      });
    },
    ...(overrides.log ? { log: overrides.log } : {}),
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
  // One `git fetch` per repository at a time, across the runner's worktrees and the engine's own reads.
  const repoGate = createRepoGate();
  const runner =
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
      runTools: {
        mint: (runId, scope, ttlMs) => {
          const { token, revoke } = runTools.tokens.mint(runId, scope, ttlMs);
          return { url: `http://127.0.0.1:${deps.config.port}${RUN_TOOLS_PATH}`, token, revoke };
        },
      },
      ...(overrides.log ? { log: overrides.log } : {}),
    });
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
    repoOf: async (project) => {
      const url = await repoUrls(project.workspaceRoot);
      return url ? remoteRepo(url) : null;
    },
    runEnded: (run) => {
      if (run.sessionId) refreshSession(run.sessionId);
    },
    boardUrl: () => boardUrlOf(deps.config),
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
  let started = false;

  const integrations: Integrations = {
    t3Status: () => t3.status(),
    gitHostStatuses: () => hosts.statuses(),
    prHostHoldsTasks: (host) => hosts.holdsTasks(host),
    prAgentHints: (pr) => hosts.agentHints(pr),
    runTools,
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
    },
    sessionTranscript: (taskId, input) => transcripts.read(taskId, input),
    askSettings: (input) => settingsAsker.ask(input),
    startImport: (taskId) => importer.start(taskId),
    resumeImports: () => importer.resume(),
    listT3Projects: () => t3.listProjects(),
    importT3Projects: (ids) => t3.importProjects(ids),
    async refreshLink(linkId) {
      const link = deps.services().links.get(linkId);
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
        throw new AppError("VALIDATION", `#${epic.number} isn't an epic; only epics have a delivery`);
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
    async t3LaunchOptions(taskId) {
      // The task's branches come from git, beside T3's options; a git failure only leaves the pinned group out.
      const [options, taskBranches] = await Promise.all([
        t3.launchOptions(taskId),
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
      // An explicit kind other than t3_thread means the caller chose how to read the value.
      if (input.t3Thread || !input.value || (input.kind && input.kind !== "t3_thread")) return { input };
      const resolved = await t3.resolveThread(input.value);
      if (!resolved) return { input };
      const { value: _value, ...rest } = input;
      return { input: { ...rest, t3Thread: resolved.ref }, ...(resolved.warning ? { warning: resolved.warning } : {}) };
    },
    resumeCommand: (linkId, mode) => sessions.resumeCommand(linkId, mode),
    resumeSession: (linkId, input) => sessions.resume(linkId, input),
    terminalInfo: () => sessions.terminalInfo(),
    providers: (refresh, parts) => providers.status(refresh, parts),
    agentModels: (refresh) => agentModels.status(refresh),
    sessionLaunchOptions: (taskId) => sessionLaunch.options(taskId),
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
