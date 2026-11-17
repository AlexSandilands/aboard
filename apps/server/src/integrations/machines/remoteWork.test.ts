import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AutopilotRun } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { Runner, RunPatch } from "../../autopilot/types.ts";
import { WorktreeHeadError } from "../../autopilot/types.ts";
import type { AgentJob } from "../headlessAgent.ts";
import { defaultRunGit } from "../backup.ts";
import { createRemoteWork } from "./remoteWork.ts";
import { createBoardAndRunner } from "../../test/boardAndRunner.ts";
import { createGitFixture, git } from "../../test/gitRepo.ts";
import { PROCESS_TEST_TIMEOUT } from "../../test/timeouts.ts";

const REMOTE = "git@github.com:acme/app.git";
const result = (fields: Record<string, unknown>) => JSON.stringify({ type: "result", subtype: "success", ...fields });

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const runOf = (taskId: string, projectId: string): AutopilotRun => ({
  id: randomUUID(),
  automation: "test",
  taskId,
  projectId,
  dedupeKey: "k",
  status: "running",
  summary: "work",
  dryRun: false,
  runner: null,
  sessionId: null,
  threadUrl: null,
  worktreePath: null,
  costUsd: null,
  detail: null,
  exitCode: null,
  error: null,
  deferred: null,
  needsAttention: false,
  dismissedAt: null,
  output: null,
  model: null,
  createdAt: "2026-10-17T00:00:00.000Z",
  startedAt: "2026-10-17T00:00:00.000Z",
  finishedAt: null,
  updatedAt: "2026-10-17T00:00:00.000Z",
});

/** The board's own runner, which a held task's run must never reach. */
const HERE: Runner = { start: () => Promise.reject(new Error("ran on the board")) };

/** A paired board and runner with one real repository: the board's checkout, and the runner's clone of its origin. */
async function setup(opts: { agent?: (job: AgentJob) => string | Promise<string> } = {}) {
  const repo = createGitFixture();
  cleanups.push(() => repo.cleanup());
  const jobs: AgentJob[] = [];
  const shells: Array<{ command: string; cwd: string }> = [];
  const pair = await createBoardAndRunner({
    remotes: { [repo.checkout]: REMOTE },
    clone: (_url, dir) => {
      mkdirSync(dirname(dir), { recursive: true });
      git(repo.root, "clone", "--quiet", repo.origin, dir);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    runner: {
      runAgent: async (job) => {
        jobs.push(job);
        return opts.agent ? opts.agent(job) : result({ result: "Done", total_cost_usd: 0.5 });
      },
      runShell: (request) => {
        shells.push({ command: request.command, cwd: request.cwd });
        return Promise.resolve({ exitCode: 0, output: "ok\n", timedOut: false });
      },
      log: { warn: () => {} },
    },
  });
  cleanups.push(pair.stop);
  const { board, machine } = pair;
  board.services.settings.update({ providers: [{ id: "claude-code", enabled: true }], reviewMaxRounds: 4 });
  const project = board.services.projects.create({ title: "App", workspaceRoot: repo.checkout });
  const task = board.services.tasks.create({
    projectId: project.id,
    title: "Ship the thing",
    plan: { phases: [{ title: "Build", steps: [{ title: "Write it" }] }] },
  });
  await board.integrations.machineSync.handOver(task.id, machine.id, "user");
  const patches: RunPatch[] = [];
  const start = (request: Record<string, unknown> = {}) =>
    board.integrations.remoteWork.runner(HERE).start(
      {
        run: runOf(task.id, project.id),
        prompt: "Do the task",
        operation: "taskRun",
        options: { modelChoice: { provider: "claude-code", model: "haiku" }, timeoutMinutes: 5 },
        ...request,
      },
      (patch) => patches.push(patch),
    );
  return { ...pair, repo, project, task, jobs, shells, patches, start };
}

describe("a run for a task a machine holds", () => {
  it(
    "runs on the machine, in a worktree of its clone, and reports back what it recorded",
    async () => {
      const { board, runner, task, jobs, patches, start, sync } = await setup();
      const out = await start({ label: "Start planned" });

      expect(out).toMatchObject({ runner: "headless", costUsd: 0.5, result: "Done" });
      const session = out.sessionId;
      expect(session).toMatch(/^[0-9a-f-]{36}$/);
      expect(jobs).toHaveLength(1);
      // In the machine's worktree, under its own data dir, from its clone: nothing of the board's checkout.
      expect(existsSync(jobs[0]!.cwd)).toBe(true);
      expect(jobs[0]!.cwd).toBe(out.worktreePath);
      expect(git(jobs[0]!.cwd, "rev-parse", "HEAD")).toBe(git(jobs[0]!.cwd, "rev-parse", "origin/main"));
      expect(patches.some((p) => p.sessionId === session)).toBe(true);
      expect(patches.some((p) => p.worktreePath === out.worktreePath)).toBe(true);
      // The machine kept the run as its own while it went, and ended it quietly.
      expect(runner.services.autopilot.status().active).toEqual([]);
      expect(runner.services.tasks.detail(task.id).events.some((e) => e.type === "autopilot_run")).toBe(false);

      // The session it linked arrives through the log, naming the machine it ran on.
      await sync();
      const link = board.services.tasks.summary(task.id).links.find((l) => l.kind === "agent_session");
      expect(link).toMatchObject({ ref: { sessionId: session, machine: { name: "engine" } } });
    },
    PROCESS_TEST_TIMEOUT,
  );

  it(
    "starts from origin's copy of the branch it is given, which is all the machine has",
    async () => {
      const { repo, jobs, start } = await setup();
      // An epic's integration branch, as Start planned names it, and a base the automation chose.
      await start({ workspace: { prBase: "feature" } });
      await start({ workspace: { baseRef: "feature" } });
      const feature = git(repo.checkout, "rev-parse", "origin/feature");
      expect(jobs.map((job) => git(job.cwd, "rev-parse", "HEAD"))).toEqual([feature, feature]);
      expect(jobs[0]!.prompt).toContain("gh pr create --base feature");
    },
    PROCESS_TEST_TIMEOUT,
  );

  it(
    "says on the run which of the task's branches has commits the machine can't see",
    async () => {
      const { board, repo, task, patches, start } = await setup();
      git(repo.checkout, "checkout", "--quiet", "feature");
      git(repo.checkout, "commit", "--quiet", "--allow-empty", "-m", "not pushed");
      git(repo.checkout, "checkout", "--quiet", "main");
      const work = createRemoteWork({
        services: () => board.services,
        machines: board.integrations.machines,
        runGit: defaultRunGit,
      });
      expect(await work.unpushed(task.id, "engine", ["feature", "main"])).toBe(
        "`feature` (1 commit) has commits that aren't pushed, so engine doesn't have them: it works from what is on origin. Push the branch first.",
      );
      expect(await work.unpushed(task.id, "engine", ["main"])).toBeNull();

      const out = await work.runner(HERE).start(
        {
          run: runOf(task.id, task.projectId),
          prompt: "Fix the PR",
          operation: "taskRun",
          options: { modelChoice: { provider: "claude-code", model: "haiku" }, runner: "t3" },
          workspace: { branch: "feature" },
        },
        (patch) => patches.push(patch),
      );
      expect(patches[0]?.detail).toContain("`feature` (1 commit) has commits that aren't pushed");
      // The automation's T3-only runner doesn't stop it: a machine's runs are headless.
      expect(out.runner).toBe("headless");
      // And the note stays on top of what the run itself records as its detail (its model).
      const details = patches.flatMap((p) => (p.detail ? [p.detail] : []));
      expect(details.length).toBeGreaterThan(1);
      expect(details.every((d) => d.includes("Ran headless on engine"))).toBe(true);
      void start;
    },
    PROCESS_TEST_TIMEOUT,
  );

  it(
    "works by the board's settings, which the machine was sent",
    async () => {
      const { runner } = await setup();
      expect(runner.services.settings.get().reviewMaxRounds).toBe(4);
      expect(runner.services.settings.get().providers).toEqual([{ id: "claude-code", enabled: true, cliPath: null }]);
    },
    PROCESS_TEST_TIMEOUT,
  );

  it(
    "fails as the agent failed, and keeps the errors an automation branches on",
    async () => {
      const { start } = await setup({ agent: () => Promise.reject(new Error("claude: not logged in")) });
      await expect(start()).rejects.toThrow("claude: not logged in");
      await expect(start({ expectHead: "0000000000000000000000000000000000000000" })).rejects.toBeInstanceOf(
        WorktreeHeadError,
      );
    },
    PROCESS_TEST_TIMEOUT,
  );

  it(
    "leaves a task the board holds itself to the board's runner",
    async () => {
      const { board, project } = await setup();
      const own = board.services.tasks.create({ projectId: project.id, title: "Here" });
      const local: Runner = { start: () => Promise.resolve({ runner: "headless", result: "here" }) };
      const out = await board.integrations.remoteWork
        .runner(local)
        .start({ run: runOf(own.id, project.id), prompt: "p", operation: "taskRun", options: {} });
      expect(out.result).toBe("here");
    },
    PROCESS_TEST_TIMEOUT,
  );

  it(
    "runs a custom automation's command in the machine's checkout",
    async () => {
      const { board, runner, task, shells } = await setup();
      const ran = await board.integrations.remoteWork.shell({
        command: "pnpm test",
        cwd: "/the/boards/own/folder",
        taskId: task.id,
        env: { TASK_NUMBER: "1" },
        timeoutMs: 5_000,
      });
      expect(ran).toEqual({ exitCode: 0, output: "ok\n", timedOut: false });
      const there = runner.services.projects.get(runner.services.tasks.summary(task.id).projectId);
      expect(shells).toEqual([{ command: "pnpm test", cwd: there.workspaceRoot }]);
      // A request with no task, or for a task held here, is the board's own.
      expect(board.integrations.remoteWork.shell({ command: "x", cwd: "/a", env: {}, timeoutMs: 1 })).toBeNull();
    },
    PROCESS_TEST_TIMEOUT,
  );
});

describe("the board's settings sent to a machine", () => {
  function work() {
    const puts: Array<{ revision?: string }> = [];
    const remote = createRemoteWork({
      services: () =>
        ({
          settings: { get: () => ({ autoReview: true, reviewSkill: { source: "builtin" } }) },
          machines: { get: () => ({ name: "engine", version: "1.0.0" }) },
        }) as never,
      machines: {
        request: (_id, _path, init) => {
          puts.push(JSON.parse(init?.body as string) as { revision?: string });
          return Promise.resolve(new Response(null, { status: 204 }));
        },
        can: () => true,
      },
      runGit: defaultRunGit,
    });
    return { remote, puts };
  }

  it("go again to a machine that says it has none, or others, but not on every round", async () => {
    const { remote, puts } = work();
    await remote.syncSettings("m");
    const revision = puts[0]!.revision!;
    expect(revision).toMatch(/^[\w-]{16}$/);
    remote.observeSettings("m", revision);
    await remote.syncSettings("m");
    expect(puts).toHaveLength(1);
    // Its database replaced: it has none.
    remote.observeSettings("m", null);
    await remote.syncSettings("m");
    expect(puts).toHaveLength(2);
    // Sent, so not again before it next says what it has.
    await remote.syncSettings("m");
    expect(puts).toHaveLength(2);
    remote.observeSettings("m", "something-else");
    await remote.syncSettings("m");
    expect(puts).toHaveLength(3);
  });

  it("go to an older machine, which says nothing of them, only when they changed", async () => {
    const { remote, puts } = work();
    remote.observeSettings("m", undefined);
    await remote.syncSettings("m");
    await remote.syncSettings("m");
    expect(puts).toHaveLength(1);
  });
});
