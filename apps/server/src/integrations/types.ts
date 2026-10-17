import type {
  AgentCliStatus,
  AskSettingsInput,
  AskSettingsResult,
  BackupStatus,
  EpicDelivery,
  ConnectT3Result,
  GithubStatus,
  LinkInput,
  MergePrInput,
  Project,
  ResumeCommand,
  ResumeMode,
  ResumeResult,
  ResumeSessionInput,
  SessionLaunchOptions,
  StartSessionInput,
  StartSessionResult,
  SettingsAskStatus,
  StartT3ThreadInput,
  T3IntegrationStatus,
  T3LaunchOptions,
  T3ModelCatalog,
  T3ProjectCandidate,
  T3ThreadRef,
  TaskDetail,
  TaskLink,
  TerminalInfo,
} from "@repo/contracts";
import type { DigestStart } from "../autopilot/digest.ts";
import type { TaskThreadInput, TaskThreadLaunch, ThreadLink } from "./t3.ts";

/** Optional external integrations (GitHub via gh, T3 Code). Every method degrades gracefully. */
export interface Integrations {
  t3Status(): T3IntegrationStatus;
  githubStatus(): GithubStatus;
  /** Whether an unfinished PR on the host keeps a Review task from Done (see GithubIntegration.holdsTasks). */
  prHostHoldsTasks(host: string): boolean;
  /** Starts background discovery/pollers. */
  start(): void;
  stop(): void;
  /** Fills in a task created from an issue URL in the background (see TasksService.create). No-op unless its import is pending. */
  startImport(taskId: string): void;
  /** Queues the imports a restart left pending. Runs whether or not the pollers do. */
  resumeImports(): void;
  /** T3 projects available to import (read-only source: shell API or a temp copy of statev2.sqlite). */
  listT3Projects(): Promise<T3ProjectCandidate[]>;
  importT3Projects(t3ProjectIds: string[]): Promise<Project[]>;
  /** Re-fetches one link's snapshot now (PR via GitHub's API, T3 thread via shell API). */
  refreshLink(linkId: string): Promise<void>;
  /** Merges a Review task's GitHub PR, or turns auto-merge on or off, then refreshes its snapshot. */
  mergePr(linkId: string, input: MergePrInput): Promise<void>;
  /**
   * Sets an epic's delivery. Switching to integration first makes sure its branch (`epic/<n>-<slug>`) is on origin,
   * creating it from origin's default branch and pushing it; a git failure refuses the switch.
   */
  setEpicDelivery(epicId: string, delivery: EpicDelivery, actor: string): Promise<TaskDetail>;
  /** Models, refs and defaults for starting a T3 Code thread for a task. */
  t3LaunchOptions(taskId: string): Promise<T3LaunchOptions>;
  /** The same for a thread about a whole project, such as Suggest epics. */
  t3ProjectLaunchOptions(projectId: string): Promise<T3LaunchOptions>;
  /** T3 Code's providers and models, for choosing each model tier's T3 model in settings. */
  t3ModelCatalog(): Promise<T3ModelCatalog>;
  /**
   * Prepares link input for `links.add`: a bare T3 thread id (or browser URL of this T3) becomes a `t3Thread` ref in
   * the detected environment, after checking the thread exists. Anything else is returned as is.
   */
  resolveLinkInput(input: LinkInput): Promise<{ input: LinkInput; warning?: string }>;
  /** Starts a T3 Code thread for a task and links it to the task. */
  startT3Thread(taskId: string, input: StartT3ThreadInput, actor: string): Promise<TaskLink>;
  /** Starts a T3 Code thread about a whole project; nothing is linked, so it returns the thread. */
  startT3ProjectThread(projectId: string, input: StartT3ThreadInput, title: string): Promise<T3ThreadRef>;
  /** Starts a T3 Code thread for a task without the dialog (see autoLaunchSettings) and links it. */
  launchT3TaskThread(taskId: string, input: TaskThreadInput, actor: string): Promise<TaskThreadLaunch>;
  /** Posts a message into a task's linked T3 Code thread, as if the user had typed it. */
  messageT3Thread(link: ThreadLink, text: string): Promise<void>;
  /** Re-runs T3 discovery + a live-status request and returns the resulting status. */
  testT3(): Promise<T3IntegrationStatus>;
  /** Saves a T3 token, or exchanges a pairing link/code for one, and checks it. */
  connectT3(value: string): Promise<ConnectT3Result>;
  /** What to paste to resume an agent session by hand. */
  resumeCommand(linkId: string, mode: ResumeMode): ResumeCommand;
  /** Opens an agent session in a new terminal (see AgentSessionsIntegration.resume). */
  resumeSession(linkId: string, input: ResumeSessionInput): Promise<ResumeResult>;
  /** What "Open in terminal" runs on this machine, for settings. */
  terminalInfo(): TerminalInfo;
  /** Whether the board can start Claude Code and Copilot CLI here, for the hand-off menu. */
  agentClis(): AgentCliStatus[];
  /** What the new-session dialog offers for a task (see SessionLaunchIntegration). */
  sessionLaunchOptions(taskId: string): Promise<SessionLaunchOptions>;
  /** Starts a new Claude Code or Copilot CLI session on a task in a terminal and links it. */
  startSession(taskId: string, input: StartSessionInput, actor: string): Promise<StartSessionResult>;
  /** Whether the settings "Ask" can run: the Claude Code CLI is found. */
  settingsAskStatus(): SettingsAskStatus;
  /** Answers a settings question with Claude Code headless on a small model, naming the setting to jump to. */
  askSettings(input: AskSettingsInput): Promise<AskSettingsResult>;
  /** Makes a digest of what changed now; a summarised one is written in the background (see DigestGenerator). */
  generateDigest(): Promise<DigestStart>;
  /** Resolves when no digest is being written. */
  digestsIdle(): Promise<void>;
  /** The last scheduled or manual git backup. */
  backupStatus(): BackupStatus;
  /** Backs the board up to its git repo now; failures land in the returned status. */
  runBackup(): Promise<BackupStatus>;
}
