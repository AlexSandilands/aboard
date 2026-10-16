import type {
  ConnectT3Result,
  GithubStatus,
  LinkInput,
  Project,
  StartT3ThreadInput,
  T3IntegrationStatus,
  T3LaunchOptions,
  T3ModelCatalog,
  T3ProjectCandidate,
  TaskLink,
} from "@repo/contracts";

/** Optional external integrations (GitHub via gh, T3 Code). Every method degrades gracefully. */
export interface Integrations {
  t3Status(): T3IntegrationStatus;
  githubStatus(): GithubStatus;
  /** Starts background discovery/pollers. */
  start(): void;
  stop(): void;
  /** T3 projects available to import (read-only source: shell API or a temp copy of statev2.sqlite). */
  listT3Projects(): Promise<T3ProjectCandidate[]>;
  importT3Projects(t3ProjectIds: string[]): Promise<Project[]>;
  /** Re-fetches one link's snapshot now (PR via gh, T3 thread via shell API). */
  refreshLink(linkId: string): Promise<void>;
  /** Models, refs and defaults for starting a T3 Code thread for a task. */
  t3LaunchOptions(taskId: string): Promise<T3LaunchOptions>;
  /** T3 Code's providers and models, for choosing each model tier's T3 model in settings. */
  t3ModelCatalog(): Promise<T3ModelCatalog>;
  /**
   * Prepares link input for `links.add`: a bare T3 thread id (or browser URL of this T3) becomes a `t3Thread` ref in
   * the detected environment, after checking the thread exists. Anything else is returned as is.
   */
  resolveLinkInput(input: LinkInput): Promise<{ input: LinkInput; warning?: string }>;
  /** Starts a T3 Code thread for a task and links it to the task. */
  startT3Thread(taskId: string, input: StartT3ThreadInput, actor: string): Promise<TaskLink>;
  /** Re-runs T3 discovery + a live-status request and returns the resulting status. */
  testT3(): Promise<T3IntegrationStatus>;
  /** Saves a T3 token, or exchanges a pairing link/code for one, and checks it. */
  connectT3(value: string): Promise<ConnectT3Result>;
}
