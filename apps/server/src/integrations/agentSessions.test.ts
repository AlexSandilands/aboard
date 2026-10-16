import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionRef } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import {
  createSessionStatusReader,
  scanClaudeSessions,
  sessionKey,
  START_TIME_TTL_MS,
  type ProcessProbe,
} from "./agentSessions.ts";
import { shQuote, type LaunchSpec, type TerminalHost } from "./terminal.ts";

const A = "b76a4a91-3196-48df-a421-9a32d5ac9978";
const B = "709f26ed-ce2f-4449-b7eb-3bb01f89f268";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome() {
  const root = mkdtempSync(join(tmpdir(), "sessions-"));
  dirs.push(root);
  const claudeDir = join(root, ".claude");
  const copilotDir = join(root, ".copilot");
  mkdirSync(join(claudeDir, "sessions"), { recursive: true });
  mkdirSync(join(copilotDir, "session-state"), { recursive: true });
  const claudeFile = (pid: number, body: unknown) =>
    writeFileSync(
      join(claudeDir, "sessions", `${pid}.json`),
      typeof body === "string" ? body : JSON.stringify({ pid, ...(body as object) }),
    );
  const copilotLock = (id: string, pid: number) => {
    mkdirSync(join(copilotDir, "session-state", id), { recursive: true });
    writeFileSync(join(copilotDir, "session-state", id, `inuse.${pid}.lock`), String(pid));
  };
  return { root, dirs: { claudeDir, copilotDir }, claudeFile, copilotLock };
}

/** Pids in `alive` are running; `starts` gives their start times (absent: unknown to the probe). */
function fakeProbe(alive: number[], starts: Record<number, string> | null = null) {
  const calls: number[][] = [];
  const probe: ProcessProbe = {
    isAlive: (pid) => alive.includes(pid),
    startTimes: (pids) => {
      calls.push([...pids]);
      return Promise.resolve(starts ? new Map(Object.entries(starts).map(([k, v]) => [Number(k), v])) : null);
    },
  };
  return { probe, calls };
}

const claude = (sessionId: string, cwd = "C:\\Code"): AgentSessionRef => ({ harness: "claude-code", sessionId, cwd });
const copilot = (sessionId: string, cwd = "C:\\Code"): AgentSessionRef => ({ harness: "copilot-cli", sessionId, cwd });

describe("Claude Code session status", () => {
  it("reads busy and idle from a live session's file, and whether it runs in an app", async () => {
    const home = tempHome();
    home.claudeFile(100, { sessionId: A, status: "busy", entrypoint: "sdk-ts" });
    home.claudeFile(200, { sessionId: B, status: "idle", entrypoint: "cli" });
    const reader = createSessionStatusReader({ dirs: home.dirs, probe: fakeProbe([100, 200]).probe });
    const out = await reader.read([claude(A), claude(B)]);
    expect(out.get(sessionKey(claude(A)))).toEqual({ status: "busy", inApp: true });
    expect(out.get(sessionKey(claude(B)))).toEqual({ status: "idle", inApp: false });
  });

  it("says not running for a stale file whose pid is gone, or no file at all", async () => {
    const home = tempHome();
    home.claudeFile(100, { sessionId: A, status: "busy" });
    const reader = createSessionStatusReader({ dirs: home.dirs, probe: fakeProbe([]).probe });
    const out = await reader.read([claude(A), claude(B)]);
    expect(out.get(sessionKey(claude(A)))?.status).toBe("not_running");
    expect(out.get(sessionKey(claude(B)))?.status).toBe("not_running");
  });

  it("ignores a file whose pid now belongs to another process", async () => {
    const home = tempHome();
    home.claudeFile(100, { sessionId: A, status: "busy", procStart: "111" });
    const reader = createSessionStatusReader({ dirs: home.dirs, probe: fakeProbe([100], { 100: "999" }).probe });
    expect((await reader.read([claude(A)])).get(sessionKey(claude(A)))?.status).toBe("not_running");
  });

  it("trusts a pid whose start time matches, or can't be read", async () => {
    const home = tempHome();
    home.claudeFile(100, { sessionId: A, status: "idle", procStart: "111" });
    home.claudeFile(200, { sessionId: B, status: "idle", procStart: "222" });
    const reader = createSessionStatusReader({ dirs: home.dirs, probe: fakeProbe([100, 200], { 100: "111" }).probe });
    const out = await reader.read([claude(A), claude(B)]);
    expect(out.get(sessionKey(claude(A)))?.status).toBe("idle");
    expect(out.get(sessionKey(claude(B)))?.status).toBe("idle");
  });

  it("reads start times once per pid until they go stale", async () => {
    const home = tempHome();
    home.claudeFile(100, { sessionId: A, status: "idle", procStart: "111" });
    const { probe, calls } = fakeProbe([100], { 100: "111" });
    let now = 0;
    const reader = createSessionStatusReader({ dirs: home.dirs, probe, now: () => now });
    await reader.read([claude(A)]);
    await reader.read([claude(A)]);
    expect(calls).toEqual([[100]]);
    now += START_TIME_TTL_MS + 1;
    await reader.read([claude(A)]);
    expect(calls).toHaveLength(2);
  });

  it("says unknown when a live process's file can't be parsed, since it may be ours", async () => {
    const home = tempHome();
    home.claudeFile(100, "{ not json");
    home.claudeFile(200, { sessionId: 42 });
    const reader = createSessionStatusReader({ dirs: home.dirs, probe: fakeProbe([100]).probe });
    expect((await reader.read([claude(A)])).get(sessionKey(claude(A)))?.status).toBe("unknown");
    // Once that process is gone, the broken file can't be anyone's.
    const later = createSessionStatusReader({ dirs: home.dirs, probe: fakeProbe([]).probe });
    expect((await later.read([claude(A)])).get(sessionKey(claude(A)))?.status).toBe("not_running");
  });

  it("says unknown when the sessions folder is missing", async () => {
    const reader = createSessionStatusReader({
      dirs: { claudeDir: join(tmpdir(), "no-such-claude-dir"), copilotDir: "x" },
      probe: fakeProbe([1]).probe,
    });
    expect((await reader.read([claude(A)])).get(sessionKey(claude(A)))).toEqual({ status: "unknown", inApp: false });
  });

  it("reads a status Claude Code adds later as running", async () => {
    const home = tempHome();
    home.claudeFile(100, { sessionId: A.toUpperCase(), status: "compacting" });
    const reader = createSessionStatusReader({ dirs: home.dirs, probe: fakeProbe([100]).probe });
    expect((await reader.read([claude(A)])).get(sessionKey(claude(A)))?.status).toBe("running");
  });

  it("skips files that aren't <pid>.json", () => {
    const home = tempHome();
    home.claudeFile(100, { sessionId: A });
    writeFileSync(join(home.dirs.claudeDir, "sessions", "100.abc.key"), "x");
    expect(scanClaudeSessions(home.dirs.claudeDir)).toEqual({
      sessions: [{ pid: 100, sessionId: A }],
      unreadable: [],
    });
  });
});

describe("Copilot CLI session status", () => {
  it("is running while a live process holds its lock", async () => {
    const home = tempHome();
    home.copilotLock(A, 300);
    home.copilotLock(B, 400);
    const reader = createSessionStatusReader({ dirs: home.dirs, probe: fakeProbe([300]).probe });
    const out = await reader.read([copilot(A), copilot(B)]);
    expect(out.get(sessionKey(copilot(A)))).toEqual({ status: "running", inApp: false });
    expect(out.get(sessionKey(copilot(B)))?.status).toBe("not_running");
  });

  it("is not running without a session folder, and unknown without session-state", async () => {
    const home = tempHome();
    const reader = createSessionStatusReader({ dirs: home.dirs, probe: fakeProbe([]).probe });
    expect((await reader.read([copilot(A)])).get(sessionKey(copilot(A)))?.status).toBe("not_running");
    rmSync(join(home.dirs.copilotDir, "session-state"), { recursive: true });
    expect((await reader.read([copilot(A)])).get(sessionKey(copilot(A)))?.status).toBe("unknown");
  });
});

// ── Through the app ──────────────────────────────────────────────────────

const WT_SETTINGS = JSON.stringify({
  defaultProfile: "{bash}",
  profiles: { list: [{ guid: "{bash}", name: "Git Bash", commandline: "C:\\Git\\bin\\bash.exe" }] },
});

function appWith(opts: { alive?: number[]; host?: Partial<TerminalHost>; spawnError?: Error } = {}) {
  const home = tempHome();
  const spawned: LaunchSpec[] = [];
  const host: TerminalHost = {
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Local" },
    readFile: (path) => (path.includes("Microsoft.WindowsTerminal_") ? WT_SETTINGS : null),
    which: (name) => (name === "wt.exe" ? "C:\\WindowsApps\\wt.exe" : null),
    ...opts.host,
  };
  const ctx = createTestHarness({
    integrations: {
      processProbe: fakeProbe(opts.alive ?? []).probe,
      terminalHost: () => host,
      spawnTerminal: (spec) => {
        spawned.push(spec);
        return opts.spawnError ? Promise.reject(opts.spawnError) : Promise.resolve();
      },
    },
    sessionDirs: home.dirs,
  });
  const s = ctx.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: home.root });
  const task = s.tasks.create({ projectId: project.id, title: "Work" });
  const link = (ref: AgentSessionRef) => s.links.add(task.id, { agentSession: ref }, "claude-code");
  const post = (id: string, json: unknown) => ctx.request(`/api/links/${id}/resume`, { method: "POST", json });
  return { ...ctx, home, spawned, link, post, task };
}

describe("resuming a session", () => {
  it("opens a stopped session in Windows Terminal's default profile", async () => {
    const app = appWith();
    const l = app.link(claude(A, app.home.root));
    const res = await app.post(l.id, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      launched: true,
      // Quoted only where the temp path needs it: a Windows path does (backslashes), /tmp/... doesn't.
      command: `cd ${shQuote(app.home.root)} && claude --resume ${A}`,
      error: null,
    });
    expect(app.spawned).toEqual([
      {
        file: "wt.exe",
        args: [
          "-w",
          "new",
          "new-tab",
          "-p",
          "{bash}",
          "-d",
          app.home.root,
          "C:\\Git\\bin\\bash.exe",
          "-l",
          "-i",
          "-c",
          `claude --resume ${A}\\; exec bash`,
        ],
        cwd: app.home.root,
      },
    ]);
  });

  it("refuses a running session with 409 and its status, unless forced", async () => {
    const app = appWith({ alive: [100] });
    app.home.claudeFile(100, { sessionId: A, status: "busy", entrypoint: "sdk-ts" });
    const l = app.link(claude(A, app.home.root));
    const res = await app.post(l.id, { mode: "resume" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "CONFLICT", details: { status: "busy", inApp: true } } });
    expect(app.spawned).toHaveLength(0);
    // The check also refreshed the card.
    expect(app.services.links.get(l.id)).toMatchObject({ snapshot: { status: "busy" } });

    expect((await app.post(l.id, { force: true })).status).toBe(200);
    expect(app.spawned).toHaveLength(1);
  });

  it("forks a running Claude session without forcing", async () => {
    const app = appWith({ alive: [100] });
    app.home.claudeFile(100, { sessionId: A, status: "idle" });
    const l = app.link(claude(A, app.home.root));
    expect((await app.post(l.id, { mode: "fork" })).status).toBe(200);
    expect(app.spawned[0]!.args.at(-1)).toBe(`claude --resume ${A} --fork-session\\; exec bash`);
  });

  it("can't fork a Copilot session", async () => {
    const app = appWith();
    const l = app.link(copilot(A, app.home.root));
    const res = await app.post(l.id, { mode: "fork" });
    expect(res.status).toBe(400);
    expect(app.spawned).toHaveLength(0);
  });

  it("refuses a session whose folder is gone", async () => {
    const app = appWith();
    const l = app.link(claude(A, join(app.home.root, "deleted")));
    const res = await app.post(l.id, {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/no longer exists/);
  });

  it("returns the command to copy when the terminal won't start", async () => {
    const app = appWith({ spawnError: new Error("spawn wt.exe ENOENT") });
    const l = app.link(claude(A, app.home.root));
    const body = (await (await app.post(l.id, {})).json()) as { launched: boolean; command: string; error: string };
    expect(body.launched).toBe(false);
    expect(body.command).toContain(`claude --resume ${A}`);
    expect(body.error).toMatch(/Couldn't start Windows Terminal \(Git Bash\): spawn wt.exe ENOENT/);
  });

  it("refuses links that aren't agent sessions", async () => {
    const app = appWith();
    const l = app.services.links.add(app.task.id, { value: "https://example.com" }, "u");
    expect((await app.post(l.id, {})).status).toBe(400);
  });

  it("gives the copy command for the terminal's shell", async () => {
    const app = appWith({ host: { which: () => null } });
    const l = app.link(copilot(A, "C:\\My Code"));
    const res = await app.request(`/api/links/${l.id}/resume-command`);
    expect(await res.json()).toEqual({ command: `cd /d "C:\\My Code" && copilot --resume=${A}`, cwd: "C:\\My Code" });
  });
});

describe("GET /api/terminal", () => {
  it("describes auto, the profiles and what the setting would run", async () => {
    const app = appWith();
    const info = await (await app.request("/api/terminal")).json();
    expect(info).toMatchObject({
      platform: "win32",
      autoLabel: "Windows Terminal (Git Bash)",
      profiles: [{ guid: "{bash}", name: "Git Bash", shell: "bash" }],
      defaultProfile: "{bash}",
      error: null,
    });
    expect((info as { preview: string }).preview).toMatch(
      /^wt\.exe -w new new-tab -p \{bash\} -d .* -c "claude --resume /,
    );
  });

  it("reports a setting that can't run here", async () => {
    const app = appWith({ host: { platform: "linux", which: () => null } });
    app.services.settings.update({ terminal: { kind: "cmd" } });
    const info = (await (await app.request("/api/terminal")).json()) as { preview: unknown; error: string };
    expect(info.preview).toBeNull();
    expect(info.error).toMatch(/only available on Windows/);
  });
});

describe("Claude Code session titles", () => {
  const writeTranscript = (home: ReturnType<typeof tempHome>, id: string, cwd: string, body: object[]) => {
    const folder = join(home.dirs.claudeDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${id}.jsonl`), body.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  };

  it("shows the title of a session that has ended, from its transcript", async () => {
    const home = tempHome();
    writeTranscript(home, A, "/w/app", [{ type: "ai-title", aiTitle: "Name the sessions" }]);
    const reader = createSessionStatusReader({ dirs: home.dirs, probe: fakeProbe([]).probe });
    const out = await reader.read([claude(A, "/w/app"), claude(B, "/w/app")]);
    expect(out.get(sessionKey(claude(A)))).toEqual({ status: "not_running", inApp: false, title: "Name the sessions" });
    // No transcript: no title, and the snapshot is what it always was.
    expect(out.get(sessionKey(claude(B)))).toEqual({ status: "not_running", inApp: false });
  });

  it("prefers a live session's own name, but not one Claude only derived from the folder", async () => {
    const home = tempHome();
    home.claudeFile(100, { sessionId: A, status: "busy", name: "Autopilot · Fix PRs", nameSource: "flag" });
    home.claudeFile(200, { sessionId: B, status: "idle", name: "app-12", nameSource: "derived" });
    writeTranscript(home, A, "/w/app", [{ type: "ai-title", aiTitle: "Generated" }]);
    writeTranscript(home, B, "/w/app", [{ type: "ai-title", aiTitle: "Generated for B" }]);
    const reader = createSessionStatusReader({ dirs: home.dirs, probe: fakeProbe([100, 200]).probe });
    const out = await reader.read([claude(A, "/w/app"), claude(B, "/w/app")]);
    expect(out.get(sessionKey(claude(A)))).toEqual({ status: "busy", inApp: false, title: "Autopilot · Fix PRs" });
    expect(out.get(sessionKey(claude(B)))).toEqual({ status: "idle", inApp: false, title: "Generated for B" });
  });

  it("tidies a live name the way it does a transcript title", async () => {
    const home = tempHome();
    const name = `  Two
 lines ${"x".repeat(300)}`;
    home.claudeFile(100, { sessionId: A, status: "busy", name, nameSource: "flag" });
    const reader = createSessionStatusReader({ dirs: home.dirs, probe: fakeProbe([100]).probe });
    const title = (await reader.read([claude(A)])).get(sessionKey(claude(A)))?.title ?? "";
    expect(title).toHaveLength(120);
    expect(title.startsWith("Two lines xxx")).toBe(true);
  });

  it("still finds a title when the sessions folder can't be read", async () => {
    const home = tempHome();
    rmSync(join(home.dirs.claudeDir, "sessions"), { recursive: true });
    writeTranscript(home, A, "/w/app", [{ type: "custom-title", customTitle: "Reviewing #7" }]);
    const reader = createSessionStatusReader({ dirs: home.dirs, probe: fakeProbe([]).probe });
    const out = await reader.read([claude(A, "/w/app")]);
    expect(out.get(sessionKey(claude(A)))).toEqual({ status: "unknown", inApp: false, title: "Reviewing #7" });
  });
});
