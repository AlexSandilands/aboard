import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeProjectSlug } from "../claudeSessionTitle.ts";
import { AUTOPILOT_REVIEW_PRS } from "@repo/contracts";
import { createReviewFallbacks, machineWorktreeOf } from "../reviewFallbacks.ts";
import { InterpreterMissingError } from "../scriptRunner.ts";
import { createRemoteWork } from "./remoteWork.ts";
import type { RunHeadless } from "../headlessReview.ts";

type HeadlessRequest = Parameters<RunHeadless>[0];
import { createBoardAndRunner } from "../../test/boardAndRunner.ts";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

async function setup(options: Parameters<typeof createBoardAndRunner>[0] = {}) {
  const pair = await createBoardAndRunner(options);
  stops.push(pair.stop);
  const { board, machine } = pair;
  board.services.settings.update({
    autoReview: true,
    headlessReviewEnabled: true,
    providers: [{ id: "claude-code", enabled: true }],
  });
  const project = board.services.projects.create({ title: "App", workspaceRoot: "/work/app" });
  const task = board.services.tasks.create({
    projectId: project.id,
    title: "Ship the thing",
    plan: { phases: [{ title: "Build", steps: [{ title: "Write it" }] }] },
  });
  await board.integrations.machineSync.handOver(task.id, machine.id, "user");
  return { ...pair, project, task };
}

/** The agent on the machine finishes its one step and moves the task to Review. */
function finishThere(
  runner: Awaited<ReturnType<typeof setup>>["runner"],
  task: { id: string; phases: Array<{ steps: Array<{ id: string }> }> },
) {
  runner.services.tasks.move(task.id, { status: "in_progress" }, "claude");
  runner.services.plans.updateStep(task.phases[0]!.steps[0]!.id, { status: "done" }, "claude");
  runner.services.tasks.move(task.id, { status: "review" }, "claude");
}

describe("review rounds of a task a machine holds", () => {
  it("open on the machine by the board's settings and show on the board", async () => {
    const { board, runner, task, sync } = await setup();
    finishThere(runner, task);
    await sync();

    const rounds = board.services.reviews.list(task.id);
    expect(rounds).toMatchObject([{ round: 1, status: "pending", trigger: "move", openedBy: "claude" }]);
    expect(rounds[0]!.id).toBe(runner.services.reviews.list(task.id)[0]!.id);
    expect(board.services.tasks.summary(task.id).review).toMatchObject({ round: 1 });
  });

  it("are run by the machine's reviewer, in the worktree there, and never by the board's", async () => {
    const { board, runner, task, sync } = await setup();
    finishThere(runner, task);
    await sync();

    const asked: HeadlessRequest[] = [];
    const findings = [{ severity: "major" as const, title: "Unchecked input", file: "src/a.ts", line: 3 }];
    const reviewer = (services: () => typeof board.services) =>
      createReviewFallbacks({
        services,
        t3: { sendToThread: () => Promise.resolve(), threadWorkspace: () => Promise.resolve(null) },
        runHeadless: (request) => {
          asked.push(request);
          return Promise.resolve({ summary: "One problem", findings, costUsd: 0.2, usage: [] });
        },
        worktreeOf: () => "/data/worktrees/app/1-abcd",
        graceMs: 0,
        agentGraceMs: 0,
        log: { warn: () => {} },
      });

    // The board's watchdog leaves a held task's round alone.
    const here = reviewer(() => board.services);
    await here.tick();
    await here.idle();
    expect(asked).toEqual([]);

    // With no worktree of the task on the machine there is nothing to read: the round fails rather than pass unread.
    const nowhere = createReviewFallbacks({
      services: () => runner.services,
      t3: { sendToThread: () => Promise.resolve(), threadWorkspace: () => Promise.resolve(null) },
      runHeadless: (request) => {
        asked.push(request);
        return Promise.resolve({ summary: "Clean", findings: [], costUsd: 0, usage: [] });
      },
      worktreeOf: () => null,
      graceMs: 0,
      agentGraceMs: 0,
      log: { warn: () => {} },
    });
    await nowhere.tick();
    await nowhere.idle();
    expect(asked).toEqual([]);
    expect(runner.services.reviews.list(task.id)[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("has no worktree on this machine to review in"),
    });
    runner.services.reviews.openRound(task.id, { trigger: "manual", actor: "user", force: true });

    const there = reviewer(() => runner.services);
    await there.tick();
    await there.idle();
    expect(runner.services.reviews.list(task.id)[0]).toMatchObject({ error: null });
    expect(asked.map((r) => r.cwd)).toEqual(["/data/worktrees/app/1-abcd"]);

    await sync();
    const [round] = board.services.reviews.list(task.id);
    expect(round).toMatchObject({ status: "submitted", reviewer: "board reviewer" });
    expect(round!.findings).toMatchObject([
      { label: "R1.1", severity: "major", title: "Unchecked input", status: "open" },
    ]);
    expect(board.services.tasks.summary(task.id).review?.open.major).toBe(1);
  });

  it("take what the board does to them: a finding resolved here is resolved there, under the same ids", async () => {
    const { board, runner, task, sync } = await setup();
    finishThere(runner, task);
    runner.services.reviews.submit(
      task.id,
      { findings: [{ severity: "major", title: "Unchecked input" }], summary: "One problem" },
      "reviewer",
    );
    await sync();

    board.services.reviews.resolveFinding(task.id, "R1.1", { status: "fixed", note: "Checked now" }, "user");
    // Shown at once on the board, and waiting for the machine.
    expect(board.services.reviews.list(task.id)[0]!.findings[0]).toMatchObject({ status: "fixed" });
    expect(board.services.tasks.summary(task.id).hold?.waiting).toBe(1);
    await sync();
    await sync();

    const there = runner.services.reviews.list(task.id);
    expect(there[0]!.findings[0]).toMatchObject({ status: "fixed", resolutionNote: "Checked now", resolvedBy: "user" });
    // The last gating finding resolved opens the next round, on the machine; the board has the same one.
    expect(there.map((r) => r.round)).toEqual([1, 2]);
    const here = board.services.reviews.list(task.id);
    expect(here.map((r) => r.id)).toEqual(there.map((r) => r.id));
    expect(board.services.tasks.summary(task.id).hold?.waiting).toBe(0);
  });

  it("go with the task when it is handed over, and come back with it", async () => {
    const pair = await createBoardAndRunner();
    stops.push(pair.stop);
    const { board, runner, machine } = pair;
    const project = board.services.projects.create({ title: "App", workspaceRoot: "/work/app" });
    const task = board.services.tasks.create({
      projectId: project.id,
      title: "Reviewed before",
      plan: { phases: [{ title: "Build", steps: [{ title: "Write it" }] }] },
    });
    board.services.reviews.submit(task.id, { findings: [{ severity: "minor", title: "Naming" }] }, "reviewer");
    await board.integrations.machineSync.handOver(task.id, machine.id, "user");

    expect(runner.services.reviews.list(task.id)).toMatchObject([{ round: 1, findings: [{ title: "Naming" }] }]);
    runner.services.reviews.resolveFinding(task.id, "R1.1", { status: "fixed" }, "claude");
    await board.integrations.machineSync.release(task.id, {}, "user");
    expect(board.services.reviews.list(task.id)[0]!.findings[0]).toMatchObject({ status: "fixed" });
  });
});

describe("what the board shows of work on a machine", () => {
  const SESSION = "11111111-2222-4333-8444-555555555555";

  it("takes a session's status and title from the machine it ran on, and doesn't read them itself", async () => {
    const { board, runner, task, sync } = await setup();
    const there = runner.services.links.add(
      task.id,
      {
        agentSession: {
          harness: "claude-code",
          sessionId: SESSION,
          cwd: "/data/worktrees/app/1-abcd",
          machine: { id: runner.instanceId, name: "engine" },
        },
        label: "Implementing",
      },
      "claude",
    );
    runner.services.links.setSnapshot(there.id, { status: "busy", inApp: false, title: "Fixing the parser" });
    await sync();

    const link = () => board.services.tasks.summary(task.id).links.find((l) => l.id === there.id);
    expect(link()).toMatchObject({ snapshot: { status: "busy", title: "Fixing the parser" } });
    // The board's own poll finds no such session on this machine, and leaves what the machine said.
    await board.integrations.refreshLink(there.id);
    expect(link()).toMatchObject({ snapshot: { status: "busy" } });
    // Opened over ssh, in tmux on the machine (interactive.test.ts), never from a folder here.
    // The folder and quoting are the shell's here (a POSIX shell, or PowerShell on Windows); ssh goes to the machine.
    expect(board.integrations.resumeCommand(there.id, "resume").command).toContain("ssh -t -- 100.101.102.103 ");

    runner.services.links.setSnapshot(there.id, {
      status: "finished",
      inApp: false,
      endedAt: "2026-01-05T11:00:00.000Z",
    });
    await sync();
    expect(link()).toMatchObject({ snapshot: { status: "finished" } });
  });

  it("counts the tokens used on the machine under the task, named as that machine's", async () => {
    const { board, runner, task, sync } = await setup();
    runner.services.usage.recordRun({
      harness: "claude-code",
      sessionId: null,
      runId: `review-${task.id}-1`,
      taskId: task.id,
      purpose: "review",
      model: "claude-haiku-4-5",
      usage: [
        {
          model: "claude-haiku-4-5",
          tokens: { input: 1200, output: 300, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        },
      ],
      costUsd: 0.02,
      at: "2026-01-05T10:30:00.000Z",
    });
    runner.services.tasks.addNote(task.id, "Reviewed", "board reviewer");
    await sync();
    // The same entry again changes nothing.
    await sync();

    const usage = board.services.usage.taskUsage(task.id);
    expect(usage?.rows).toMatchObject([
      { kind: "run", purpose: "review", machine: "engine", tokens: { input: 1200, output: 300 }, costUsd: 0.02 },
    ]);
    // What the board read itself says no machine.
    expect(runner.services.usage.taskUsage(task.id)?.rows[0]?.machine ?? null).toBeNull();
  });

  it("reads a session's transcript on the machine it ran on, while the task is held and after", async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "machine-transcripts-"));
    stops.push(() => rmSync(claudeDir, { recursive: true, force: true }));
    const cwd = "/data/worktrees/app/1-abcd";
    const folder = join(claudeDir, "projects", claudeProjectSlug(cwd));
    mkdirSync(folder, { recursive: true });
    const entry = {
      type: "user",
      timestamp: "2026-01-01T10:00:00.000Z",
      message: { role: "user", content: "Fix the parser" },
    };
    writeFileSync(join(folder, `${SESSION}.jsonl`), `${JSON.stringify(entry)}\n`);
    const { board, runner, task, machine, sync, link } = await setup({
      runnerSessionDirs: { claudeDir, copilotDir: join(claudeDir, "copilot") },
    });
    runner.services.links.add(
      task.id,
      {
        agentSession: {
          harness: "claude-code",
          sessionId: SESSION,
          cwd,
          machine: { id: runner.instanceId, name: "engine" },
        },
        label: "Implementing",
      },
      "claude",
    );
    await sync();

    const read = await board.integrations.sessionTranscript(task.id, {});
    expect(read).toMatchObject({ sessionId: SESSION, label: "Implementing" });
    expect(JSON.stringify(read.page)).toContain("Fix the parser");
    // The machine itself reads its own.
    expect(JSON.stringify((await runner.integrations.sessionTranscript(task.id, {})).page)).toContain("Fix the parser");

    await board.integrations.machineSync.release(task.id, {}, "user");
    expect(JSON.stringify((await board.integrations.sessionTranscript(task.id, {})).page)).toContain("Fix the parser");
    await link(false);
    await expect(board.integrations.sessionTranscript(task.id, {})).rejects.toThrow(
      "ran on engine, which can't be reached",
    );
    void machine;
  });

  it("has the task's pasted images on the machine, under the paths its prompts name", async () => {
    const pair = await createBoardAndRunner();
    stops.push(pair.stop);
    const { board, runner, machine } = pair;
    const project = board.services.projects.create({ title: "App", workspaceRoot: "/work/app" });
    const task = board.services.tasks.create({ projectId: project.id, title: "With a screenshot" });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const image = board.services.attachments.upload({
      taskId: task.id,
      filename: "bug.png",
      mime: "image/png",
      bytes: png,
    });
    await board.integrations.machineSync.handOver(task.id, machine.id, "user");

    const there = runner.services.attachments.forTask(task.id);
    expect(there).toMatchObject([{ id: image.id, filename: "bug.png", mime: "image/png" }]);
    expect(existsSync(there[0]!.path)).toBe(true);
    expect([...readFileSync(there[0]!.path)]).toEqual([...png]);
    // Not the board's folder: the machine's own.
    expect(there[0]!.path).not.toBe(board.services.attachments.forTask(task.id)[0]!.path);

    // Taken back, the machine drops the task and its images; handed over again, it gets them again.
    await board.integrations.machineSync.release(task.id, {}, "user");
    expect(runner.services.attachments.forTask(task.id)).toEqual([]);
    await board.integrations.machineSync.handOver(task.id, machine.id, "user");
    expect(runner.services.attachments.forTask(task.id)).toMatchObject([{ id: image.id }]);
  });

  it("sends its settings again to a machine that was updated since", async () => {
    const { board, runner, machine, sync } = await setup();
    expect(runner.services.settings.get().autoReview).toBe(true);
    // The machine's own settings went back to what they were (a reinstall), and it answers as a newer version.
    runner.services.settings.update({ autoReview: false });
    await sync();
    expect(runner.services.settings.get().autoReview).toBe(false);
    board.services.machines.observe(machine.id, { version: "9.9.9", protocolVersion: 1, platform: null, logins: null });
    await sync();
    expect(runner.services.settings.get().autoReview).toBe(true);
  });
});

describe("a job the board reads on a machine", () => {
  const script = (taskId: string) => ({
    language: "sh" as const,
    body: "echo hi",
    cwd: "/the/boards/folder",
    taskId,
    env: {},
    context: {},
    timeoutMs: 1_000,
  });
  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  /** The board's work on machines, with the link in the test's hands and a clock that only waiting moves. */
  async function work(options: Parameters<typeof createBoardAndRunner>[0] = {}) {
    // With a repository, so the machine has a folder of the project to run a script in.
    const pair = await setup({ remotes: { "/work/app": "git@github.com:acme/app.git" }, ...options });
    const clock = { now: 0 };
    const waits: number[] = [];
    const sent: string[] = [];
    const link = {
      /** Requests that fail before they reach the machine. */
      down: 0,
      can: true as boolean | null,
      respond: null as ((path: string, init?: RequestInit) => Response | null) | null,
    };
    const remote = createRemoteWork({
      services: () => pair.board.services,
      machines: {
        can: () => link.can,
        request: (id, path, init, opts) => {
          sent.push(`${init?.method ?? "GET"} ${path.split("?")[0]}`);
          if (link.down > 0) {
            link.down -= 1;
            return Promise.reject(new TypeError("fetch failed"));
          }
          const canned = link.respond?.(path, init);
          return canned ? Promise.resolve(canned) : pair.board.integrations.machines.request(id, path, init, opts);
        },
      },
      runGit: () => Promise.resolve({ code: 1, stdout: "", stderr: "" }),
      now: () => clock.now,
      sleep: (ms) => {
        waits.push(ms);
        clock.now += ms;
        return Promise.resolve();
      },
      log: { warn: () => {} },
    });
    return { ...pair, remote, link, waits, sent, clock };
  }

  it("asks again while the machine can't be reached, and starts the job once", async () => {
    const ran: string[] = [];
    const { remote, link, waits, task } = await work({
      runner: {
        runScript: (request) => {
          ran.push(request.cwd);
          return Promise.resolve({
            exitCode: 0,
            output: "hi\n",
            stdout: "hi\n",
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
          });
        },
      },
    });
    link.down = 2;
    const result = await remote.script(script(task.id));
    expect(result).toMatchObject({ exitCode: 0, output: "hi\n" });
    expect(waits).toEqual([2_000, 4_000]);
    expect(ran).toHaveLength(1);
  });

  it("gives up on a machine that stays away past the job's time, saying its outcome is unknown", async () => {
    const { remote, link, waits, task } = await work();
    link.down = Number.POSITIVE_INFINITY;
    await expect(remote.script(script(task.id))).rejects.toThrow(
      "engine couldn't be reached, so what became of this is unknown: fetch failed",
    );
    // Backing off to half a minute, for the five minutes of grace.
    expect(Math.max(...waits)).toBe(30_000);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(300_000);
  });

  it("counts the silence from the machine's last answer, however long the job has been going", async () => {
    const { remote, link, waits, clock, task } = await work({
      runner: {
        runScript: () =>
          Promise.resolve({
            exitCode: 0,
            output: "late\n",
            stdout: "late\n",
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
          }),
      },
    });
    let reads = 0;
    link.respond = (path, init) => {
      if (init?.method || !path.startsWith("/machine/jobs/")) return null;
      reads += 1;
      if (reads > 1) return null;
      // The job has been going for two hours, far past its own second and the grace, when the link drops.
      clock.now += 2 * 60 * 60_000;
      link.down = 3;
      return answer({ id: "x", state: "running", updates: [] });
    };
    expect(await remote.script(script(task.id))).toMatchObject({ exitCode: 0, output: "late\n" });
    expect(waits).toEqual([2_000, 4_000, 8_000]);
  });

  it("fails a job the machine no longer knows: it restarted", async () => {
    const { remote, link, task } = await work({
      runner: { runScript: () => new Promise(() => {}) },
    });
    // Started for real; then the runner comes back with no jobs.
    link.respond = (path, init) =>
      !init?.method && path.startsWith("/machine/jobs/") ? answer({ id: "x", state: "unknown", updates: [] }) : null;
    await expect(remote.script(script(task.id))).rejects.toThrow("engine restarted while this was going");
  });

  it("rebuilds a missing interpreter as the error a script action reports, and passes a refusal on", async () => {
    const { remote, link, task } = await work({
      runner: { runScript: () => Promise.reject(new InterpreterMissingError("python3")) },
    });
    const missing = await remote.script(script(task.id))!.catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(InterpreterMissingError);
    expect((missing as Error).message).toBe("python3 not found on PATH");

    link.respond = () => answer({ error: { code: "CONFLICT", message: "#1 isn't held by this machine" } }, 409);
    await expect(remote.script(script(task.id))).rejects.toThrow("#1 isn't held by this machine");
  });

  it("refuses up front on a machine that said it can't run things, sending nothing", async () => {
    const { remote, link, sent, task } = await work();
    link.can = false;
    await expect(remote.script(script(task.id))).rejects.toThrow(
      "engine runs a version that can't run things for a task; update it first",
    );
    expect(sent).toEqual([]);
  });
});

describe("the board's settings on a machine", () => {
  it("keeps where the machine's own CLIs are, and skips a setting it can't read without dropping the rest", async () => {
    const { runner } = await setup();
    runner.services.settings.update({ providers: [{ id: "claude-code", enabled: false, cliPath: "/opt/claude" }] });
    runner.integrations.runnerHost.work.applySettings({
      providers: [
        { id: "claude-code", enabled: true, cliPath: "C:\\board\\claude.exe" },
        { id: "codex", enabled: true },
      ],
      reviewMaxRounds: "many",
      autoReview: false,
      machineName: "not the board's to set",
    });
    const settings = runner.services.settings.get();
    expect(settings.providers).toEqual([
      { id: "claude-code", enabled: true, cliPath: "/opt/claude" },
      { id: "codex", enabled: true, cliPath: null },
    ]);
    expect(settings.autoReview).toBe(false);
    expect(settings.reviewMaxRounds).toBe(3);
    expect(settings.machineName).toBe("engine");
  });
});

describe("a board restart while a machine works", () => {
  it("flags the run instead of redoing it: the agent on the machine goes on", async () => {
    const { board, task } = await setup();
    const run = board.services.autopilot.record({
      automation: AUTOPILOT_REVIEW_PRS,
      candidate: { dedupeKey: "review:pr:abc", summary: "review PR #7", taskId: task.id },
      dryRun: false,
    })!;
    board.services.autopilot.start(run.id);
    expect(board.services.autopilot.recover()).toBe(1);

    const [after] = board.services.autopilot.runsForTask(task.id);
    expect(after).toMatchObject({ status: "failed", needsAttention: true, dedupeKey: "review:pr:abc" });
    expect(after!.error).toContain("It ran on engine, where its agent may still be working");
  });
});

describe("where a machine's reviewer works", () => {
  it("is the folder of the task's newest session that ran on this machine, not one the board linked", () => {
    const session = (cwd: string, machine?: string) => ({
      kind: "agent_session" as const,
      ref: {
        harness: "claude-code" as const,
        sessionId: "s",
        cwd,
        ...(machine ? { machine: { id: machine, name: machine } } : {}),
      },
    });
    const links = [
      session("/w/old", "here"),
      session("/w/new", "here"),
      session("/w/gone", "here"),
      session("/home/me/app"),
      session("/w/other", "elsewhere"),
    ];
    const task = { links } as unknown as Parameters<typeof machineWorktreeOf>[0];
    // Every path exists but the worktree that was cleaned up.
    expect(machineWorktreeOf(task, "here", (path) => path !== "/w/gone")).toBe("/w/new");
    expect(machineWorktreeOf(task, "nobody", () => true)).toBeNull();
  });
});
