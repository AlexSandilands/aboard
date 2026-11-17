import type { StartSessionResult, StartT3ThreadInput, T3IntegrationStatus } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createBoardAndRunner } from "../../test/boardAndRunner.ts";
import type { ThreadLink } from "../t3.ts";
import type { LaunchSpec } from "../terminal.ts";
import { tmuxSessionName } from "../remoteTerminal.ts";
import { machineT3Status } from "./runnerInteractive.ts";
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

  it("take the dialog's pasted images to the machine as the task's before the start", async () => {
    const { board, runner, task, net } = await setup();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    // Pasted into the dialog: nobody's yet, until a launch claims it.
    const image = board.services.attachments.upload({
      taskId: null,
      filename: "bug.png",
      mime: "image/png",
      bytes: png,
    });
    await expect(
      board.integrations.startT3Thread(task.id, { ...START, attachmentIds: [image.id] }, "user"),
    ).rejects.toThrow("On engine: T3 Code is not running");
    const sent = net.sent.map((r) => r.path);
    expect(sent.indexOf(`/machine/attachments/${image.id}`)).toBeLessThan(sent.indexOf("/machine/t3"));
    expect(runner.services.attachments.forTask(task.id)).toMatchObject([{ id: image.id, filename: "bug.png" }]);
    // The start failed: the image stays the dialog's here, to try again with.
    expect(board.services.attachments.forTask(task.id)).toEqual([]);
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

  it("fork into a session id the board picks, and name the fork's tmux session from it", async () => {
    const { board, runner, task, spawned, sync } = await withTerminal("checked\n");
    const added = runner.services.links.add(
      task.id,
      {
        agentSession: {
          harness: "claude-code",
          sessionId: "0b9b8f9e-2a43-4c55-9d3a-6f2c1e7d8a90",
          cwd: "/data/worktrees/app/1-abcd",
          machine: { id: runner.instanceId, name: "engine" },
        },
      },
      "autopilot",
    );
    await sync();
    const res = await board.request(`/api/links/${added.id}/resume`, { method: "POST", json: { mode: "fork" } });
    expect(await res.json()).toMatchObject({ launched: true });
    const run = JSON.stringify(spawned.at(-1));
    const forkId = /--session-id[^0-9a-f]+([0-9a-f-]{36})/.exec(run)![1]!;
    expect(run).toContain("--fork-session");
    // The name opening the fork's own link falls back to, once the fork links itself under that id.
    expect(run).toContain(`new-session -A -s ${tmuxSessionName(forkId)}`);
  });

  it("send a launch token only to a machine that takes one, and keep today's guess with one that doesn't", async () => {
    const { board, runner, task, spawned, net, link } = await withTerminal("checked\n");
    net.rewrite = async (path, res) => {
      if (path !== "/machine/descriptor") return res;
      const descriptor = (await res.json()) as { capabilities: string[] };
      return Response.json({
        ...descriptor,
        capabilities: descriptor.capabilities.filter((c) => c !== "launchTokens"),
      });
    };
    await link(true);
    const res = await board.request(`/api/tasks/${task.id}/sessions`, {
      method: "POST",
      json: { harness: "codex", mode: "work", prompt: "Go", model: null, workspace: { mode: "current" } },
    });
    const body = (await res.json()) as StartSessionResult;
    expect(res.status).toBe(201);
    const run = JSON.stringify(spawned.at(-1));
    expect(run).not.toContain("launch:");
    // The machine was sent no token either: the session's link finds its terminal by the CLI and the folder.
    const tmux = /new-session -A -s ([\w-]+)/.exec(run)![1]!;
    const session = { taskId: task.id, harness: "codex" as const, sessionId: "1c2d3e4f-2a43-4c55-9d3a-6f2c1e7d8a90" };
    expect(runner.integrations.runnerHost.interactive.terminalFor({ ...session, cwd: body.cwd })).toBe(tmux);
  });

  it("name the board's machine when they can't open there, so the web can offer a T3 Code thread", async () => {
    const { board, runner, task, machine, sync } = await withTerminal("no-tmux\nchecked\n");
    const res = await board.request(`/api/tasks/${task.id}/sessions`, {
      method: "POST",
      json: { harness: "claude-code", mode: "work", prompt: "Go", model: null, workspace: { mode: "current" } },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { details: { t3: "offer", machineId: machine.id } } });

    const added = runner.services.links.add(
      task.id,
      {
        agentSession: {
          harness: "claude-code",
          sessionId: "0b9b8f9e-2a43-4c55-9d3a-6f2c1e7d8a90",
          cwd: "/data/worktrees/app/1-abcd",
          machine: { id: runner.instanceId, name: "engine" },
        },
      },
      "autopilot",
    );
    await sync();
    const resume = await board.request(`/api/links/${added.id}/resume`, { method: "POST", json: { mode: "resume" } });
    expect(await resume.json()).toMatchObject({ error: { details: { t3: "offer", machineId: machine.id } } });
  });

  it("record the tmux session of a session that links itself, so it is found again", async () => {
    const { board, runner, task, spawned, sync } = await withTerminal("checked\n");
    const res = await board.request(`/api/tasks/${task.id}/sessions`, {
      method: "POST",
      json: { harness: "codex", mode: "work", prompt: "Go", model: null, workspace: { mode: "current" } },
    });
    const body = (await res.json()) as StartSessionResult;
    expect(body).toMatchObject({ launched: true, linkId: null });
    const run = JSON.stringify(spawned[0]);
    const tmux = /new-session -A -s ([\w-]+)/.exec(run)![1]!;
    // The prompt carries a token for the session's link call, which the machine finds its terminal by, once.
    const launch = /launch: \\*"([a-f0-9]{18})/.exec(run)![1]!;
    const session = {
      taskId: task.id,
      harness: "codex" as const,
      sessionId: "1c2d3e4f-2a43-4c55-9d3a-6f2c1e7d8a90",
      cwd: body.cwd,
      launch,
    };
    expect(runner.integrations.runnerHost.interactive.terminalFor(session)).toBe(tmux);
    expect(runner.integrations.runnerHost.interactive.terminalFor(session)).toBeNull();

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

describe("a machine's T3 Code as its status reports it", () => {
  const live = (over: Partial<T3IntegrationStatus> = {}): T3IntegrationStatus => ({
    detected: true,
    origin: "http://127.0.0.1:3773",
    environmentId: "env",
    label: null,
    liveStatus: "ok",
    error: null,
    ...over,
  });

  it("says what is missing before what the token allows", () => {
    expect(machineT3Status(live({ detected: false }), true, "operate").state).toBe("not-running");
    expect(machineT3Status(live(), false, null).state).toBe("not-connected");
    expect(machineT3Status(live({ liveStatus: "error", error: "Token expired or revoked" }), true, "operate")).toEqual({
      state: "error",
      detail: "Token expired or revoked",
    });
  });

  it("is read-only only when the connection was made from a read-only link", () => {
    expect(machineT3Status(live(), true, "read-only").state).toBe("read-only");
    expect(machineT3Status(live(), true, "operate")).toEqual({ state: "connected", detail: null });
    // A token pasted as it is, or one not polled yet, counts as able to start threads until T3 says otherwise.
    expect(machineT3Status(live(), true, null).state).toBe("connected");
    expect(machineT3Status(live({ liveStatus: "off" }), true, null).state).toBe("connected");
  });
});

describe("connecting a machine's T3 Code from the board", () => {
  const connect = (board: Awaited<ReturnType<typeof setup>>["board"], machineId: string, value: string) =>
    board.request(`/api/machines/${machineId}/t3/connect`, { method: "POST", json: { value } });

  it("passes the token straight to the machine and answers its status, read again, without the token", async () => {
    const { board, runner, machine, net } = await setup();
    expect(board.integrations.machines.list().machines[0]!.t3).toEqual({ state: "not-running", detail: null });
    net.sent.length = 0;
    const res = await connect(board, machine.id, "cli-token");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("cli-token");
    expect(JSON.parse(text)).toMatchObject({
      machine: { id: machine.id, t3: { state: "not-running" } },
      warning: null,
    });
    expect(runner.services.settings.t3Token()).toBe("cli-token");
    // The board's own connection is untouched, and the machine's status was read again at once.
    expect(board.services.settings.t3Token()).toBeNull();
    const paths = net.sent.map((r) => r.path);
    expect(paths.indexOf("/machine/status")).toBeGreaterThan(paths.indexOf("/machine/t3/connect"));
  });

  it("says the machine's own refusal", async () => {
    const { board, machine } = await setup();
    const res = await connect(board, machine.id, "t3code://app/pair#token=ABCDABCDABCD");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("On engine: T3 Code is not running");
  });

  it("asks for an update first on a runner from before it, and sends it nothing", async () => {
    const { board, machine, net, link } = await setup();
    net.rewrite = async (path, res) => {
      if (path !== "/machine/descriptor") return res;
      const descriptor = (await res.json()) as { capabilities: string[] };
      return Response.json({ ...descriptor, capabilities: descriptor.capabilities.filter((c) => c !== "t3Connect") });
    };
    await link(true);
    net.sent.length = 0;
    const res = await connect(board, machine.id, "cli-token");
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(
      "engine runs a version that can't connect its T3 Code from here; update it first",
    );
    expect(net.sent.some((r) => r.path === "/machine/t3/connect")).toBe(false);
  });
});
