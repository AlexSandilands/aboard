import type {
  GithubStatus,
  Project,
  StartT3ThreadInput,
  T3IntegrationStatus,
  T3LaunchOptions,
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
  /** Starts a T3 Code thread for a task and links it to the task. */
  startT3Thread(taskId: string, input: StartT3ThreadInput, actor: string): Promise<TaskLink>;
  /** Re-runs T3 discovery + a live-status request and returns the resulting status. */
  testT3(): Promise<T3IntegrationStatus>;
}
