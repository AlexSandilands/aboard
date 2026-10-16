import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionRef, AgentSessionSnapshot, AutopilotRun, TaskLink } from "@repo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import {
  createAgentSessionsIntegration,
  createSessionStatusReader,
  scanClaudeSessions,
  SESSION_INTERVAL_MS,
  SESSION_POLL_TIMEOUT_MS,
  sessionKey,
  START_TIME_TTL_MS,
  type AgentSessionServices,
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

describe("an Autopilot session through the services", () => {
  it("is working while its run goes, then finished with when it ended, read from the stored run", async () => {
    const app = appWith();
    const s = app.services;
    const run = s.autopilot.record({
      automation: "test",
      candidate: { dedupeKey: "k", summary: "go", taskId: app.task.id, projectId: app.task.projectId },
      dryRun: false,
    })!;
    s.autopilot.start(run.id);
    s.autopilot.update(run.id, { runner: "headless", sessionId: A });
    const l = app.link(claude(A, app.home.root));
    expect(s.autopilot.runForSession(B)).toBeNull();

    await app.integrations.refreshLink(l.id);
    expect(s.links.get(l.id)).toMatchObject({ snapshot: { status: "busy", inApp: false } });

    const finished = s.autopilot.finish(run.id, {});
    await app.integrations.refreshLink(l.id);
    expect(s.links.get(l.id)).toMatchObject({ snapshot: { status: "finished", endedAt: finished.finishedAt } });
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

describe("the background poll", () => {
  /** An integration over a fake link store and run table, so the poll can be driven without the app. */
  function pollWith(
    home: ReturnType<typeof tempHome>,
    opts: { alive?: number[]; probe?: ProcessProbe; bus?: { size: number } } = {},
  ) {
    const links: TaskLink[] = [];
    const stored = new Map<string, AgentSessionSnapshot>();
    const runs = new Map<string, Pick<AutopilotRun, "status" | "finishedAt" | "updatedAt">>();
    const warnings: string[] = [];
    let listError: Error | null = null;
    const integration = createAgentSessionsIntegration({
      services: () =>
        ({
          links: {
            listByKind: () => {
              if (listError) throw listError;
              return links;
            },
            setSnapshot: (id: string, snapshot: AgentSessionSnapshot) => void stored.set(id, snapshot),
            get: (id: string) => links.find((l) => l.id === id)!,
          },
          settings: { get: () => ({}) },
          autopilot: { runForSession: (id: string) => runs.get(id) ?? null },
        }) as unknown as AgentSessionServices,
      bus: opts.bus ?? { size: 1 },
      dirs: home.dirs,
      userHome: home.root,
      probe: opts.probe ?? fakeProbe(opts.alive ?? []).probe,
      log: { warn: (m: string) => void warnings.push(m), error: () => {} } as never,
    });
    const add = (ref: AgentSessionRef) => {
      const link = { id: `link-${links.length}`, kind: "agent_session", ref } as unknown as TaskLink;
      links.push(link);
      return link;
    };
    return { integration, add, stored, runs, warnings, failListing: (e: Error | null) => (listError = e) };
  }

  it("still polls after a poll that found no session links", async () => {
    const home = tempHome();
    home.claudeFile(100, { sessionId: A, status: "busy" });
    const { integration, add, stored } = pollWith(home, { alive: [100] });
    await integration.pollLive();
    const link = add(claude(A));
    await integration.pollLive();
    expect(stored.get(link.id)?.status).toBe("busy");
  });

  it("still polls after a poll that failed", async () => {
    const home = tempHome();
    home.claudeFile(100, { sessionId: A, status: "idle" });
    const { integration, add, stored, warnings, failListing } = pollWith(home, { alive: [100] });
    const link = add(claude(A));
    failListing(new Error("database is locked"));
    await integration.pollLive();
    expect(warnings).toEqual(["[sessions] poll failed: database is locked"]);
    failListing(null);
    await integration.pollLive();
    expect(stored.get(link.id)?.status).toBe("idle");
  });

  describe("on its timer", () => {
    beforeEach(() => void vi.useFakeTimers());
    afterEach(() => void vi.useRealTimers());

    it("updates stored statuses every interval while a browser is connected", async () => {
      const home = tempHome();
      home.claudeFile(100, { sessionId: A, status: "busy" });
      const { integration, add, stored } = pollWith(home, { alive: [100] });
      const link = add(claude(A));
      integration.start();
      await vi.advanceTimersByTimeAsync(SESSION_INTERVAL_MS);
      expect(stored.get(link.id)?.status).toBe("busy");
      home.claudeFile(100, { sessionId: A, status: "idle" });
      await vi.advanceTimersByTimeAsync(SESSION_INTERVAL_MS);
      expect(stored.get(link.id)?.status).toBe("idle");
      integration.stop();
    });

    it("keeps polling when the first tick found no links", async () => {
      const home = tempHome();
      home.claudeFile(100, { sessionId: A, status: "busy" });
      const { integration, add, stored } = pollWith(home, { alive: [100] });
      integration.start();
      await vi.advanceTimersByTimeAsync(SESSION_INTERVAL_MS);
      const link = add(claude(A));
      await vi.advanceTimersByTimeAsync(SESSION_INTERVAL_MS);
      expect(stored.get(link.id)?.status).toBe("busy");
      integration.stop();
    });

    it("does nothing without a connected browser", async () => {
      const home = tempHome();
      home.claudeFile(100, { sessionId: A, status: "busy" });
      const { integration, add, stored } = pollWith(home, { alive: [100], bus: { size: 0 } });
      add(claude(A));
      integration.start();
      await vi.advanceTimersByTimeAsync(SESSION_INTERVAL_MS * 2);
      expect(stored.size).toBe(0);
      integration.stop();
    });

    it("gives up on a read that hangs, so the next poll still runs", async () => {
      const home = tempHome();
      home.claudeFile(100, { sessionId: A, status: "idle", procStart: "111" });
      let hang = true;
      const probe: ProcessProbe = {
        isAlive: () => true,
        startTimes: () => (hang ? new Promise(() => {}) : Promise.resolve(new Map([[100, "111"]]))),
      };
      const { integration, add, stored, warnings } = pollWith(home, { probe });
      const link = add(claude(A));
      integration.start();
      await vi.advanceTimersByTimeAsync(SESSION_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(SESSION_POLL_TIMEOUT_MS);
      expect(warnings.some((w) => w.includes("timed out"))).toBe(true);
      expect(stored.size).toBe(0);
      hang = false;
      await vi.advanceTimersByTimeAsync(SESSION_INTERVAL_MS);
      expect(stored.get(link.id)?.status).toBe("idle");
      integration.stop();
    });
  });

  describe("a session Autopilot ran", () => {
    const run = (status: AutopilotRun["status"], finishedAt: string | null = null) => ({
      status,
      finishedAt,
      updatedAt: "2026-10-17T10:00:00.000Z",
    });

    it("is working while its run is queued or going, without reading the harness's files", async () => {
      const home = tempHome();
      const { integration, add, stored, runs } = pollWith(home);
      const link = add(claude(A));
      for (const status of ["queued", "running"] as const) {
        runs.set(A, run(status));
        await integration.pollLive();
        expect(stored.get(link.id)).toEqual({ status: "busy", inApp: false });
        stored.clear();
      }
    });

    it("is finished or failed, with when, once its run ended", async () => {
      const home = tempHome();
      const { integration, add, stored, runs } = pollWith(home);
      const link = add(claude(A));
      runs.set(A, run("succeeded", "2026-10-17T10:05:00.000Z"));
      await integration.pollLive();
      expect(stored.get(link.id)).toEqual({ status: "finished", inApp: false, endedAt: "2026-10-17T10:05:00.000Z" });
      runs.set(A, run("failed", "2026-10-17T10:06:00.000Z"));
      await integration.pollLive();
      expect(stored.get(link.id)).toEqual({ status: "failed", inApp: false, endedAt: "2026-10-17T10:06:00.000Z" });
    });

    it("shows the live status again when someone resumes the session after it ended", async () => {
      const home = tempHome();
      home.claudeFile(100, { sessionId: A, status: "busy", entrypoint: "cli" });
      const { integration, add, stored, runs } = pollWith(home, { alive: [100] });
      const link = add(claude(A));
      runs.set(A, run("succeeded", "2026-10-17T10:05:00.000Z"));
      await integration.pollLive();
      expect(stored.get(link.id)).toEqual({ status: "busy", inApp: false });
    });

    it("refreshes just that session's link, as the run is linked and ended", async () => {
      const home = tempHome();
      const { integration, add, stored, runs } = pollWith(home);
      const mine = add(claude(A));
      const other = add(claude(B));
      runs.set(A, run("running"));
      await integration.refreshSession(A.toUpperCase());
      expect(stored.get(mine.id)?.status).toBe("busy");
      expect(stored.has(other.id)).toBe(false);
      await integration.refreshSession("00000000-0000-4000-8000-000000000000");
    });
  });
});
