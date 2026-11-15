import { describe, expect, it } from "vitest";
import { WorktreeHeadError } from "../../autopilot/types.ts";
import { createMachineJobs, jobError, reviveJobError, type JobHandler } from "./jobs.ts";

const request = (id: string, kind = "run") => ({ id, kind, taskId: "task-1", params: {} });

/** A job that goes on until the test ends it. */
function held() {
  let finish!: (value: unknown) => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<unknown>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const updates: Array<(patch: Record<string, unknown>) => void> = [];
  const handler: JobHandler = (_request, update) => {
    updates.push(update);
    return done;
  };
  return { handler, finish, fail, update: (patch: Record<string, unknown>) => updates[0]!(patch) };
}

describe("a runner's jobs", () => {
  it("starts a job once, however often its request arrives", async () => {
    const jobs = createMachineJobs();
    let started = 0;
    const job = held();
    const handler: JobHandler = (r, update) => {
      started += 1;
      return job.handler(r, update);
    };
    expect(jobs.start(request("a"), handler)).toMatchObject({ id: "a", state: "running", updates: [] });
    // The answer was lost and the board asked again.
    expect(jobs.start(request("a"), handler).state).toBe("running");
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(1);
    job.finish({ result: "Done" });
    expect(await jobs.read("a", 0, 1_000)).toMatchObject({ state: "done", result: { result: "Done" } });
  });

  it("hands each update over once, and holds a read open until there is something new", async () => {
    const jobs = createMachineJobs();
    const job = held();
    jobs.start(request("a"), job.handler);
    await Promise.resolve();
    await Promise.resolve();
    job.update({ sessionId: "s-1" });
    job.update({ worktreePath: "/w" });
    expect((await jobs.read("a", 0, 0)).updates.map((u) => u.seq)).toEqual([1, 2]);
    expect((await jobs.read("a", 1, 0)).updates).toEqual([{ seq: 2, patch: { worktreePath: "/w" } }]);

    // Nothing after 2 yet: the read waits, and answers the moment the job says more.
    const waiting = jobs.read("a", 2, 5_000);
    job.update({ detail: "Model: haiku" });
    expect((await waiting).updates).toEqual([{ seq: 3, patch: { detail: "Model: haiku" } }]);
    // And comes back empty when the wait runs out.
    expect(await jobs.read("a", 3, 5)).toMatchObject({ state: "running", updates: [] });
  });

  it("says why a job failed, and doesn't know a job it never had", async () => {
    const jobs = createMachineJobs();
    const job = held();
    jobs.start(request("a"), job.handler);
    job.fail(new Error("claude: not logged in"));
    expect(await jobs.read("a", 0, 1_000)).toMatchObject({
      state: "failed",
      error: { message: "claude: not logged in", name: "Error" },
    });
    // A runner that restarted has none of its jobs.
    expect(await jobs.read("gone", 0, 1_000)).toEqual({ id: "gone", state: "unknown", updates: [] });
  });

  it("keeps a running job when told to forget it, and drops a finished one then or after six hours", async () => {
    let now = 0;
    const jobs = createMachineJobs({ now: () => now });
    const going = held();
    jobs.start(request("going"), going.handler);
    jobs.start(request("ended"), () => Promise.resolve("ok"));
    jobs.start(request("old"), () => Promise.resolve("ok"));
    await jobs.read("ended", 0, 1_000);
    await jobs.read("old", 0, 1_000);

    jobs.forget("going");
    jobs.forget("ended");
    expect((await jobs.read("going", 0, 0)).state).toBe("running");
    expect((await jobs.read("ended", 0, 0)).state).toBe("unknown");

    now = 7 * 60 * 60_000;
    // The next start clears out what nobody came back for.
    jobs.start(request("new"), () => Promise.resolve("ok"));
    expect((await jobs.read("old", 0, 0)).state).toBe("unknown");
    expect((await jobs.read("going", 0, 0)).state).toBe("running");
  });

  it("counts what is going, by kind", async () => {
    const jobs = createMachineJobs();
    jobs.start(request("run", "run"), held().handler);
    jobs.start(request("script", "script"), held().handler);
    jobs.start(request("done", "shell"), () => Promise.resolve(null));
    await jobs.read("done", 0, 1_000);
    expect(jobs.inFlight()).toBe(2);
    expect(jobs.inFlight((kind) => kind !== "run")).toBe(1);
  });

  it("carries the errors a board's automations branch on", () => {
    const moved = reviveJobError(jobError(new WorktreeHeadError("The branch moved on", "abc1234", true)));
    expect(moved).toBeInstanceOf(WorktreeHeadError);
    expect(moved).toMatchObject({ message: "The branch moved on", head: "abc1234", moved: true });
    expect(reviveJobError(jobError("plain"))).toMatchObject({ message: "plain" });
    expect(reviveJobError(undefined).message).toBe("The machine's job failed");
  });
});
