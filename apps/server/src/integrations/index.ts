import type { EventBus } from "../bus.ts";
import type { Config } from "../config.ts";
import type { Services } from "../services/types.ts";
import { createGithubIntegration, type RunGh } from "./github.ts";
import { createT3Integration, type FetchFn } from "./t3.ts";
import type { OpenSocket } from "./t3Rpc.ts";
import type { Integrations } from "./types.ts";
import type { Logger } from "./util.ts";

export interface IntegrationDeps {
  config: Pick<Config, "t3Home" | "pollers">;
  bus: EventBus;
  /** Late-bound: services are created after integrations (they read t3Status). */
  services: () => Services;
}

/** Test seams: replace process spawning and network access. */
export interface IntegrationOverrides {
  runGh?: RunGh;
  fetch?: FetchFn;
  openSocket?: OpenSocket;
  log?: Logger;
}

/** Builds the GitHub (gh CLI) and T3 Code integrations. */
export function createIntegrations(deps: IntegrationDeps, overrides: IntegrationOverrides = {}): Integrations {
  const github = createGithubIntegration({
    services: deps.services,
    ...(overrides.runGh ? { runGh: overrides.runGh } : {}),
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
  let started = false;

  return {
    t3Status: () => t3.status(),
    githubStatus: () => github.status(),
    start() {
      if (!deps.config.pollers || started) return;
      started = true;
      github.start();
      t3.start();
    },
    stop() {
      started = false;
      github.stop();
      t3.stop();
    },
    listT3Projects: () => t3.listProjects(),
    importT3Projects: (ids) => t3.importProjects(ids),
    async refreshLink(linkId) {
      const link = deps.services().links.get(linkId);
      if (await github.refresh(link)) return;
      await t3.refresh(link);
    },
    testT3: () => t3.test(),
    t3LaunchOptions: (taskId) => t3.launchOptions(taskId),
    startT3Thread: (taskId, input, actor) => t3.startThread(taskId, input, actor),
  };
}
