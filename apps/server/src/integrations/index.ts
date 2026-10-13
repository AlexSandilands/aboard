import type { EventBus } from "../bus.ts";
import type { Config } from "../config.ts";
import type { Services } from "../services/types.ts";
import { DISABLED_T3_STATUS, type Integrations } from "./types.ts";

export interface IntegrationDeps {
  config: Pick<Config, "t3Home" | "pollers">;
  bus: EventBus;
  /** Late-bound: services are created after integrations (they read t3Status). */
  services: () => Services;
}

/** Builds integrations. Implemented by the integrations work package. */
export function createIntegrations(_deps: IntegrationDeps): Integrations {
  return {
    t3Status: () => DISABLED_T3_STATUS,
    githubStatus: () => ({ available: false, authenticated: false, error: null }),
    start: () => {},
    stop: () => {},
    listT3Projects: async () => [],
    importT3Projects: async () => [],
    refreshLink: async () => {},
    testT3: async () => DISABLED_T3_STATUS,
  };
}
