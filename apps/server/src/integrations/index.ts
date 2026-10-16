import { randomUUID } from "node:crypto";
import { createWorktreeCleanup } from "../autopilot/cleanup.ts";
import { createAutopilotEngine } from "../autopilot/engine.ts";
import { createAutopilotRunner } from "../autopilot/runner.ts";
import type { Automation, Runner } from "../autopilot/types.ts";
import type { EventBus } from "../bus.ts";
import { boardUrlOf, type Config } from "../config.ts";
import type { Services } from "../services/types.ts";
import { createAgentSessionsIntegration, type ProcessProbe } from "./agentSessions.ts";
import { createBackupIntegration, type RunGit } from "./backup.ts";
import type { RunGh } from "./gh.ts";
import { createGithubIntegration } from "./github.ts";
import type { RunAgent } from "./headlessAgent.ts";
import type { RunImport } from "./headlessImport.ts";
import type { RunHeadless } from "./headlessReview.ts";
import { createIssueImporter } from "./issueImport.ts";
import { createReviewFallbacks } from "./reviewFallbacks.ts";
import { createT3Integration, type FetchFn } from "./t3.ts";
import type { OpenSocket } from "./t3Rpc.ts";
import type { SpawnTerminal, TerminalHost } from "./terminal.ts";
import type { Integrations } from "./types.ts";
import type { Logger } from "./util.ts";

export interface IntegrationDeps {
  config: Pick<Config, "t3Home" | "pollers" | "sessionDirs" | "userHome" | "worktreesDir" | "port" | "webPort"> &
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
  const backup = createBackupIntegration({
    services: deps.services,
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
  const runner =
    overrides.autopilotRunner ??
    createAutopilotRunner({
      services: deps.services,
      t3,
      worktreesDir: deps.config.worktreesDir,
      ...(overrides.autopilotGit ? { runGit: overrides.autopilotGit } : {}),
      ...(overrides.runAgent ? { runAgent: overrides.runAgent } : {}),
      ...(overrides.log ? { log: overrides.log } : {}),
    });
  const autopilot = createAutopilotEngine({
    services: deps.services,
    bus: deps.bus,
    runner,
    boardUrl: () => boardUrlOf(deps.config),
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  const worktrees = createWorktreeCleanup({
    services: deps.services,
    ...(overrides.autopilotGit ? { runGit: overrides.autopilotGit } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  let started = false;

  return {
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
    testT3: () => t3.test(),
    connectT3: (value) => t3.connect(value),
    t3LaunchOptions: (taskId) => t3.launchOptions(taskId),
    t3ProjectLaunchOptions: (projectId) => t3.projectLaunchOptions(projectId),
    t3ModelCatalog: () => t3.modelCatalog(),
    startT3Thread: (taskId, input, actor) => t3.startThread(taskId, input, actor),
    startT3ProjectThread: (projectId, input, title) => t3.startProjectThread(projectId, input, title),
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
    backupStatus: () => backup.status(),
    runBackup: () => backup.run(),
  };
}
