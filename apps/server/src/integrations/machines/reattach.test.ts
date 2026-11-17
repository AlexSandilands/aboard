import { AUTOPILOT_REVIEW_PRS, AUTOPILOT_START_PLANNED, type AutopilotRun } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createBoardAndRunner } from "../../test/boardAndRunner.ts";
import type { JobUpdate } from "./jobs.ts";
import { createReattacher } from "./reattach.ts";
import { createRemoteWork, type JobEnding } from "./remoteWork.ts";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/** A board with a task a machine holds, in Planned on both. */
async function setup() {
  const pair = await createBoardAndRunner();
  stops.push(pair.stop);
  const { board, runner, machine, sync } = pair;
  const project = board.services.projects.create({ title: "App", workspaceRoot: "/work/app" });
  const task = board.services.tasks.create({
    projectId: project.id,
    title: "Ship the thing",
    plan: { phases: [{ title: "Build", steps: [{ title: "Write it" }] }] },
  });
  await board.integrations.machineSync.handOver(task.id, machine.id, "user");
  runner.services.tasks.move(task.id, { status: "planned" }, "user");
  await sync();

  /** A run of the board's that was going on the machine when the board stopped. */
  const going = (automation = AUTOPILOT_START_PLANNED, key = `start:${task.id}`): AutopilotRun => {
    const run = board.services.autopilot.record({
      automation,
      candidate: { dedupeKey: key, summary: `start ${task.title}`, taskId: task.id, projectId: project.id },
      dryRun: false,
    })!;
    return board.services.autopilot.start(run.id);
  };
  /** The machine's record of a run the board sent it (`adopt`), as its job keeps it. */
  const adopted = (run: AutopilotRun) =>
    runner.services.autopilot.adopt(run, runner.services.tasks.summary(task.id).projectId);
  /** A job for the run, still going in the machine's memory, that the test ends. */
  const job = async (run: AutopilotRun) => {
    let end!: (result: unknown) => void;
    let fail!: (error: Error) => void;
    let update!: JobUpdate;
    runner.integrations.runnerHost.jobs.start(
      { id: run.id, kind: "run", taskId: task.id, params: {} },
      (_request, report) => {
        update = report;
        return new Promise((resolve, reject) => {
          end = resolve;
          fail = reject;
        });
      },
    );
    // The machine starts the work once it has answered.
    await Promise.resolve();
    await Promise.resolve();
    return {
      end: (result: unknown) => end(result),
      fail: (error: Error) => fail(error),
      update: (patch: Record<string, unknown>) => update(patch),
    };
  };
  /** The board starting again: `recover`, then re-attaching to what it left running on the machine. */
  const restart = () => {
    const recovered = board.services.autopilot.recover();
    return { recovered, done: board.integrations.reattach(recovered.reattach) };
  };
  const runOf = (id: string) => board.services.autopilot.runsForTask(task.id, 50).find((r) => r.id === id)!;
  return { ...pair, project, task, going, adopted, job, restart, runOf };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("a board restart while a machine works on a run", () => {
  it("leaves the run going, saying so, and still fails one the board ran itself", async () => {
    const { board, project, task, going, restart, runOf } = await setup();
    const there = going();
    const queued = board.services.autopilot.record({
      automation: AUTOPILOT_START_PLANNED,
      candidate: { dedupeKey: "never-sent", summary: "start", taskId: task.id, projectId: project.id },
      dryRun: false,
    })!;
    const own = board.services.tasks.create({ projectId: project.id, title: "Here" });
    const local = board.services.autopilot.record({
      automation: AUTOPILOT_START_PLANNED,
      candidate: { dedupeKey: "local", summary: "start", taskId: own.id, projectId: project.id },
      dryRun: false,
    })!;
    board.services.autopilot.start(local.id);

    const { recovered } = restart();
    expect(recovered.ended).toBe(2);
    expect(recovered.reattach.map((r) => r.run.id)).toEqual([there.id]);
    expect(runOf(there.id)).toMatchObject({
      status: "running",
      detail: "Re-attaching to engine after a board restart",
      needsAttention: false,
    });
    // Never sent, so nothing is going on the machine: failed and flagged as before.
    expect(runOf(queued.id)).toMatchObject({ status: "failed", needsAttention: true });
    expect(board.services.autopilot.runsForTask(own.id)[0]).toMatchObject({ status: "failed", needsAttention: true });
  });

  it("reads a job still going to its end, with everything it recorded, and judges it once the log is read", async () => {
    const { board, runner, net, task, going, job, restart, runOf } = await setup();
    const run = going();
    const work = await job(run);
    work.update({ sessionId: "11111111-1111-4111-8111-111111111111", runner: "headless" });

    const { done } = restart();
    await tick();
    // The agent moves the task on the machine and ends; the board learns of the move only through the log.
    runner.services.tasks.move(task.id, { status: "in_progress" }, "claude");
    work.end({ runner: "headless", costUsd: 0.7, result: "Done", detail: "Model: haiku" });
    await done;

    expect(runOf(run.id)).toMatchObject({
      status: "succeeded",
      summary: "Started #1 headless",
      sessionId: "11111111-1111-4111-8111-111111111111",
      costUsd: 0.7,
      needsAttention: false,
    });
    expect(board.services.tasks.summary(task.id).status).toBe("in_progress");
    // Only read, never started again; and once read, the machine may forget it.
    expect(net.sent.filter((r) => r.path === "/machine/jobs" && r.method === "POST")).toEqual([]);
    expect(net.sent.some((r) => r.path === `/machine/jobs/${run.id}` && r.method === "DELETE")).toBe(true);
  });

  it("fails Start planned, flagged, when its agent ended without moving the task", async () => {
    const { job, going, restart, runOf } = await setup();
    const run = going();
    (await job(run)).end({ runner: "headless", costUsd: 0.2, result: "Gave up" });
    await restart().done;
    expect(runOf(run.id)).toMatchObject({
      status: "failed",
      needsAttention: true,
      costUsd: 0.2,
      error: expect.stringContaining("the agent didn't move #1 out of Planned"),
    });
  });

  it("fails and flags a run whose job failed", async () => {
    const { job, going, restart, runOf } = await setup();
    const run = going();
    (await job(run)).fail(new Error("claude: not logged in"));
    await tick();
    await restart().done;
    expect(runOf(run.id)).toMatchObject({ status: "failed", needsAttention: true, error: "claude: not logged in" });
  });

  it("records a run of an automation that acts on its answer, and flags it: the answer wasn't acted on", async () => {
    const { job, going, restart, runOf } = await setup();
    const run = going(AUTOPILOT_REVIEW_PRS, "review:pr:abc");
    (await job(run)).end({ runner: "headless", costUsd: 0.3, result: "Looks fine" });
    await restart().done;
    expect(runOf(run.id)).toMatchObject({
      status: "failed",
      needsAttention: true,
      costUsd: 0.3,
      error: expect.stringMatching(/^The board restarted while this run was going\. It finished on engine/),
    });
  });

  it("re-attaches again after a second restart while it was re-attaching", async () => {
    const { runner, task, going, job, restart, runOf } = await setup();
    const run = going();
    const work = await job(run);
    void restart().done;
    await tick();
    // The board stops again before the job ends: the run is still going, and is re-attached to again.
    const again = restart();
    expect(again.recovered.reattach.map((r) => r.run.id)).toEqual([run.id]);
    runner.services.tasks.move(task.id, { status: "in_progress" }, "claude");
    work.end({ runner: "headless", result: "Done" });
    await again.done;
    expect(runOf(run.id)).toMatchObject({ status: "succeeded" });
  });
});

describe("a job the machine no longer has in memory", () => {
  it("is answered from the machine's record of a run that finished", async () => {
    const { runner, task, going, adopted, restart, runOf } = await setup();
    const run = going();
    adopted(run);
    runner.services.tasks.move(task.id, { status: "in_progress" }, "claude");
    runner.services.autopilot.settle(run.id, "succeeded", { costUsd: 0.4, runner: "headless", detail: "Model: haiku" });
    await restart().done;
    expect(runOf(run.id)).toMatchObject({ status: "succeeded", costUsd: 0.4, detail: "Model: haiku" });
  });

  it("is cut short when the machine's own restart failed it", async () => {
    const { runner, going, adopted, restart, runOf } = await setup();
    const run = going();
    adopted(run);
    runner.services.autopilot.recover();
    await restart().done;
    expect(runOf(run.id)).toMatchObject({
      status: "failed",
      needsAttention: true,
      error: "engine restarted while this run was going, so it was cut short",
    });
  });

  it("never started when the machine has no record of it: retired without a flag, so it is tried again", async () => {
    const { board, task, going, restart, runOf } = await setup();
    const run = going();
    await restart().done;
    expect(runOf(run.id)).toMatchObject({
      status: "failed",
      needsAttention: false,
      dedupeKey: `retried:${run.id}:start:${task.id}`,
      error: "The board restarted before this run reached the machine",
    });
    expect(board.services.tasks.summary(task.id).attention.map((a) => a.kind)).not.toContain("autopilot");

    // The same work cut short so a second time: flagged, so a run that restarts the board can't loop.
    const second = going();
    await restart().done;
    expect(runOf(second.id)).toMatchObject({ status: "failed", needsAttention: true, dedupeKey: `start:${task.id}` });
  });
});

describe("re-attaching, by how the job ended", () => {
  /** The reattacher on its own, given what reading the job came to. */
  async function ending(result: JobEnding) {
    const { board, machine, going, runOf } = await setup();
    const run = going();
    const forgot: string[] = [];
    const reattacher = createReattacher({
      services: () => board.services,
      work: { reattach: () => Promise.resolve(result), forgetJob: (_m, id) => forgot.push(id) },
      pump: () => Promise.resolve({ more: false, error: null }),
      log: { warn: () => {} },
    });
    await reattacher.reattach(run, machine.id);
    return { run: runOf(run.id), forgot };
  }

  it("fails and flags what an older machine can't say (a plain unknown), as before", async () => {
    const { run, forgot } = await ending({ kind: "unknown" });
    expect(run).toMatchObject({ status: "failed", needsAttention: true });
    expect(run.error).toContain("It ran on engine, where its agent may still be working");
    expect(forgot).toEqual([]);
  });

  it("fails and flags a machine that couldn't be reached", async () => {
    const { run } = await ending({ kind: "unreachable", error: "engine couldn't be reached" });
    expect(run).toMatchObject({ status: "failed", needsAttention: true });
    expect(run.error).toBe("The board restarted while this run was going, and engine couldn't be reached");
  });
});

describe("reading a job again", () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  function work(answers: Array<() => Response>, clock = { now: 0 }) {
    const asked: string[] = [];
    const remote = createRemoteWork({
      services: () => ({ machines: { get: () => ({ name: "engine" }) } }) as never,
      machines: {
        request: (_id, path, init) => {
          asked.push(`${init?.method ?? "GET"} ${path}`);
          const next = answers.shift();
          if (!next) return Promise.reject(new TypeError("fetch failed"));
          return Promise.resolve(next());
        },
        can: () => true,
      },
      runGit: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
      now: () => clock.now,
      sleep: (ms) => {
        clock.now += ms;
        return Promise.resolve();
      },
      log: { warn: () => {} },
    });
    return { remote, asked, clock };
  }

  it("follows a running job to its end, handing on every update once, with GETs only", async () => {
    const { remote, asked } = work([
      () => json({ id: "r", state: "running", updates: [{ seq: 1, patch: { sessionId: "s" } }] }),
      () =>
        json({
          id: "r",
          state: "done",
          updates: [{ seq: 2, patch: { costUsd: 1 } }],
          result: { runner: "headless", result: "ok" },
        }),
    ]);
    const patches: unknown[] = [];
    const ended = await remote.reattach("m", "r", (p) => patches.push(p));
    expect(ended).toEqual({ kind: "done", result: { runner: "headless", result: "ok" } });
    expect(patches).toEqual([{ sessionId: "s" }, { costUsd: 1 }]);
    expect(asked).toEqual(["GET /machine/jobs/r?after=0", "GET /machine/jobs/r?after=1&wait=8000"]);
  });

  it("answers a job that already ended, failed, or that the machine never got", async () => {
    expect(
      await work([() => json({ id: "r", state: "done", updates: [] })]).remote.reattach("m", "r", () => {}),
    ).toEqual({ kind: "done", result: { result: null } });
    expect(
      await work([() => json({ id: "r", state: "failed", updates: [], error: { message: "boom" } })]).remote.reattach(
        "m",
        "r",
        () => {},
      ),
    ).toEqual({ kind: "failed", error: "boom" });
    expect(
      await work([() => json({ id: "r", state: "unknown", updates: [], started: false })]).remote.reattach(
        "m",
        "r",
        () => {},
      ),
    ).toEqual({ kind: "never_started" });
    expect(
      await work([() => json({ id: "r", state: "unknown", updates: [] })]).remote.reattach("m", "r", () => {}),
    ).toEqual({
      kind: "unknown",
    });
  });

  it("keeps asking a machine that can't be reached until the grace period from the board's start is out", async () => {
    const { remote, asked, clock } = work([]);
    const ended = await remote.reattach("m", "r", () => {});
    expect(ended).toMatchObject({ kind: "unreachable", error: expect.stringContaining("engine couldn't be reached") });
    expect(asked.length).toBeGreaterThan(5);
    expect(asked.every((a) => a.startsWith("GET "))).toBe(true);
    expect(clock.now).toBeLessThanOrEqual(15 * 60_000);
    expect(clock.now).toBeGreaterThan(14 * 60_000);
  });
});
