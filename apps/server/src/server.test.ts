import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.ts";
import { startServer } from "./server.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testConfig(overrides: Partial<Config> = {}): Config {
  const homeDir = mkdtempSync(join(tmpdir(), `${BRAND.id}-server-`));
  dirs.push(homeDir);
  return {
    port: 0,
    host: "127.0.0.1",
    homeDir,
    dbPath: join(homeDir, "data.sqlite"),
    token: null,
    webDist: null,
    t3Home: "/nonexistent",
    pollers: false,
    ...overrides,
  };
}

// Each test boots real servers (DB + migrations), which can exceed vitest's 5s default on the Windows CI runner.
const SERVER_TEST_TIMEOUT_MS = 20_000;

describe("startServer", () => {
  it(
    "listens on a free port, serves health, and closes despite an open SSE stream",
    async () => {
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
    },
    SERVER_TEST_TIMEOUT_MS,
  );

  it(
    "rejects when the port is taken and releases the database",
    async () => {
      const first = await startServer(testConfig());
      const config = testConfig({ port: first.port });
      await expect(startServer(config)).rejects.toMatchObject({ code: "EADDRINUSE" });
      // The failed attempt must not leave the DB file locked (Windows can't delete open files).
      rmSync(config.homeDir, { recursive: true, force: true });
      await first.close();
    },
    SERVER_TEST_TIMEOUT_MS,
  );
});
