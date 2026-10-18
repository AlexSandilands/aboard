import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.ts";
import { startServer } from "./server.ts";
import { harnessHomesFrom } from "./services/skillSync.ts";
import { runningServerUrl } from "./serverFile.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testConfig(overrides: Partial<Config> = {}): Config {
  const homeDir = mkdtempSync(join(tmpdir(), `${BRAND.id}-server-`));
  dirs.push(homeDir);
  return {
    port: 0,
    webPort: 5317,
    host: "127.0.0.1",
    homeDir,
    dbPath: join(homeDir, "data.sqlite"),
    token: null,
    webDist: null,
    t3Home: "/nonexistent",
    pollers: false,
    userHome: "/nonexistent",
    harnessHomes: harnessHomesFrom({}, "/nonexistent"),
    sessionDirs: { claudeDir: "/nonexistent/.claude", copilotDir: "/nonexistent/.copilot" },
    worktreesDir: join(homeDir, "worktrees"),
    attachmentsDir: join(homeDir, "attachments"),
    ...overrides,
  };
}

// Each test boots real servers (DB + migrations), which can exceed vitest's 5s default on the Windows CI runner.
describe("startServer", { timeout: 20_000 }, () => {
  it("listens on a free port, serves health, and closes despite an open SSE stream", async () => {
    const server = await startServer(testConfig());
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);

    const health = await fetch(`${server.url}/api/health`);
    expect(await health.json()).toEqual({ ok: true, id: BRAND.id, version: BRAND.version });
    // The Origin guard must know the real port, not the 0 we asked for.
    const sameOrigin = await fetch(`${server.url}/api/health`, { headers: { origin: server.url } });
    expect(sameOrigin.status).toBe(200);

    const events = await fetch(`${server.url}/events`);
    expect(events.status).toBe(200);

    await server.close();
    await expect(fetch(`${server.url}/api/health`)).rejects.toThrow("fetch failed");
    // Idempotent: a second quit signal must not throw on the closed DB.
    await server.close();
  });

  it("starts every board with a General project, once across restarts", async () => {
    const config = testConfig();
    const projectsOf = async (url: string) =>
      (await (await fetch(`${url}/api/projects`)).json()) as Array<{ id: string; title: string }>;
    const first = await startServer(config);
    const before = await projectsOf(first.url);
    expect(before.map((p) => p.title)).toEqual(["General"]);
    await first.close();

    const second = await startServer(config);
    expect(await projectsOf(second.url)).toEqual(before);
    await second.close();
  });

  it("rejects when the port is taken and releases the database", async () => {
    const first = await startServer(testConfig());
    const config = testConfig({ port: first.port });
    await expect(startServer(config)).rejects.toMatchObject({ code: "EADDRINUSE" });
    // The failed attempt must not leave the DB file locked (Windows can't delete open files).
    rmSync(config.homeDir, { recursive: true, force: true });
    await first.close();
  });

  it("records itself in the data dir while running, so a restore can refuse", async () => {
    const config = testConfig();
    expect(await runningServerUrl(config.homeDir)).toBeNull();
    const server = await startServer(config);
    expect(await runningServerUrl(config.homeDir)).toBe(server.url);
    await server.close();
    expect(await runningServerUrl(config.homeDir)).toBeNull();
  });

  it("ignores a server file left by a server that is gone", async () => {
    const config = testConfig();
    writeFileSync(join(config.homeDir, "server.json"), JSON.stringify({ pid: 1, url: "http://127.0.0.1:1" }));
    expect(await runningServerUrl(config.homeDir)).toBeNull();
  });
});
