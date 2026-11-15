import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventBus } from "./bus.ts";
import type { Config } from "./config.ts";
import { openDatabase, type Db } from "./db/database.ts";
import { instanceIdOf } from "./instance.ts";
import { createIntegrations, type IntegrationOverrides } from "./integrations/index.ts";
import { machineSecretsPath } from "./integrations/machineSecrets.ts";
import { remoteIdentity } from "./integrations/machines/checkouts.ts";
import { createServices } from "./services/index.ts";
import type { Services } from "./services/types.ts";
import type { AppContext } from "./app.ts";

/** The repository a folder's `origin` names, read on the spot (a runner logs it with a task made in that folder). */
function readRemote(workspaceRoot: string): { remote: string; remoteUrl: string } | null {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    timeout: 5_000,
  });
  const remoteUrl = result.status === 0 ? result.stdout.trim() : "";
  const remote = remoteUrl ? remoteIdentity(remoteUrl) : null;
  return remote ? { remote, remoteUrl } : null;
}

/** Wires db → bus → integrations → services. Used by main.ts and tests. */
export function createContext(
  config: Pick<Config, "dbPath" | "port" | "webPort" | "token" | "t3Home" | "pollers" | "userHome" | "sessionDirs"> &
    Partial<
      Pick<
        Config,
        | "webDist"
        | "worktreesDir"
        | "attachmentsDir"
        | "harnessHomes"
        | "demo"
        | "modelPricesPath"
        | "role"
        | "bind"
        | "releaseUrl"
      >
    > & {
      /** This board's id (instance.ts); read from the data dir unless set. An in-memory database gets a new one. */
      instanceId?: string;
    },
  overrides: IntegrationOverrides = {},
): AppContext & { db: Db } {
  const db = openDatabase(config.dbPath);
  // Next to the database unless set; an in-memory one (tests) has no folder, so a temp one stands in.
  const attachmentsDir =
    config.attachmentsDir ??
    (config.dbPath === ":memory:" ? join(tmpdir(), "attachments-test") : join(dirname(config.dbPath), "attachments"));
  // An in-memory board keeps the fetched price list in memory only.
  const modelPricesPath =
    config.modelPricesPath ?? (config.dbPath === ":memory:" ? null : join(dirname(config.dbPath), "model-prices.json"));
  const instanceId =
    config.instanceId ?? (config.dbPath === ":memory:" ? randomUUID() : instanceIdOf(dirname(config.dbPath)));
  const bus = new EventBus();
  let services: Services | null = null;
  const integrations = createIntegrations(
    {
      // Next to the database unless set, so a test's worktrees land in its own temp folder.
      config: {
        ...config,
        worktreesDir: config.worktreesDir ?? join(dirname(config.dbPath), "worktrees"),
        attachmentsDir,
        instanceId,
        modelPricesPath,
        // An in-memory board keeps its machine tokens in memory too.
        machineSecretsPath: config.dbPath === ":memory:" ? null : machineSecretsPath(dirname(config.dbPath)),
        reposDir:
          config.dbPath === ":memory:"
            ? join(tmpdir(), "repos-test", instanceId)
            : join(dirname(config.dbPath), "repos"),
        backupDefaultDir:
          config.dbPath === ":memory:" ? join(tmpdir(), "backup-test") : join(dirname(config.dbPath), "backup"),
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
    instanceId,
    userHome: config.userHome,
    ...(config.harnessHomes ? { harnessHomes: config.harnessHomes } : {}),
    usageDirs: {
      claudeDir: config.sessionDirs.claudeDir,
      codexHome: config.harnessHomes?.codex ?? join(config.userHome, ".codex"),
    },
    prHostHoldsTasks: (host) => integrations.prHostHoldsTasks(host),
    fetchThreadUsage: (threadId) => integrations.t3ThreadUsage(threadId),
    modelPrices: () => integrations.modelPrices.current(),
    role: config.role ?? "board",
    onHeldEdit: (machineId) => integrations.machineSync.flush(machineId),
    heldWork: {
      shell: (request) => integrations.remoteWork.shell(request),
      script: (request) => integrations.remoteWork.script(request),
    },
    readRemote: overrides.readRemote ?? readRemote,
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.automations ? { automations: overrides.automations } : {}),
    ...(overrides.runShell ? { runShell: overrides.runShell } : {}),
    ...(overrides.runScript ? { runScript: overrides.runScript } : {}),
    ...(overrides.runGit ? { runGit: overrides.runGit } : {}),
  });
  return { db, bus, services, integrations, config, instanceId };
}
