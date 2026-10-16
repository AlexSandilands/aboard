import { EventBus } from "./bus.ts";
import type { Config } from "./config.ts";
import { openDatabase, type Db } from "./db/database.ts";
import { createIntegrations, type IntegrationOverrides } from "./integrations/index.ts";
import { createServices } from "./services/index.ts";
import type { Services } from "./services/types.ts";
import type { AppContext } from "./app.ts";

/** Wires db → bus → integrations → services. Used by main.ts and tests. */
export function createContext(
  config: Pick<Config, "dbPath" | "port" | "webPort" | "token" | "t3Home" | "pollers" | "userHome" | "sessionDirs"> &
    Partial<Pick<Config, "webDist">>,
  overrides: IntegrationOverrides = {},
): AppContext & { db: Db } {
  const db = openDatabase(config.dbPath);
  const bus = new EventBus();
  let services: Services | null = null;
  const integrations = createIntegrations(
    {
      config,
      bus,
      services: () => {
        if (!services) throw new Error("services not ready");
        return services;
      },
    },
    overrides,
  );
  services = createServices({
    db,
    bus,
    t3Status: () => integrations.t3Status(),
    prHostHoldsTasks: (host) => integrations.prHostHoldsTasks(host),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.automations ? { automations: overrides.automations } : {}),
  });
  return { db, bus, services, integrations, config };
}
