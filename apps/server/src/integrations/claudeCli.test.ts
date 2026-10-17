import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cmdShimArgs, parseClaudeOutput, resolveExecutable, runClaude } from "./claudeCli.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("claude CLI", () => {
  it("resolves commands on PATH with Windows extensions", () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "claude.EXE"), "");
    const env = { PATH: join(dir, "bin"), PATHEXT: ".COM;.EXE" };
    expect(resolveExecutable("claude", env, "win32")?.toLowerCase()).toBe(join(dir, "bin", "claude.exe").toLowerCase());
    expect(resolveExecutable("missing", env, "win32")).toBeNull();
    expect(resolveExecutable(join(dir, "bin", "claude"), env, "win32")).not.toBeNull();
  });
  it("prefers a Windows shim over the extensionless script beside it", () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-"));
    writeFileSync(join(dir, "copilot"), "");
    writeFileSync(join(dir, "copilot.cmd"), "");
    const env = { PATH: dir, PATHEXT: ".EXE;.CMD" };
    expect(resolveExecutable("copilot", env, "win32")?.toLowerCase()).toBe(join(dir, "copilot.cmd").toLowerCase());
    expect(resolveExecutable("copilot", env, "linux")).toBe(join(dir, "copilot"));
  });
  // Only meaningful on Windows, where cmd.exe parses the line; the escaping is what makes it round-trip.
  it.runIf(process.platform === "win32")("runs a .cmd shim in a folder with spaces, arguments intact", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "headless-")), "Program Files", "claude cli");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "echo.mjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    writeFileSync(join(dir, "claude.cmd"), '@node "%~dp0echo.mjs" %*\r\n');
    const args = [
      "--json-schema",
      JSON.stringify({ a: 'b "c"', d: ["x y", "&|<>^%!"] }),
      "Bash(git diff *)",
      "trailing\\",
    ];
    const child = spawnSync(process.env.ComSpec ?? "cmd.exe", cmdShimArgs(join(dir, "claude.cmd"), args), {
      windowsVerbatimArguments: true,
      encoding: "utf8",
    });
    expect(JSON.parse(child.stdout)).toEqual(args);
  });

  it("checks the structured output against the schema", () => {
    const schema = z.object({ title: z.string() });
    const ok = JSON.stringify({ is_error: false, total_cost_usd: 0.01, structured_output: { title: "x" } });
    expect(parseClaudeOutput(ok, schema, "import")).toEqual({ output: { title: "x" }, costUsd: 0.01 });
    const wrong = JSON.stringify({ is_error: false, structured_output: { title: 3 } });
    expect(() => parseClaudeOutput(wrong, schema, "import")).toThrow("expected shape");
    const failed = JSON.stringify({ is_error: true, subtype: "error_max_turns" });
    expect(() => parseClaudeOutput(failed, schema, "import")).toThrow("Claude Code's import failed: error max turns");
  });

  // Windows ends the tree with taskkill /T; elsewhere the run is its own process group.
  it.skipIf(process.platform === "win32")("ends everything a timed-out run started", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-cli-kill-"));
    try {
      const pidFile = join(dir, "child.pid");
      const cli = join(dir, "claude");
      // Starts a child of its own, the way claude starts shells, and waits on it past the timeout.
      writeFileSync(cli, `#!/bin/sh\nsleep 60 &\necho $! > "${pidFile}"\nwait\n`);
      chmodSync(cli, 0o755);
      await expect(runClaude({ cli, cwd: dir, prompt: "", args: [], timeoutMs: 500 })).rejects.toThrow(
        "didn't finish within",
      );
      const child = Number(readFileSync(pidFile, "utf8"));
      await expect.poll(() => alive(child), { timeout: 5_000 }).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
