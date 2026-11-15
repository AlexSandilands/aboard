import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, DEFAULT_RUNNER_PORT, DEFAULT_SERVER_PORT, brandEnv } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { defaultHomeDir, loadConfig } from "./config.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), `${BRAND.id}-config-`));
  dirs.push(home);
  return { [brandEnv("HOME")]: home, [brandEnv("WEB_DIST")]: join(home, "web"), ...extra };
}

describe("loadConfig", () => {
  it("is a board that serves its web app by default", () => {
    const config = loadConfig(env());
    expect(config.role).toBe("board");
    expect(config.webDist).not.toBeNull();
  });

  it("is a runner with no web app when started with --runner or the role env var", () => {
    for (const config of [loadConfig(env(), ["--runner"]), loadConfig(env({ [brandEnv("ROLE")]: "runner" }))]) {
      expect(config.role).toBe("runner");
      expect(config.webDist).toBeNull();
    }
  });

  it("gives a runner its own default data dir and port, so it can run beside a board", () => {
    expect(defaultHomeDir("board", "/home/u")).toBe(join("/home/u", `.${BRAND.id}`));
    expect(defaultHomeDir("runner", "/home/u")).toBe(join("/home/u", `.${BRAND.id}-runner`));
    expect(loadConfig(env()).port).toBe(DEFAULT_SERVER_PORT);
    expect(loadConfig(env(), ["--runner"]).port).toBe(DEFAULT_RUNNER_PORT);
    expect(loadConfig(env({ [brandEnv("PORT")]: "5000" }), ["--runner"]).port).toBe(5000);
  });

  it("refuses an unknown role rather than starting as a board", () => {
    expect(() => loadConfig(env({ [brandEnv("ROLE")]: "engine" }))).toThrow(/board or runner/);
  });
});
