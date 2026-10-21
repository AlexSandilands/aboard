import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { createContext } from "../context.ts";
import { BRAND, type BoardEvent } from "@repo/contracts";
import { GhError } from "../integrations/gh.ts";
import type { SessionDirs } from "../integrations/agentSessions.ts";
import type { IntegrationOverrides } from "../integrations/index.ts";
import type { Config } from "../config.ts";

/** In-memory server context + app for tests. `events` collects everything published on the bus. */
/** Nothing in a test may reach `gh`, GitHub or Claude Code; an import started by a route fails at once instead. */
const NO_PROCESSES: IntegrationOverrides = {
  runGh: () => Promise.reject(new GhError("gh is not available in tests", false)),
  runImport: () => Promise.reject(new Error("Claude Code is not available in tests")),
  runAgent: () => Promise.reject(new Error("Claude Code is not available in tests")),
  runShell: () => Promise.reject(new Error("Shell commands don't run in tests")),
  runScript: () => Promise.reject(new Error("Scripts don't run in tests")),
  listMcpServers: () => Promise.resolve([]),
};

export function createTestHarness(
  overrides: {
    webPort?: number;
    token?: string;
    sessionDirs?: SessionDirs;
    /** The user's home folder, where global skills are found and built-in ones are forked to. */
    userHome?: string;
    harnessHomes?: Config["harnessHomes"];
    worktreesDir?: string;
    /** Registers the sandbox's /api/demo routes. */
    demo?: boolean;
    integrations?: IntegrationOverrides;
  } = {},
) {
  const { integrations, ...config } = overrides;
  const ctx = createContext(
    {
      dbPath: ":memory:",
      port: 4317,
      webPort: 5317,
      token: null,
      t3Home: "/nonexistent",
      pollers: false,
      userHome: "/nonexistent",
      sessionDirs: { claudeDir: "/nonexistent/.claude", copilotDir: "/nonexistent/.copilot" },
      // An in-memory database has no folder to put worktrees next to.
      worktreesDir: join(tmpdir(), `${BRAND.id}-test-worktrees`),
      attachmentsDir: mkdtempSync(join(tmpdir(), `${BRAND.id}-test-attachments-`)),
      ...config,
    },
    { ...NO_PROCESSES, ...integrations },
  );
  const app = createApp(ctx);
  const events: BoardEvent[] = [];
  ctx.bus.subscribe((e) => events.push(e));
  const request = (path: string, init?: RequestInit & { json?: unknown }) => {
    const { json, ...rest } = init ?? {};
    const headers = new Headers(rest.headers);
    if (!headers.has("host")) headers.set("host", "127.0.0.1:4317");
    if (json !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    return app.request(path, {
      ...rest,
      headers,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  };
  return { ...ctx, app, events, request };
}
