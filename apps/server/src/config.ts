import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND, DEFAULT_RUNNER_PORT, DEFAULT_SERVER_PORT, ServerRole, brandEnv } from "@repo/contracts";
import type { SessionDirs } from "./integrations/agentSessions.ts";
import { harnessHomesFrom, type HarnessHomes } from "./services/skillSync.ts";

export interface Config {
  /** `board`, or `runner`: the headless server on another machine, which serves no web app. */
  role: ServerRole;
  port: number;
  /** The Vite dev server's port. It proxies browser requests with its own Origin, which the guard allows. */
  webPort: number;
  host: string;
  homeDir: string;
  dbPath: string;
  /** Optional bearer token required on /api and /mcp when set. */
  token: string | null;
  /** Directory of the built web app to serve, if present. Always null for a runner. */
  webDist: string | null;
  /** Home of the T3 Code install to integrate with (`~/.t3`). */
  t3Home: string;
  /** Disable background pollers (tests). */
  pollers: boolean;
  /**
   * Registers /api/demo, which sets PR checks and pretend Autopilot runs so the README demo can be recorded with
   * the pollers off. Only the isolated sandbox sets it.
   */
  demo?: boolean;
  /** The user's home folder, where harnesses install skills (`~/.claude/skills`). */
  userHome: string;
  /** Each harness's folder (CLAUDE_CONFIG_DIR, COPILOT_HOME, CODEX_HOME or the default), where the board skill goes. */
  harnessHomes: HarnessHomes;
  /** Where Claude Code and Copilot CLI keep their running sessions, for linked sessions' status. */
  sessionDirs: SessionDirs;
  /** Where Autopilot's headless runs get their git worktrees. */
  worktreesDir: string;
  /** Where pasted images are stored, one folder per task. */
  attachmentsDir: string;
  /** The last LiteLLM price list fetched, with its fetch time (integrations/modelPrices.ts). Not backed up. */
  modelPricesPath: string;
}

/** Where the user opens the board: this server when it serves the built web app, else the Vite dev server. */
export function boardUrlOf({
  webDist,
  port,
  webPort,
}: Pick<Config, "port" | "webPort"> & Partial<Pick<Config, "webDist">>): string {
  return `http://127.0.0.1:${webDist && existsSync(webDist) ? port : webPort}`;
}

/**
 * `~/.<id>`, or `~/.<id>-runner` for a runner: with its own data dir (and port), a runner beside a board on the same
 * machine shares neither its database nor its port.
 */
export function defaultHomeDir(role: ServerRole, home = homedir()): string {
  return join(home, role === "runner" ? `.${BRAND.id}-runner` : `.${BRAND.id}`);
}

/** Env vars are prefixed with the product id, e.g. `ABOARD_HOME`. `--runner` among `argv` picks the runner role. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = []): Config {
  const roleEnv = env[brandEnv("ROLE")];
  const parsedRole = ServerRole.safeParse(roleEnv || "board");
  if (!parsedRole.success) throw new Error(`${brandEnv("ROLE")} must be board or runner, not "${roleEnv}"`);
  const role = argv.includes("--runner") ? "runner" : parsedRole.data;
  const homeDir = env[brandEnv("HOME")] ?? defaultHomeDir(role);
  // The sandbox points this at a throwaway folder, so installing skills from it never writes the real ~/.claude.
  const userHome = env[brandEnv("USER_HOME")] || homedir();
  mkdirSync(homeDir, { recursive: true });
  return {
    role,
    port: Number(env[brandEnv("PORT")] ?? (role === "runner" ? DEFAULT_RUNNER_PORT : DEFAULT_SERVER_PORT)),
    webPort: Number(env[brandEnv("WEB_PORT")] ?? 5317),
    host: "127.0.0.1",
    homeDir,
    dbPath: join(homeDir, "data.sqlite"),
    token: env[brandEnv("TOKEN")] || null,
    webDist:
      role === "runner"
        ? null
        : (env[brandEnv("WEB_DIST")] ??
          new URL("../../web/dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
    t3Home: env.T3CODE_HOME ?? join(homedir(), ".t3"),
    pollers: env[brandEnv("POLLERS")] !== "0",
    demo: env[brandEnv("DEMO")] === "1",
    userHome,
    harnessHomes: harnessHomesFrom(env, userHome),
    worktreesDir: join(homeDir, "worktrees"),
    attachmentsDir: join(homeDir, "attachments"),
    modelPricesPath: join(homeDir, "model-prices.json"),
    sessionDirs: {
      claudeDir: env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      copilotDir: env.COPILOT_HOME || join(homedir(), ".copilot"),
    },
  };
}
