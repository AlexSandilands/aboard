import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND, brandEnv } from "@repo/contracts";
import type { SessionDirs } from "./integrations/agentSessions.ts";
import { harnessHomesFrom, type HarnessHomes } from "./services/skillSync.ts";

export interface Config {
  port: number;
  /** The Vite dev server's port. It proxies browser requests with its own Origin, which the guard allows. */
  webPort: number;
  host: string;
  homeDir: string;
  dbPath: string;
  /** Optional bearer token required on /api and /mcp when set. */
  token: string | null;
  /** Directory of the built web app to serve, if present. */
  webDist: string | null;
  /** Home of the T3 Code install to integrate with (`~/.t3`). */
  t3Home: string;
  /** Disable background pollers (tests). */
  pollers: boolean;
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
}

/** Where the user opens the board: this server when it serves the built web app, else the Vite dev server. */
export function boardUrlOf({
  webDist,
  port,
  webPort,
}: Pick<Config, "port" | "webPort"> & Partial<Pick<Config, "webDist">>): string {
  return `http://127.0.0.1:${webDist && existsSync(webDist) ? port : webPort}`;
}

/** Env vars are prefixed with the product id, e.g. `ABOARD_HOME`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const homeDir = env[brandEnv("HOME")] ?? join(homedir(), `.${BRAND.id}`);
  // The sandbox points this at a throwaway folder, so installing skills from it never writes the real ~/.claude.
  const userHome = env[brandEnv("USER_HOME")] || homedir();
  mkdirSync(homeDir, { recursive: true });
  return {
    port: Number(env[brandEnv("PORT")] ?? 4317),
    webPort: Number(env[brandEnv("WEB_PORT")] ?? 5317),
    host: "127.0.0.1",
    homeDir,
    dbPath: join(homeDir, "data.sqlite"),
    token: env[brandEnv("TOKEN")] || null,
    webDist:
      env[brandEnv("WEB_DIST")] ?? new URL("../../web/dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    t3Home: env.T3CODE_HOME ?? join(homedir(), ".t3"),
    pollers: env[brandEnv("POLLERS")] !== "0",
    userHome,
    harnessHomes: harnessHomesFrom(env, userHome),
    worktreesDir: join(homeDir, "worktrees"),
    attachmentsDir: join(homeDir, "attachments"),
    sessionDirs: {
      claudeDir: env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      copilotDir: env.COPILOT_HOME || join(homedir(), ".copilot"),
    },
  };
}
