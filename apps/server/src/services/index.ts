import type { T3IntegrationStatus } from "@taskboard/contracts";
import type { EventBus } from "../bus.ts";
import type { Db } from "../db/database.ts";
import type { Services } from "./types.ts";

export interface ServiceDeps {
  db: Db;
  bus: EventBus;
  /** Current T3 integration status, embedded in board snapshots. */
  t3Status: () => T3IntegrationStatus;
}

/** Builds the service layer. Implemented by the server-core work package. */
export function createServices(_deps: ServiceDeps): Services {
  const notImplemented = new Proxy(
    {},
    {
      get: (_t, prop) => () => {
        throw new Error(`service method not implemented: ${String(prop)}`);
      },
    },
  );
  return {
    projects: notImplemented,
    tasks: notImplemented,
    plans: notImplemented,
    links: notImplemented,
    settings: notImplemented,
    board: notImplemented,
  } as Services;
}
