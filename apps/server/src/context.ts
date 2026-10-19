import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    Partial<Pick<Config, "webDist" | "worktreesDir" | "attachmentsDir" | "harnessHomes">>,
  overrides: IntegrationOverrides = {},
): AppContext & { db: Db } {
  const db = openDatabase(config.dbPath);
  // Next to the database unless set; an in-memory one (tests) has no folder, so a temp one stands in.
  const attachmentsDir =
    config.attachmentsDir ??
    (config.dbPath === ":memory:" ? join(tmpdir(), "attachments-test") : join(dirname(config.dbPath), "attachments"));
  const bus = new EventBus();
  let services: Services | null = null;
  const integrations = createIntegrations(
    {
      // Next to the database unless set, so a test's worktrees land in its own temp folder.
      config: {
        ...config,
        worktreesDir: config.worktreesDir ?? join(dirname(config.dbPath), "worktrees"),
        attachmentsDir,
      },
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
    attachmentsDir,
    userHome: config.userHome,
    ...(config.harnessHomes ? { harnessHomes: config.harnessHomes } : {}),
    prHostHoldsTasks: (host) => integrations.prHostHoldsTasks(host),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.automations ? { automations: overrides.automations } : {}),
    ...(overrides.runShell ? { runShell: overrides.runShell } : {}),
    ...(overrides.runScript ? { runScript: overrides.runScript } : {}),
    ...(overrides.runGit ? { runGit: overrides.runGit } : {}),
  });
  return { db, bus, services, integrations, config };
}
