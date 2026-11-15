import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND, DEFAULT_RUNNER_PORT, DEFAULT_SERVER_PORT, ServerRole, brandEnv } from "@repo/contracts";
import type { SessionDirs } from "./integrations/agentSessions.ts";
import { harnessHomesFrom, type HarnessHomes } from "./services/skillSync.ts";

export type ServerBind = "loopback" | "private";

export interface Config {
  /** `board`, or `runner`: the headless server on another machine, which serves no web app. */
  role: ServerRole;
  port: number;
  /**
   * Where the server listens. `loopback`: 127.0.0.1 only. `private`: every interface, serving only peers on this
   * machine, a LAN or the tailnet, so a board elsewhere can reach a runner's machine API; a runner's option only
   * (ADR 0015).
   */
  bind: ServerBind;
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
  /**
   * Where the headless server's release files are, instead of GitHub (`brandEnv("RELEASE_URL")`): a board uses it to
   * install and update machines, a runner to update itself. For trying those without publishing a release.
   */
  releaseUrl?: string | null;
  /** The last LiteLLM price list fetched, with its fetch time (integrations/modelPrices.ts). Not backed up. */
  modelPricesPath: string;
  /**
   * A board's: the port of the runner it hosts when the user lets other machines run tasks here
   * (`brandEnv("RUNNER_PORT")`, else the runner's default; hostedRunner.ts).
   */
  hostedRunnerPort?: number;
  /**
   * A runner's: the instance id of the board it runs inside, in that board's process (hostedRunner.ts). Such a runner
   * updates with the app, never at a board's request, and won't pair with the board hosting it.
   */
  hostedBy?: string | null;
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
  const bindEnv = env[brandEnv("BIND")] || "loopback";
  if (bindEnv !== "loopback" && bindEnv !== "private") {
    throw new Error(`${brandEnv("BIND")} must be loopback or private, not "${bindEnv}"`);
  }
  // A board has no machine API and no auth of its own, so nothing of it may be reachable from another machine.
  if (bindEnv === "private" && role !== "runner") {
    throw new Error(`${brandEnv("BIND")}=private is for a runner (--runner); a board listens on this machine only`);
  }
  const homeDir = env[brandEnv("HOME")] ?? defaultHomeDir(role);
  // The sandbox points this at a throwaway folder, so installing skills from it never writes the real ~/.claude.
  const userHome = env[brandEnv("USER_HOME")] || homedir();
  mkdirSync(homeDir, { recursive: true });
  return {
    role,
    port: Number(env[brandEnv("PORT")] ?? (role === "runner" ? DEFAULT_RUNNER_PORT : DEFAULT_SERVER_PORT)),
    webPort: Number(env[brandEnv("WEB_PORT")] ?? 5317),
    host: "127.0.0.1",
    bind: bindEnv,
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
    releaseUrl: env[brandEnv("RELEASE_URL")] || null,
    ...(role === "board" ? { hostedRunnerPort: Number(env[brandEnv("RUNNER_PORT")] || DEFAULT_RUNNER_PORT) } : {}),
    sessionDirs: {
      claudeDir: env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      copilotDir: env.COPILOT_HOME || join(homedir(), ".copilot"),
    },
  };
}

/** The data dir of the runner a board hosts: a folder of the board's own. */
export const hostedRunnerHome = (board: Pick<Config, "homeDir">): string => join(board.homeDir, "runner");

/**
 * The config of the runner a board hosts (hostedRunner.ts): the board's own, with the runner's data in a folder of the
 * board's data dir, so it shares no table, backup or worktree with the board, and the sandbox's throwaway board takes
 * its runner with it.
 */
export function hostedRunnerConfig(board: Config, instanceId: string, bind: ServerBind): Config {
  const homeDir = hostedRunnerHome(board);
  mkdirSync(homeDir, { recursive: true });
  return {
    ...board,
    role: "runner",
    port: board.hostedRunnerPort ?? DEFAULT_RUNNER_PORT,
    bind,
    homeDir,
    dbPath: join(homeDir, "data.sqlite"),
    webDist: null,
    demo: false,
    worktreesDir: join(homeDir, "worktrees"),
    attachmentsDir: join(homeDir, "attachments"),
    modelPricesPath: join(homeDir, "model-prices.json"),
    hostedRunnerPort: undefined,
    hostedBy: instanceId,
  };
}
