import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND, EMPTY_MODEL_TIERS, type AutopilotRun, type T3IntegrationStatus } from "@repo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentJob } from "../integrations/headlessAgent.ts";
import type { T3Integration, TaskThreadInput } from "../integrations/t3.ts";
import { createGitFixture, git } from "../test/gitRepo.ts";
import { createTestHarness } from "../test/harness.ts";
import { createAutopilotRunner, tierModel } from "./runner.ts";
import { WorktreeHeadError, type RunnerRequest, type RunPatch } from "./types.ts";

const SESSION = "11111111-2222-4333-8444-555555555555";
const plan = { phases: [{ title: "Build", steps: [{ title: "a" }] }] };

const T3_UP: T3IntegrationStatus = {
  detected: true,
  origin: "http://127.0.0.1:3773",
  environmentId: "env-1",
  label: "T3",
  liveStatus: "ok",
  error: null,
};
const T3_DOWN: T3IntegrationStatus = { ...T3_UP, detected: false, origin: null, liveStatus: "off" };

const result = (fields: Record<string, unknown>) => JSON.stringify({ type: "result", subtype: "success", ...fields });

// Real git processes are slow on the Windows CI runner.
describe("Autopilot runner", { timeout: 30_000 }, () => {
  let repo: ReturnType<typeof createGitFixture>;
  // Building the fixture runs several git processes, which can outlast the default hook timeout on Windows.
  beforeEach(() => {
    repo = createGitFixture();
  }, 30_000);
  afterEach(() => repo.cleanup());

  function setup(opts: { t3?: T3IntegrationStatus; agent?: (job: AgentJob) => Promise<string> } = {}) {
    const h = createTestHarness();
    const project = h.services.projects.create({ title: "App", workspaceRoot: repo.checkout });
    const task = h.services.tasks.create({ projectId: project.id, title: "Add exports", plan });
    const jobs: AgentJob[] = [];
    const launches: TaskThreadInput[] = [];
    const sent: Array<{ text: string; commandId: string }> = [];
    const t3: Pick<T3Integration, "status" | "launchTaskThread" | "sendToThread"> = {
      status: () => opts.t3 ?? T3_DOWN,
      launchTaskThread: async (taskId, input) => {
        launches.push(input);
        const link = h.services.links.add(taskId, { t3Thread: { environmentId: "env-1", threadId: "thread-9" } }, "x");
        return {
          link,
          modelSelection: { instanceId: "claude", model: "m", options: [] },
          runtimeMode: "full-access",
          workspace: { mode: "current" },
          suggestionUnavailable: null,
        };
      },
      sendToThread: async (_link, text, commandId) => {
        sent.push({ text, commandId });
      },
    };
    const runner = createAutopilotRunner({
      services: () => h.services,
      t3,
      worktreesDir: repo.worktrees,
      newSessionId: () => SESSION,
      runAgent: async (job) => {
        jobs.push(job);
        return opts.agent ? opts.agent(job) : result({ result: "Done", session_id: SESSION, total_cost_usd: 0.75 });
      },
      log: { warn: () => {} },
    });
    // Each setup makes its own run, so worktrees from two setups in one test don't collide.
    const run: AutopilotRun = {
      id: randomUUID(),
      automation: "test",
      taskId: task.id,
      projectId: project.id,
      dedupeKey: "k",
      status: "running",
      summary: "work",
      dryRun: false,
      runner: null,
      sessionId: null,
      threadUrl: null,
      worktreePath: null,
      costUsd: null,
      error: null,
      needsAttention: false,
      output: null,
      createdAt: "2026-10-17T00:00:00.000Z",
      startedAt: "2026-10-17T00:00:00.000Z",
      finishedAt: null,
      updatedAt: "2026-10-17T00:00:00.000Z",
    };
    const patches: RunPatch[] = [];
    const start = (request: Partial<RunnerRequest> & { options?: Record<string, unknown> } = {}) =>
      runner.start({ run, prompt: "Do the task", tier: null, options: {}, ...request }, (p) => patches.push(p));
    return { h, task, run, jobs, launches, sent, t3, start, patches };
  }

  it("runs headless in a new worktree, records the session and cost, and links the session", async () => {
    const { h, task, run, jobs, start, patches } = setup();
    const out = await start({ options: { runner: "auto", budgetUsd: 2, timeoutMinutes: 5, model: "haiku" } });

    const name = `${task.number}-${run.id.slice(0, 8)}`;
    const path = join(repo.worktrees, "app", name);
    expect(out).toEqual({
      runner: "headless",
      sessionId: SESSION,
      worktreePath: path,
      costUsd: 0.75,
      result: "Done",
    });
    // The session and worktree are on the run before the agent starts; the cost once it ends.
    expect(patches).toEqual([{ runner: "headless", worktreePath: path, sessionId: SESSION }, { costUsd: 0.75 }]);
    const job = jobs[0]!;
    expect(job.cwd).toBe(path);
    expect(job.timeoutMs).toBe(5 * 60_000);
    expect(job.args[job.args.indexOf("--max-budget-usd") + 1]).toBe("2");
    expect(job.args[job.args.indexOf("--session-id") + 1]).toBe(SESSION);
    expect(job.args[job.args.indexOf("--model") + 1]).toBe("haiku");
    expect(job.args[job.args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(job.prompt).toContain("Do the task");
    expect(job.prompt).toContain(`git push -u origin autopilot/${name}`);
    expect(job.prompt).toContain("never push to `main`");
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`autopilot/${name}`);

    const links = h.services.tasks.summary(task.id).links.filter((l) => l.kind === "agent_session");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ label: "Autopilot session", ref: { harness: "claude-code", sessionId: SESSION } });
  });

  it("works on an existing branch and pushes back to it", async () => {
    const { jobs, start } = setup();
    await start({ options: { runner: "headless" }, workspace: { branch: "feature" } });
    const job = jobs[0]!;
    expect(readFileSync(join(job.cwd, "feature.txt"), "utf8")).toBe("feature\n");
    expect(job.prompt).toContain("git push origin HEAD:feature");
    await expect(setup().start({ options: { runner: "headless" }, workspace: { branch: "main" } })).rejects.toThrow(
      "default branch",
    );
  });

  it("runs a read-only agent with its tools and returns the structured output", async () => {
    const { jobs, start } = setup({
      agent: async () => result({ structured_output: { verdict: "ok" }, total_cost_usd: 0.1 }),
    });
    const out = await start({
      options: { runner: "headless" },
      access: "read-only",
      tools: ["Bash(gh pr review *)"],
      outputSchema: { type: "object" },
    });
    expect(out.output).toEqual({ verdict: "ok" });
    const args = jobs[0]!.args;
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args).toContain("Bash(gh pr review *)");
    expect(jobs[0]!.prompt).toContain("Don't edit files");
  });

  it("keeps a read-only agent that reads untrusted text away from MCP servers and other files", async () => {
    const { jobs, start } = setup({ agent: async () => result({ result: "ok" }) });
    await start({ options: { runner: "headless" }, access: "read-only", untrustedInput: true });
    const args = jobs[0]!.args;
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain(`mcp__${BRAND.id}`);
    expect(args).toContain("Read(./**)");
    expect(args).not.toContain("Read");
  });

  describe("expecting a head commit", () => {
    it("starts the agent when the worktree is at it", async () => {
      const { jobs, start } = setup();
      await start({
        options: { runner: "headless" },
        workspace: { branch: "feature" },
        expectHead: git(repo.checkout, "rev-parse", "feature"),
      });
      expect(jobs).toHaveLength(1);
    });

    it("refuses before the agent starts when the branch has moved past it", async () => {
      const { jobs, start } = setup();
      // main's commit is an ancestor of feature's tip: the branch moved on from it.
      const old = git(repo.checkout, "rev-parse", "main");
      const failure = await start({
        options: { runner: "headless" },
        workspace: { branch: "feature" },
        expectHead: old,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(WorktreeHeadError);
      expect(failure).toMatchObject({ moved: true, head: git(repo.checkout, "rev-parse", "feature") });
      expect(jobs).toEqual([]);
    });

    it("refuses, saying it isn't the PR's, when the worktree is at an unrelated commit", async () => {
      const { jobs, start } = setup();
      git(repo.checkout, "commit", "--quiet", "--allow-empty", "-m", "elsewhere");
      const elsewhere = git(repo.checkout, "rev-parse", "HEAD");
      const failure = await start({
        options: { runner: "headless" },
        workspace: { branch: "feature" },
        expectHead: elsewhere,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(WorktreeHeadError);
      expect(failure).toMatchObject({ moved: false });
      expect((failure as Error).message).toContain("not the PR's head");
      expect(jobs).toEqual([]);
    });
  });

  it("fails a run that stopped, keeping its cost and session", async () => {
    const { start, patches } = setup({
      agent: async () => JSON.stringify({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 2.02 }),
    });
    await expect(start({ options: { runner: "headless" } })).rejects.toThrow("error max budget usd");
    expect(patches.at(-1)).toEqual({ costUsd: 2.02 });
    expect(patches[0]).toMatchObject({ sessionId: SESSION });
  });

  it("fails on a timeout, leaving the worktree for the user", async () => {
    const { start, patches } = setup({
      agent: () => Promise.reject(new Error("Claude Code didn't finish within 5 minutes")),
    });
    await expect(start({ options: { runner: "headless", timeoutMinutes: 5 } })).rejects.toThrow("5 minutes");
    expect(existsSync(patches[0]!.worktreePath!)).toBe(true);
  });

  it("takes the model from the task's tier when it is a Claude model", () => {
    const tiers = {
      ...EMPTY_MODEL_TIERS,
      deep: {
        description: null,
        t3: { selection: { instanceId: "c", model: "claude-opus-5-5", options: [] }, label: "Opus" },
      },
      light: { description: null, t3: { selection: { instanceId: "x", model: "gpt-5", options: [] }, label: "GPT" } },
    };
    expect(tierModel(tiers, "deep")).toBe("claude-opus-5-5");
    expect(tierModel(tiers, "light")).toBeNull();
    expect(tierModel(tiers, "standard")).toBeNull();
    expect(tierModel(tiers, null)).toBeNull();
  });

  describe("runner choice", () => {
    it("Auto starts a T3 thread when T3 is connected, with a stable command id and lowered access", async () => {
      const { run, jobs, launches, start, patches } = setup({ t3: T3_UP });
      const out = await start({ options: { runner: "auto", t3Access: "auto-accept-edits" } });
      expect(jobs).toHaveLength(0);
      expect(out.runner).toBe("t3");
      expect(out.threadUrl).toMatch(/thread-9/);
      expect(patches).toEqual([{ runner: "t3", threadUrl: out.threadUrl }]);
      expect(launches[0]).toMatchObject({
        commandId: `autopilot-${run.id}`,
        work: true,
        maxRuntimeMode: "auto-accept-edits",
      });
      expect(launches[0]!.prompt).toContain("Do the task");
      expect(launches[0]).not.toHaveProperty("baseRef");
    });

    it("starts T3 from a PR branch on origin and tells the agent where to push", async () => {
      const { launches, start } = setup({ t3: T3_UP });
      await start({ options: { runner: "t3" }, workspace: { branch: "feature" } });
      expect(launches[0]).toMatchObject({ baseRef: "feature", startFromOrigin: true });
      expect(launches[0]).not.toHaveProperty("maxRuntimeMode");
      expect(launches[0]!.prompt).toContain("git push origin HEAD:feature");
      await expect(
        setup({ t3: T3_UP }).start({ options: { runner: "t3" }, workspace: { branch: "main" } }),
      ).rejects.toThrow("default branch");
    });

    it("Auto runs headless when T3 isn't connected; T3 only fails; Headless only skips T3", async () => {
      const auto = setup({ t3: T3_DOWN });
      expect((await auto.start({ options: { runner: "auto" } })).runner).toBe("headless");

      const t3Only = setup({ t3: T3_DOWN });
      await expect(t3Only.start({ options: { runner: "t3" } })).rejects.toThrow("T3 Code isn't connected");
      expect(t3Only.jobs).toHaveLength(0);

      const headless = setup({ t3: T3_UP });
      expect((await headless.start({ options: { runner: "headless" } })).runner).toBe("headless");
      expect(headless.launches).toHaveLength(0);
    });

    it("runs read-only, tool and schema requests headless even when T3 is connected", async () => {
      for (const request of [
        { access: "read-only" as const },
        { tools: ["Bash(gh pr review *)"] },
        { outputSchema: { type: "object" } },
      ]) {
        const auto = setup({
          t3: T3_UP,
          agent: async () => result({ structured_output: {}, total_cost_usd: 0 }),
        });
        expect((await auto.start({ options: { runner: "auto" }, ...request })).runner).toBe("headless");
        expect(auto.launches).toHaveLength(0);

        const t3Only = setup({ t3: T3_UP });
        await expect(t3Only.start({ options: { runner: "t3" }, ...request })).rejects.toThrow("needs a headless run");
        expect(t3Only.launches).toHaveLength(0);
      }
    });

    it("nudges the task's latest live thread with a stable command id", async () => {
      const { h, task, run, sent, start } = setup({ t3: T3_UP });
      await expect(start({ kind: "nudge" })).rejects.toThrow("no live T3 Code thread");
      h.services.links.add(task.id, { t3Thread: { environmentId: "env-1", threadId: "thread-1" } }, "x");
      const out = await start({ kind: "nudge", prompt: "Continue" });
      expect(out).toMatchObject({ runner: "t3", result: null });
      expect(out.threadUrl).toMatch(/thread-1/);
      expect(sent).toEqual([{ text: "Continue", commandId: `autopilot-${run.id}` }]);
    });

    it("needs a task", async () => {
      const { start } = setup();
      await expect(start({ run: { taskId: null } as AutopilotRun })).rejects.toThrow("needs a task");
    });
  });
});
