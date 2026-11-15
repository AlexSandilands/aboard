import { afterEach, describe, expect, it } from "vitest";
import { createBoardAndRunner } from "../../test/boardAndRunner.ts";
import type { ThreadLink } from "../t3.ts";

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

const START = {
  prompt: "Do the work",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [] },
  runtimeMode: "full-access",
  workspace: { mode: "current" },
} as const;

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
