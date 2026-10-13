import type { GithubStatus, Project, T3IntegrationStatus, T3ProjectCandidate } from "@repo/contracts";

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
  /** Re-runs T3 discovery + a live-status request and returns the resulting status. */
  testT3(): Promise<T3IntegrationStatus>;
}

export const DISABLED_T3_STATUS: T3IntegrationStatus = {
  detected: false,
  origin: null,
  environmentId: null,
  label: null,
  liveStatus: "off",
  error: null,
};
