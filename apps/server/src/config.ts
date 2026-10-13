import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  port: number;
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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const homeDir = env.TASKBOARD_HOME ?? join(homedir(), ".taskboard");
  mkdirSync(homeDir, { recursive: true });
  return {
    port: Number(env.TASKBOARD_PORT ?? 4317),
    host: "127.0.0.1",
    homeDir,
    dbPath: join(homeDir, "taskboard.sqlite"),
    token: env.TASKBOARD_TOKEN || null,
    webDist: env.TASKBOARD_WEB_DIST ?? new URL("../../web/dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    t3Home: env.T3CODE_HOME ?? join(homedir(), ".t3"),
    pollers: env.TASKBOARD_POLLERS !== "0",
  };
}
