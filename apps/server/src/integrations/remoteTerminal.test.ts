import { execFileSync, spawn as spawnProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { SpawnSsh } from "./machines/ssh.ts";
import {
  loginShellQuote,
  ownMcpArgs,
  remotePreflight,
  remoteSessionArgv,
  remoteSessionScript,
  runnerPortOf,
  sshRouteOf,
  tmuxSessionName,
} from "./remoteTerminal.ts";

const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An ssh that prints `stdout` and exits with `code`, recording what it was asked to run. */
function fakeSsh(stdout: string, code = 0, stderr = ""): { spawn: SpawnSsh; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: SpawnSsh = (args) => {
    calls.push(args);
    return {
      onStdout: (listener) => queueMicrotask(() => listener(stdout)),
      onStderr: (listener) => queueMicrotask(() => listener(stderr)),
      exit: new Promise((resolve) => setTimeout(() => resolve({ code }), 0)),
      kill: () => {},
    };
  };
  return { spawn, calls };
}

describe("the ssh route to a machine", () => {
  it("is its ssh route, else its tailnet address or name, else none", () => {
    expect(
      sshRouteOf([
        { kind: "direct", url: "http://100.101.102.103:4318" },
        { kind: "ssh", target: "me@engine", port: 2222, remotePort: 4318 },
      ]),
    ).toEqual({ target: "me@engine", port: 2222 });
    expect(sshRouteOf([{ kind: "direct", url: "http://100.101.102.103:4318" }])).toEqual({
      target: "100.101.102.103",
      port: null,
    });
    expect(sshRouteOf([{ kind: "direct", url: "http://engine.tail1234.ts.net:4318" }])).toEqual({
      target: "engine.tail1234.ts.net",
      port: null,
    });
    // A LAN address or a proxy's https name says nothing of whether ssh reaches the machine.
    expect(sshRouteOf([{ kind: "direct", url: "https://runner.example.com" }])).toBeNull();
    expect(sshRouteOf([{ kind: "direct", url: "http://192.168.1.20:4318" }])).toBeNull();
  });

  it("gives the runner's port, where its MCP endpoint is", () => {
    expect(runnerPortOf([{ kind: "ssh", target: "engine", port: null, remotePort: 4999 }])).toBe(4999);
    expect(runnerPortOf([{ kind: "direct", url: "http://100.101.102.103:4320" }])).toBe(4320);
    expect(runnerPortOf([])).toBe(4318);
  });
});

describe("the command that opens a session on a machine", () => {
  it.runIf(posix)("quotes text so a login shell reads it back as written", () => {
    for (const text of [`it's`, `back\\slash`, `"quoted" $HOME; rm -rf / \`x\``, `\\'`, ``]) {
      expect(execFileSync("sh", ["-c", `printf %s ${loginShellQuote(text)}`], { encoding: "utf8" })).toBe(text);
    }
  });

  it("attaches to the session's tmux session or makes it, in the session's folder", () => {
    const script = remoteSessionScript({
      cwd: "/home/me/.app/worktrees/sessions/app/7-abcd",
      argv: ["claude", "--resume", "0b9b8f9e-2a43-4c55-9d3a-6f2c1e7d8a90"],
      tmuxName: tmuxSessionName("0b9b8f9e-2a43-4c55-9d3a-6f2c1e7d8a90"),
      mcpUrl: "http://127.0.0.1:4318/mcp",
    });
    expect(script).toContain("exec tmux new-session -A -s ");
    expect(script).toContain("-c /home/me/.app/worktrees/sessions/app/7-abcd");
    expect(script).toContain("tmux is not installed");
    expect(script).not.toContain('"');
    expect(tmuxSessionName("0b9b8f9e-2a43-4c55-9d3a-6f2c1e7d8a90")).toMatch(/-0b9b8f9e2a43$/);

    const argv = remoteSessionArgv({ target: "me@engine", port: 2222 }, script);
    expect(argv.slice(0, 6)).toEqual(["ssh", "-t", "-p", "2222", "--", "me@engine"]);
    expect(argv[6]).toMatch(/^sh -lc '/);
  });

  it.runIf(posix)("gives Claude Code and Codex the runner's MCP endpoint, decoded on the machine", () => {
    const decode = (args: string) => execFileSync("sh", ["-c", `printf '%s\\n' ${args}`], { encoding: "utf8" });
    const claude = ownMcpArgs("claude", "http://127.0.0.1:4318/mcp")!;
    expect(JSON.parse(decode(claude).split("\n")[1]!)).toEqual({
      mcpServers: { [BRAND.id]: { type: "http", url: "http://127.0.0.1:4318/mcp" } },
    });
    expect(decode(ownMcpArgs("codex", "http://127.0.0.1:4318/mcp")!)).toBe(
      `-c\nmcp_servers.${BRAND.id}.url="http://127.0.0.1:4318/mcp"\n`,
    );
    expect(ownMcpArgs("copilot", "http://127.0.0.1:4318/mcp")).toBeNull();
  });
});

const ENGINE = { id: "m1", name: "engine" };

describe("asking the machine first", () => {
  const check = { cwd: "/w/app", harness: "claude-code" as const, exe: "claude", tmuxName: "app-0b9b8f9e2a43" };

  it("says whether the session's tmux session is open", async () => {
    const { spawn, calls } = fakeSsh("open\nchecked\n");
    await expect(remotePreflight(spawn, ENGINE, { target: "engine", port: null }, check)).resolves.toEqual({
      open: true,
    });
    expect(calls[0]).toContain("BatchMode=yes");
    await expect(
      remotePreflight(fakeSsh("checked\n").spawn, ENGINE, { target: "engine", port: null }, check),
    ).resolves.toEqual({ open: false });
  });

  it("says what to install, or how ssh failed, and offers T3 Code", async () => {
    const route = { target: "engine", port: null };
    await expect(remotePreflight(fakeSsh("no-tmux\nchecked\n").spawn, ENGINE, route, check)).rejects.toMatchObject({
      message: expect.stringContaining("tmux isn't installed on engine"),
      details: { t3: "offer", machineId: "m1" },
    });
    await expect(remotePreflight(fakeSsh("no-cli\nchecked\n").spawn, ENGINE, route, check)).rejects.toThrow(
      "Claude Code (`claude`) isn't on the PATH of a login shell on engine",
    );
    await expect(remotePreflight(fakeSsh("no-folder\nchecked\n").spawn, ENGINE, route, check)).rejects.toThrow(
      "no longer exists on engine: /w/app",
    );
    await expect(
      remotePreflight(fakeSsh("", 255, "me@engine: Permission denied (publickey).").spawn, ENGINE, route, check),
    ).rejects.toThrow(/SSH couldn't log in to engine.*a T3 Code thread there doesn't need it/);
  });
});

describe.runIf(posix)("the scripts, run against a stand-in tmux", () => {
  /**
   * A folder with a `tmux` that logs its arguments and answers as a server would with one tmux session whose CLI has
   * `ended` or not, and an `ssh` that runs the remote command here with that folder first on PATH.
   */
  function machine(state: { session: boolean; ended: boolean }) {
    const bin = mkdtempSync(join(tmpdir(), "remote-tmux-"));
    dirs.push(bin);
    const log = join(bin, "log");
    writeFileSync(
      join(bin, "tmux"),
      [
        "#!/bin/sh",
        `echo "$*" >> ${log}`,
        `case "$1" in`,
        `  has-session) ${state.session ? "exit 0" : "exit 1"} ;;`,
        `  show-options) ${state.ended ? "echo 1" : ":"} ;;`,
        "esac",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: bin };
    const spawn: SpawnSsh = (args) => {
      const child = spawnProcess("sh", ["-c", args.at(-1)!], { env });
      const exit = new Promise<{ code: number | null }>((resolve) => child.once("close", (code) => resolve({ code })));
      return {
        onStdout: (listener) => void child.stdout.on("data", (b: Buffer) => listener(b.toString())),
        onStderr: (listener) => void child.stderr.on("data", (b: Buffer) => listener(b.toString())),
        exit,
        kill: () => void child.kill(),
      };
    };
    const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
    return { bin, env, spawn, calls };
  }
  const check = (cwd: string) => ({ cwd, harness: "claude-code" as const, exe: "claude", tmuxName: "app-abc" });

  it("is open only while the CLI still runs in the tmux session", async () => {
    const route = { target: "engine", port: null };
    const running = machine({ session: true, ended: false });
    await expect(remotePreflight(running.spawn, ENGINE, route, check(running.bin))).resolves.toEqual({ open: true });
    const ended = machine({ session: true, ended: true });
    await expect(remotePreflight(ended.spawn, ENGINE, route, check(ended.bin))).resolves.toEqual({ open: false });
    const none = machine({ session: false, ended: false });
    await expect(remotePreflight(none.spawn, ENGINE, route, check(none.bin))).resolves.toEqual({ open: false });
  });

  it("ends a tmux session whose CLI has exited before opening it again, and marks it when the CLI exits", () => {
    const run = (state: { session: boolean; ended: boolean }) => {
      const m = machine(state);
      const script = remoteSessionScript({ cwd: m.bin, argv: ["claude", "--resume", "x"], tmuxName: "app-abc" });
      execFileSync("sh", ["-c", script], { env: m.env });
      return m.calls();
    };
    const ended = run({ session: true, ended: true });
    expect(ended).toContain("kill-session -t =app-abc");
    expect(ended.at(-1)).toMatch(
      /^new-session -A -s app-abc -c .* sh -c claude --resume x; tmux set-option -q @ended 1;/,
    );
    expect(run({ session: true, ended: false })).not.toContain("kill-session -t =app-abc");
  });
});
