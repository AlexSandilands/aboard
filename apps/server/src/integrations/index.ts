import { randomUUID } from "node:crypto";
import { epicBranchName, planningSessionLabel } from "@repo/contracts";
import { createWorktreeCleanup } from "../autopilot/cleanup.ts";
import { ensureEpicBranch } from "../autopilot/epicBranch.ts";
import { createDigestGenerator } from "../autopilot/digest.ts";
import { createAutopilotEngine } from "../autopilot/engine.ts";
import { createAutopilotRunner } from "../autopilot/runner.ts";
import type { Automation, Runner } from "../autopilot/types.ts";
import type { RunShell } from "./shellCommand.ts";
import type { EventBus } from "../bus.ts";
import { boardUrlOf, type Config } from "../config.ts";
import { tasksToPlan } from "../services/planning.ts";
import type { Services } from "../services/types.ts";
import { createAgentSessionsIntegration, type ProcessProbe } from "./agentSessions.ts";
import { createBackupIntegration, defaultRunGit, type RunGit } from "./backup.ts";
import type { RunGh } from "./gh.ts";
import { createGithubIntegration, messageOf } from "./github.ts";
import type { RunAgent } from "./headlessAgent.ts";
import type { RunImport } from "./headlessImport.ts";
import type { RunHeadless } from "./headlessReview.ts";
import { createIssueImporter } from "./issueImport.ts";
import { createReviewFallbacks } from "./reviewFallbacks.ts";
import { createSessionLaunch } from "./sessionLaunch.ts";
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
    Partial<Pick<Config, "webDist">>;
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
  runGit?: RunGit;
  /** Process checks for agent sessions' status. */
  processProbe?: ProcessProbe;
  /** The machine "Open in terminal" runs on, and how it starts a terminal. */
  terminalHost?: () => TerminalHost;
  spawnTerminal?: SpawnTerminal;
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
  /** The clock for notifications (retention, quiet hours; read by the services, see createContext). */
  now?: () => Date;
  log?: Logger;
}

/** Builds the GitHub (GraphQL with a gh token) and T3 Code integrations, the review watchdog, backup and Autopilot. */
export function createIntegrations(deps: IntegrationDeps, overrides: IntegrationOverrides = {}): Integrations {
  const github = createGithubIntegration({
    services: deps.services,
    ...(overrides.runGh ? { runGh: overrides.runGh } : {}),
    ...(overrides.githubFetch ? { fetch: overrides.githubFetch } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
  });
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
    github,
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
    ...(overrides.runGit ? { runGit: overrides.runGit } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
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
  // An Autopilot session's state comes from its run, which changes without the harness's files changing.
  const refreshSession = (sessionId: string) => {
    sessions.refreshSession(sessionId).catch((error: unknown) => {
      (overrides.log ?? console).warn(`[sessions] couldn't refresh ${sessionId}: ${messageOf(error)}`);
    });
  };
  const runner =
    overrides.autopilotRunner ??
    createAutopilotRunner({
      services: deps.services,
      t3,
      worktreesDir: deps.config.worktreesDir,
      ...(overrides.autopilotGit ? { runGit: overrides.autopilotGit } : {}),
      ...(overrides.runAgent ? { runAgent: overrides.runAgent } : {}),
      sessionLinked: refreshSession,
      ...(overrides.log ? { log: overrides.log } : {}),
    });
  const autopilot = createAutopilotEngine({
    services: deps.services,
    bus: deps.bus,
    runner,
    github,
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
    githubStatus: () => github.status(),
    prHostHoldsTasks: (host) => github.holdsTasks(host),
    start() {
      if (!deps.config.pollers || started) return;
      started = true;
      github.start();
      t3.start();
      reviews.start();
      backup.start();
      sessions.start();
      autopilot.start();
      worktrees.start();
    },
    stop() {
      started = false;
      github.stop();
      t3.stop();
      reviews.stop();
      backup.stop();
      sessions.stop();
      autopilot.stop();
      worktrees.stop();
    },
    settingsAskStatus: () => settingsAsker.status(),
    askSettings: (input) => settingsAsker.ask(input),
    startImport: (taskId) => importer.start(taskId),
    resumeImports: () => importer.resume(),
    listT3Projects: () => t3.listProjects(),
    importT3Projects: (ids) => t3.importProjects(ids),
    async refreshLink(linkId) {
      const link = deps.services().links.get(linkId);
      if (await github.refresh(link)) return;
      if (await sessions.refresh(link)) return;
      await t3.refresh(link);
    },
    async mergePr(linkId, input) {
      await github.merge(deps.services().links.get(linkId), input);
    },
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
    t3LaunchOptions: (taskId) => t3.launchOptions(taskId),
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
    agentClis: () => sessionLaunch.clis(),
    sessionLaunchOptions: (taskId) => sessionLaunch.options(taskId),
    startSession: (taskId, input, actor) => sessionLaunch.start(taskId, input, actor),
    startPlanningSession: (projectId, input, actor) => sessionLaunch.startPlanning(projectId, input, actor),
    generateDigest: () => digests.generate(),
    digestsIdle: () => digests.idle(),
    backupStatus: () => backup.status(),
    runBackup: () => backup.run(),
  };
  return integrations;
}
