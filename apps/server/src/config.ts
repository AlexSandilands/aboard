import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND, brandEnv } from "@repo/contracts";
import type { SessionDirs } from "./integrations/agentSessions.ts";

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
  /** Where Claude Code and Copilot CLI keep their running sessions, for linked sessions' status. */
  sessionDirs: SessionDirs;
  /** Where Autopilot's headless runs get their git worktrees. */
  worktreesDir: string;
}

/** Env vars are prefixed with the product id, e.g. `ABOARD_HOME`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const homeDir = env[brandEnv("HOME")] ?? join(homedir(), `.${BRAND.id}`);
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
    userHome: homedir(),
    worktreesDir: join(homeDir, "worktrees"),
    sessionDirs: {
      claudeDir: env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      copilotDir: env.COPILOT_HOME || join(homedir(), ".copilot"),
    },
  };
}
