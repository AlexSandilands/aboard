import type { StartSessionResult, StartT3ThreadInput } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createBoardAndRunner } from "../../test/boardAndRunner.ts";
import type { ThreadLink } from "../t3.ts";
import type { LaunchSpec } from "../terminal.ts";
import type { SpawnSsh } from "./ssh.ts";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

async function setup() {
  const pair = await createBoardAndRunner({ remotes: { "/work/app": "git@github.com:acme/app.git" } });
  stops.push(pair.stop);
  const { board, machine } = pair;
  const project = board.services.projects.create({ title: "App", workspaceRoot: "/work/app" });
  const task = board.services.tasks.create({
    projectId: project.id,
    title: "Ship the thing",
    plan: { phases: [{ title: "Build", steps: [{ title: "Write it" }] }] },
  });
  await board.integrations.machineSync.handOver(task.id, machine.id, "user");
  const engine = { id: pair.runner.instanceId, name: "engine" };
  return { ...pair, project, task, engine };
}

const START: StartT3ThreadInput = {
  prompt: "Do the work",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [] },
  runtimeMode: "full-access",
  workspace: { mode: "current" },
};

describe("T3 Code threads of a task a machine holds", () => {
  it("are started in the machine's own T3 Code, which says why it can't", async () => {
    const { board, task, net } = await setup();
    await expect(board.integrations.startT3Thread(task.id, START, "user")).rejects.toThrow(
      "On engine: T3 Code is not running",
    );
    expect(net.sent.some((r) => r.path === "/machine/t3")).toBe(true);
  });

  it("are linked with the machine, polled there and messaged through it", async () => {
    const { board, runner, task, engine, sync } = await setup();
    // What the machine's T3 integration does once a thread has started.
    runner.services.links.add(
      task.id,
      { t3Thread: { environmentId: "env-engine", threadId: "thread-1", machine: engine } },
      "user",
    );
    runner.services.links.setSnapshot(runner.services.links.listByKind("t3_thread")[0]!.id, {
      title: "Ship the thing",
      status: "working",
    });
    await sync();

    const link = board.services.tasks.detail(task.id).links.find((l) => l.kind === "t3_thread") as ThreadLink;
    expect(link.ref).toEqual({ environmentId: "env-engine", threadId: "thread-1", machine: engine });
    expect(link.snapshot).toMatchObject({ status: "working" });
    // The board neither refuses nor reads a thread in another machine's T3 Code.
    await expect(board.integrations.refreshLink(link.id)).resolves.toBeUndefined();
    await expect(board.integrations.messageT3Thread(link, "Carry on")).rejects.toThrow(
      "On engine: T3 Code is not running",
    );
  });

  it("linked by an agent on the machine name the machine", async () => {
    const { runner, engine } = await setup();
    const { input } = await runner.integrations.resolveLinkInput({
      t3Thread: { environmentId: "env-engine", threadId: "thread-2" },
    });
    expect(input.t3Thread).toEqual({ environmentId: "env-engine", threadId: "thread-2", machine: engine });
  });

  it("aren't sent anywhere for a task the board holds", async () => {
    const { board, project } = await setup();
    const own = board.services.tasks.create({
      projectId: project.id,
      title: "Mine",
      plan: { phases: [{ title: "Build", steps: [{ title: "Write it" }] }] },
    });
    expect(board.integrations.remoteWork.t3(own.id, { op: "options", taskId: own.id })).toBeNull();
  });
});

describe("CLI sessions of a task a machine holds", () => {
  it("get their folder and link from the machine, which the board sees with the machine named", async () => {
    const { board, runner, task, engine, sync } = await setup();
    const sessionId = "0b9b8f9e-2a43-4c55-9d3a-6f2c1e7d8a90";
    const prepared = await board.integrations.remoteWork.prepareSession(task.id, {
      taskId: task.id,
      harness: "claude-code",
      sessionId,
      label: "Implementing #1",
      workspace: { mode: "current" },
      actor: "user",
    });
    const root = runner.services.projects.get(runner.services.tasks.summary(task.id).projectId).workspaceRoot;
    expect(prepared).toMatchObject({ cwd: root, branch: null, machine: { name: "engine" } });

    await sync();
    const link = board.services.tasks.detail(task.id).links.find((l) => l.kind === "agent_session");
    expect(link).toMatchObject({ id: prepared!.linkId, label: "Implementing #1" });
    expect(link?.kind === "agent_session" && link.ref).toEqual({
      harness: "claude-code",
      sessionId,
      cwd: root,
      machine: engine,
    });
  });

  it("are refused by the machine for a task it doesn't hold", async () => {
    const { board, runner, task } = await setup();
    await board.integrations.machineSync.release(task.id, {}, "user");
    const request = {
      taskId: task.id,
      harness: "claude-code",
      sessionId: null,
      label: "Implementing #1",
      workspace: { mode: "current" },
      actor: "user",
    } as const;
    expect(board.integrations.remoteWork.prepareSession(task.id, request)).toBeNull();
    await expect(runner.integrations.runnerHost.interactive.session(request)).rejects.toThrow(
      "isn't held by this machine",
    );
  });
});

describe("terminals for sessions on a machine", () => {
  async function withTerminal(sshOut: string) {
    const spawned: LaunchSpec[] = [];
    const sshCalls: string[][] = [];
    const spawn: SpawnSsh = (args) => {
      sshCalls.push(args);
      return {
        onStdout: (listener) => queueMicrotask(() => listener(sshOut)),
        onStderr: () => {},
        exit: new Promise((resolve) => setTimeout(() => resolve({ code: 0 }), 0)),
        kill: () => {},
      };
    };
    const pair = await createBoardAndRunner({
      remotes: { "/work/app": "git@github.com:acme/app.git" },
      board: {
        machines: { spawn },
        terminalHost: () => ({ platform: "linux", env: {}, readFile: () => null, which: () => "/usr/bin/xterm" }),
        spawnTerminal: (spec) => {
          spawned.push(spec);
          return Promise.resolve();
        },
      },
    });
    stops.push(pair.stop);
    const { board, machine } = pair;
    const project = board.services.projects.create({ title: "App", workspaceRoot: "/work/app" });
    const task = board.services.tasks.create({
      projectId: project.id,
      title: "Ship the thing",
      plan: { phases: [{ title: "Build", steps: [{ title: "Write it" }] }] },
    });
    await board.integrations.machineSync.handOver(task.id, machine.id, "user");
    return { ...pair, task, spawned, sshCalls };
  }

  it("start a new session over ssh in tmux, linked on the machine", async () => {
    const { board, task, spawned, sshCalls, sync } = await withTerminal("checked\n");
    const options = await board.request(`/api/tasks/${task.id}/session-launch-options`);
    expect(await options.json()).toMatchObject({ machine: { name: "engine" }, taskBranches: [] });
    const res = await board.request(`/api/tasks/${task.id}/sessions`, {
      method: "POST",
      json: { harness: "claude-code", mode: "work", prompt: "Go", model: null, workspace: { mode: "current" } },
    });
    const body = (await res.json()) as StartSessionResult;
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ launched: true, error: null });
    expect(sshCalls).toHaveLength(1);
    const run = JSON.stringify(spawned[0]);
    expect(run).toContain("ssh");
    expect(run).toContain("tmux new-session -A");
    expect(body.command).toContain("100.101.102.103");

    await sync();
    const link = board.services.tasks.detail(task.id).links.find((l) => l.kind === "agent_session");
    expect(link).toMatchObject({ id: body.linkId, label: `Implementing #${task.number}` });
    expect(link?.kind === "agent_session" && link.ref.machine?.name).toBe("engine");
  });

  it("open a running session by attaching to its tmux session, and ask about one outside tmux", async () => {
    const { board, runner, task, spawned, sync, engine } = await (async () => {
      const t = await withTerminal("open\nchecked\n");
      return { ...t, engine: { id: t.runner.instanceId, name: "engine" } };
    })();
    const sessionId = "0b9b8f9e-2a43-4c55-9d3a-6f2c1e7d8a90";
    const added = runner.services.links.add(
      task.id,
      { agentSession: { harness: "claude-code", sessionId, cwd: "/data/worktrees/app/1-abcd", machine: engine } },
      "autopilot",
    );
    runner.services.links.setSnapshot(added.id, { status: "busy", inApp: false });
    await sync();

    const resume = (force = false) =>
      board.request(`/api/links/${added.id}/resume`, { method: "POST", json: { mode: "resume", force } });
    const res = await resume();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ launched: true });
    expect(JSON.stringify(spawned.at(-1))).toContain("--resume");

    const command = await board.request(`/api/links/${added.id}/resume-command?mode=fork`);
    expect(((await command.json()) as { command: string }).command).toContain("--fork-session");
  });

  it("record the tmux session of a session that links itself, so it is found again", async () => {
    const { board, runner, task, spawned, sync } = await withTerminal("checked\n");
    const res = await board.request(`/api/tasks/${task.id}/sessions`, {
      method: "POST",
      json: { harness: "codex", mode: "work", prompt: "Go", model: null, workspace: { mode: "current" } },
    });
    const body = (await res.json()) as StartSessionResult;
    expect(body).toMatchObject({ launched: true, linkId: null });
    const tmux = /new-session -A -s ([\w-]+)/.exec(JSON.stringify(spawned[0]))![1]!;
    // What the runner's link tool asks when the Codex session links itself from that folder.
    expect(runner.integrations.runnerHost.interactive.tmuxFor("codex", body.cwd)).toBe(tmux);
    expect(runner.integrations.runnerHost.interactive.tmuxFor("codex", body.cwd)).toBeNull();

    const linked = runner.services.links.add(
      task.id,
      {
        agentSession: {
          harness: "codex",
          sessionId: "1c2d3e4f-2a43-4c55-9d3a-6f2c1e7d8a90",
          cwd: body.cwd,
          machine: { id: runner.instanceId, name: "engine" },
          tmux,
        },
      },
      "codex",
    );
    await sync();
    const command = await board.request(`/api/links/${linked.id}/resume-command?mode=resume`);
    expect(((await command.json()) as { command: string }).command).toContain(`new-session -A -s ${tmux}`);
  });

  it("start with the short prompt when the full one is too long for tmux there", async () => {
    const { board, task, spawned } = await withTerminal("checked\n");
    const res = await board.request(`/api/tasks/${task.id}/sessions`, {
      method: "POST",
      json: {
        harness: "claude-code",
        mode: "work",
        prompt: "Do this. ".repeat(2500),
        model: null,
        workspace: { mode: "current" },
      },
    });
    const body = (await res.json()) as StartSessionResult;
    expect(body).toMatchObject({ launched: true, shortReason: "The prompt is too long for tmux on the machine." });
    expect(JSON.stringify(spawned[0]).length).toBeLessThan(16_000);
  });

  it("ask before opening a session that runs outside tmux, as one here", async () => {
    const t = await withTerminal("checked\n");
    const added = t.runner.services.links.add(
      t.task.id,
      {
        agentSession: {
          harness: "claude-code",
          sessionId: "0b9b8f9e-2a43-4c55-9d3a-6f2c1e7d8a90",
          cwd: "/data/worktrees/app/1-abcd",
          machine: { id: t.runner.instanceId, name: "engine" },
        },
      },
      "autopilot",
    );
    t.runner.services.links.setSnapshot(added.id, { status: "busy", inApp: false });
    await t.sync();
    const res = await t.board.request(`/api/links/${added.id}/resume`, { method: "POST", json: { mode: "resume" } });
    expect(res.status).toBe(409);
    expect(t.spawned).toEqual([]);
  });
});
