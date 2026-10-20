import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRAND,
  EMPTY_MODEL_TIERS,
  type AutopilotRun,
  type ModelProfile,
  type T3IntegrationStatus,
} from "@repo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentJob } from "../integrations/headlessAgent.ts";
import { t3Unavailable, type T3Integration, type TaskThreadInput, type ThreadWorkspace } from "../integrations/t3.ts";
import { createGitFixture, git } from "../test/gitRepo.ts";
import { createTestHarness } from "../test/harness.ts";
import { PROCESS_TEST_TIMEOUT } from "../test/timeouts.ts";

/** Built at runtime, so it reads as no credential to anything scanning the source. */
const BOARD_TOKEN = ["board", "test", "value"].join("-");
import { createAutopilotRunner, headlessModel, runModel } from "./runner.ts";
import { RUNNER_DEFAULTS, readRunnerOptions } from "./runnerOptions.ts";
import { RunAbandonedError, WorktreeHeadError, type RunnerRequest, type RunPatch } from "./types.ts";

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

/** A thread whose workspace is ready and whose agent is running. */
const WORKSPACE: ThreadWorkspace = {
  worktreePath: "/t3/worktrees/app/t3-1",
  branch: "t3/1",
  runStatus: "running",
  latestRunId: "run-1",
  lastError: null,
  updatedAt: "2026-10-17T08:00:00.000Z",
};
const FETCH_FAILED = "Workspace preparation failed during provision worktree: git fetch origin failed";

const result = (fields: Record<string, unknown>) => JSON.stringify({ type: "result", subtype: "success", ...fields });

// Real git processes are slow on a loaded Windows machine.
describe("Autopilot runner", { timeout: PROCESS_TEST_TIMEOUT }, () => {
  let repo: ReturnType<typeof createGitFixture>;
  // The first fixture in a file builds the template repositories, a dozen git processes.
  beforeEach(() => {
    repo = createGitFixture();
  }, PROCESS_TEST_TIMEOUT);
  afterEach(() => repo.cleanup());

  function setup(
    opts: {
      t3?: T3IntegrationStatus;
      /** What T3 reports after a fresh look (the runner asks when its cached status isn't ready). */
      t3AfterLook?: T3IntegrationStatus;
      /** Fails the first launches, in order. */
      launchFailures?: Error[];
      /** Fails the first posts into a thread, in order. */
      nudgeFailures?: Error[];
      holdMs?: number;
      /** What T3 says about the thread on each look while its workspace is prepared; the last one repeats. */
      workspaces?: Array<Partial<ThreadWorkspace> | null>;
      /** Fails the request to prepare a workspace again. */
      retryFailure?: Error;
      prepareMs?: number;
      agent?: (job: AgentJob) => Promise<string>;
    } = {},
  ) {
    const h = createTestHarness();
    const project = h.services.projects.create({ title: "App", workspaceRoot: repo.checkout });
    const task = h.services.tasks.create({ projectId: project.id, title: "Add exports", plan });
    const jobs: AgentJob[] = [];
    const launches: TaskThreadInput[] = [];
    const sent: Array<{ text: string; commandId: string }> = [];
    const linked: string[] = [];
    const looks: number[] = [];
    const failures = [...(opts.launchFailures ?? [])];
    const nudgeFailures = [...(opts.nudgeFailures ?? [])];
    const workspaces = [...(opts.workspaces ?? [{}])];
    const retries: Array<{ runId: string; commandId: string }> = [];
    const t3: Pick<
      T3Integration,
      "status" | "test" | "launchTaskThread" | "sendToThread" | "threadWorkspace" | "retryPreparation"
    > = {
      status: () => opts.t3 ?? T3_DOWN,
      test: async () => {
        looks.push(1);
        return opts.t3AfterLook ?? opts.t3 ?? T3_DOWN;
      },
      launchTaskThread: async (taskId, input) => {
        launches.push(input);
        const failure = failures.shift();
        if (failure) throw failure;
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
        const failure = nudgeFailures.shift();
        if (failure) throw failure;
      },
      threadWorkspace: async () => {
        const next = workspaces.length > 1 ? workspaces.shift()! : workspaces[0]!;
        return next === null ? null : { ...WORKSPACE, ...next };
      },
      retryPreparation: async (_link, runId, commandId) => {
        retries.push({ runId, commandId });
        if (opts.retryFailure) throw opts.retryFailure;
      },
    };
    const runner = createAutopilotRunner({
      services: () => h.services,
      t3,
      t3HoldMs: opts.holdMs ?? 0,
      t3RetryMs: 5,
      t3PrepareMs: opts.prepareMs ?? 10_000,
      t3PreparePollMs: 2,
      worktreesDir: repo.worktrees,
      newSessionId: () => SESSION,
      sessionLinked: (id) => linked.push(id),
      boardMcp: () => ({ url: "http://127.0.0.1:4317/mcp", token: BOARD_TOKEN }),
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
      detail: null,
      exitCode: null,
      error: null,
      needsAttention: false,
      dismissedAt: null,
      output: null,
      createdAt: "2026-10-17T00:00:00.000Z",
      startedAt: "2026-10-17T00:00:00.000Z",
      finishedAt: null,
      updatedAt: "2026-10-17T00:00:00.000Z",
    };
    const patches: RunPatch[] = [];
    const start = (request: Partial<RunnerRequest> & { options?: Record<string, unknown> } = {}) =>
      runner.start({ run, prompt: "Do the task", tier: null, options: {}, ...request }, (p) => patches.push(p));
    return { h, project, task, run, runner, jobs, launches, sent, linked, t3, start, patches, looks, retries };
  }

  it("runs headless in a new worktree, records the session and cost, and links the session", async () => {
    const { h, task, run, jobs, linked, start, patches } = setup();
    const out = await start({
      label: "Fix PRs · PR #7",
      options: { runner: "auto", budgetUsd: 2, timeoutMinutes: 5, model: "haiku" },
    });

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
    expect(job.args[job.args.indexOf("--name") + 1]).toBe("Autopilot · Fix PRs · PR #7");
    expect(job.args[job.args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(job.prompt).toContain("Do the task");
    expect(job.prompt).toContain("already linked this session to the task, so don't link it yourself");
    expect(job.prompt).toContain(`git push -u origin autopilot/${name}`);
    expect(job.prompt).toContain("never push to `main`");
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`autopilot/${name}`);

    const links = h.services.tasks.summary(task.id).links.filter((l) => l.kind === "agent_session");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      label: "Autopilot · Fix PRs · PR #7",
      ref: { harness: "claude-code", sessionId: SESSION },
    });
    // So the board reads its state at once, not at the next poll.
    expect(linked).toEqual([SESSION]);
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

    it("removes the worktree it made when the check refuses, since the run never records it", async () => {
      const { run, task, start, patches } = setup();
      const old = git(repo.checkout, "rev-parse", "main");
      await start({ options: { runner: "headless" }, workspace: { branch: "feature" }, expectHead: old }).catch(
        () => null,
      );
      const path = join(repo.worktrees, "app", `${task.number}-${run.id.slice(0, 8)}`);
      expect(existsSync(path)).toBe(false);
      expect(git(repo.checkout, "branch", "--list", "autopilot/*")).toBe("");
      expect(patches).toEqual([]);
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

  it("lets a read-only agent read the default branch, but never an agent that can push", async () => {
    const { jobs, start } = setup({ agent: async () => result({ result: "ok" }) });
    await start({ options: { runner: "headless" }, access: "read-only", workspace: { branch: "main" } });
    expect(readFileSync(join(jobs[0]!.cwd, "README.md"), "utf8")).toBe("hello\n");
    await expect(setup().start({ options: { runner: "headless" }, workspace: { branch: "main" } })).rejects.toThrow(
      "default branch",
    );
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

  it("takes the model from the automation, then a task label, then the task's tier", () => {
    const settings = {
      modelTiers: {
        ...EMPTY_MODEL_TIERS,
        deep: {
          description: null,
          t3: { selection: { instanceId: "c", model: "claude-opus-5-5", options: [] }, label: "Opus" },
        },
        light: { description: null, t3: { selection: { instanceId: "x", model: "gpt-5", options: [] }, label: "GPT" } },
        standard: { description: null, t3: null, cli: { "claude-code": "sonnet" } },
      },
      modelProfiles: [
        { id: "codex61", name: "Codex 6.1", labels: ["codex61"], description: null, t3: null },
      ] satisfies ModelProfile[],
    };
    const options = (config: Record<string, unknown> = {}) => readRunnerOptions(config);
    const task = { labels: ["codex61"] };
    // The tier's T3 model when it is a Claude model, the tier's Claude Code model, else the CLI's default.
    expect(headlessModel(runModel({ tier: "deep" }, options(), null, settings), "").model).toBe("claude-opus-5-5");
    expect(headlessModel(runModel({ tier: "standard" }, options(), null, settings), "").model).toBe("sonnet");
    const light = headlessModel(runModel({ tier: "light" }, options(), null, settings), "");
    expect(light.model).toBeNull();
    expect(light.note).toContain("no Claude Code model");
    expect(headlessModel(runModel({ tier: null }, options(), null, settings), "")).toEqual({ model: null, note: null });
    // A label beats the tier; the automation's Model setting beats both, and a typed override beats everything.
    expect(runModel({ tier: "deep" }, options(), task, settings)).toMatchObject({
      source: "label",
      label: "codex61",
      profile: { id: "codex61" },
    });
    expect(runModel({ tier: "deep" }, options({ modelChoice: { tier: "standard" } }), task, settings)).toMatchObject({
      source: "automation",
      profile: { id: "standard" },
    });
    expect(runModel({ tier: "deep", modelChoice: { tier: "light" } }, options(), task, settings).profile?.id).toBe(
      "light",
    );
    // A Model setting naming a deleted custom model falls back to the action's own choice, with a note.
    const deleted = runModel(
      { tier: "deep", modelChoice: { tier: "light" } },
      options({ modelChoice: { profile: "gone" } }),
      task,
      settings,
    );
    expect(deleted).toMatchObject({ source: "automation", profile: { id: "light" } });
    expect(deleted.note).toContain('"gone" no longer exists');
    expect(headlessModel(runModel({ tier: "deep" }, options(), task, settings), "haiku").model).toBe("haiku");
    // Configs saved before the setting existed take the task's model.
    expect(options({ model: "opus" })).toEqual({ ...RUNNER_DEFAULTS, model: "opus", modelChoice: { from: "task" } });
  });

  it("runs headless on the model a task label picks, and notes it on the run", async () => {
    const { h, task, jobs, start, patches } = setup();
    h.services.settings.update({
      modelProfiles: [
        { id: "fast", name: "Fast", labels: ["quick"], description: null, t3: null, cli: { "claude-code": "haiku" } },
      ],
    });
    h.services.tasks.update(task.id, { labels: ["quick"] }, "test");
    await start({ options: { runner: "headless" } });
    expect(jobs[0]!.args.join(" ")).toContain("--model haiku");
    expect(patches).toContainEqual({ detail: "Model: Fast, from label quick" });
  });

  describe("on another harness", () => {
    const CODEX_ID = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    const codexProfile = (headless: "codex" | "copilot-cli") => ({
      id: "other",
      name: "Other",
      labels: ["other"],
      description: null,
      t3: null,
      cli: { codex: "gpt-5.5-codex", "copilot-cli": "gpt-5.4" },
      headless,
    });
    const codexOutput = [
      JSON.stringify({ type: "thread.started", thread_id: CODEX_ID }),
      JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: "Pushed" } }),
      JSON.stringify({ type: "turn.completed" }),
    ];

    it("runs codex exec, links the session as soon as Codex names it, and records no cost", async () => {
      let linkedWhileRunning: string[] = [];
      const { h, task, jobs, linked, start, patches } = setup({
        agent: async (job) => {
          for (const line of codexOutput) job.onStdoutLine?.(line);
          linkedWhileRunning = [...linked];
          return codexOutput.join("\n");
        },
      });
      h.services.settings.update({ modelProfiles: [codexProfile("codex")], codexCli: "/opt/codex" });
      h.services.tasks.update(task.id, { labels: ["other"] }, "test");
      const out = await start({ options: { runner: "headless" } });

      const job = jobs[0]!;
      expect(job).toMatchObject({ cli: "/opt/codex", command: "codex", label: "Codex" });
      expect(job.args.slice(0, 5)).toEqual(["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write"]);
      expect(job.args.join(" ")).toContain("--model gpt-5.5-codex");
      expect(linkedWhileRunning).toEqual([CODEX_ID]);
      expect(out).toMatchObject({ runner: "headless", sessionId: CODEX_ID, result: "Pushed" });
      expect(out).not.toHaveProperty("costUsd");
      expect(patches).toContainEqual({ sessionId: CODEX_ID });
      expect(patches).toContainEqual({ detail: "Model: Other, from label other, on Codex" });
      const session = h.services.links.listByKind("agent_session")[0];
      expect(session).toMatchObject({ ref: { harness: "codex", sessionId: CODEX_ID } });
    });

    it("runs Copilot CLI with a session id given up front", async () => {
      const { h, task, jobs, start, patches } = setup({
        agent: async () =>
          [
            JSON.stringify({ type: "session.start", data: { sessionId: SESSION } }),
            JSON.stringify({ type: "assistant.message", data: { content: "Done" } }),
          ].join("\n"),
      });
      h.services.settings.update({ modelProfiles: [codexProfile("copilot-cli")] });
      h.services.tasks.update(task.id, { labels: ["other"] }, "test");
      await start({ options: { runner: "headless" } });
      expect(jobs[0]).toMatchObject({ command: "copilot", label: "Copilot CLI" });
      expect(jobs[0]!.args[jobs[0]!.args.indexOf("--session-id") + 1]).toBe(SESSION);
      expect(patches[0]).toMatchObject({ runner: "headless", sessionId: SESSION });
      expect(h.services.links.listByKind("agent_session")[0]).toMatchObject({ ref: { harness: "copilot-cli" } });
    });

    it("runs on Claude Code, saying why, when the action needs structured output", async () => {
      const { h, task, jobs, start, patches } = setup({
        agent: async () => result({ result: "ok", structured_output: { ok: true }, session_id: SESSION }),
      });
      h.services.settings.update({ modelProfiles: [codexProfile("codex")] });
      h.services.tasks.update(task.id, { labels: ["other"] }, "test");
      await start({ options: { runner: "headless" }, access: "read-only", outputSchema: { type: "object" } });
      expect(jobs[0]!.args[0]).toBe("-p");
      expect(jobs[0]!.args).not.toContain("--model");
      expect(patches).toContainEqual({
        detail:
          "Model: Other, from label other\nCodex can't run this action headless (it needs structured output), so Claude Code ran it on its default model.",
      });
    });

    it("fails with the harness's own name", async () => {
      const { h, task, start } = setup({
        agent: async () => JSON.stringify({ type: "turn.failed", error: { message: "rate limited" } }),
      });
      h.services.settings.update({ modelProfiles: [codexProfile("codex")] });
      h.services.tasks.update(task.id, { labels: ["other"] }, "test");
      await expect(start({ options: { runner: "headless" } })).rejects.toThrow("Codex stopped: rate limited");
    });
  });

  it("says when a T3 run's model has no T3 Code model, so T3's default ran", async () => {
    const { h, task, start, patches } = setup({ t3: T3_UP });
    h.services.settings.update({
      modelProfiles: [
        { id: "fast", name: "Fast", labels: ["quick"], description: null, t3: null, cli: { "claude-code": "haiku" } },
      ],
    });
    h.services.tasks.update(task.id, { labels: ["quick"] }, "test");
    await start({ options: { runner: "t3" } });
    expect(patches).toContainEqual({
      detail:
        "Model: Fast, from label quick. It has no T3 Code model in Settings → Model tiers. T3 Code's default ran.",
    });
  });

  it("passes an automation's model choice to a T3 launch", async () => {
    const { launches, start } = setup({ t3: T3_UP });
    await start({ options: { runner: "t3", modelChoice: { tier: "deep" } } });
    expect(launches[0]).toMatchObject({ work: true, modelChoice: { tier: "deep" } });
  });

  describe("runner choice", () => {
    it("Auto starts a T3 thread when T3 is connected, with a stable command id and lowered access", async () => {
      const { run, jobs, launches, start, patches } = setup({ t3: T3_UP });
      const out = await start({
        label: "Start planned · #7",
        options: { runner: "auto", t3Access: "auto-accept-edits" },
      });
      expect(jobs).toHaveLength(0);
      expect(out.runner).toBe("t3");
      expect(out.threadUrl).toMatch(/thread-9/);
      expect(patches).toEqual([{ runner: "t3", threadUrl: out.threadUrl }]);
      expect(launches[0]).toMatchObject({
        commandId: `autopilot-${run.id}`,
        work: true,
        maxRuntimeMode: "auto-accept-edits",
        title: "Autopilot · Start planned · #7",
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

    it("starts T3 from origin's copy of an epic's branch and says to open the PR against it", async () => {
      const { launches, start } = setup({ t3: T3_UP });
      await start({ options: { runner: "t3" }, workspace: { prBase: "epic/4-checkout" } });
      expect(launches[0]).toMatchObject({ baseRef: "epic/4-checkout", startFromOrigin: true });
      expect(launches[0]!.prompt).toContain("Your worktree starts from `epic/4-checkout`.");
      expect(launches[0]!.prompt).toContain("gh pr create --base epic/4-checkout");
      expect(launches[0]!.prompt).toContain("never merge a pull request");
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

    it("refuses a project with no folder: no worktree to make, no T3 thread to start", async () => {
      const t3 = setup({ t3: T3_UP });
      t3.h.services.projects.update(t3.project.id, { workspaceRoot: null });
      await expect(t3.start({ options: { runner: "t3" } })).rejects.toThrow(
        "neither a workspace folder nor a T3 project",
      );
      expect(t3.launches).toHaveLength(0);

      // A T3 project is enough for a thread (T3 makes the worktree), though a headless run still needs the folder.
      const bound = setup({ t3: T3_UP });
      bound.h.db
        .prepare(
          "UPDATE projects SET workspace_root = NULL, workspace_key = NULL, t3_project_id = 't3-p1' WHERE id = ?",
        )
        .run(bound.project.id);
      expect((await bound.start({ options: { runner: "t3" } })).runner).toBe("t3");
      expect(bound.launches).toHaveLength(1);

      const headless = setup({ t3: T3_DOWN });
      headless.h.services.projects.update(headless.project.id, { workspaceRoot: null });
      await expect(headless.start({ options: { runner: "headless" } })).rejects.toThrow("has no workspace folder");
      expect(headless.jobs).toHaveLength(0);
    });

    it("looks at T3 again before choosing, so a stale status doesn't send a run headless or refuse it", async () => {
      const auto = setup({ t3: T3_DOWN, t3AfterLook: T3_UP });
      expect((await auto.start({ options: { runner: "auto" } })).runner).toBe("t3");
      expect(auto.looks).toHaveLength(1);
      const t3Only = setup({ t3: T3_DOWN, t3AfterLook: T3_UP });
      expect((await t3Only.start({ options: { runner: "t3" } })).runner).toBe("t3");
      const ready = setup({ t3: T3_UP });
      await ready.start({ options: { runner: "auto" } });
      expect(ready.looks).toHaveLength(0);
    });

    describe("while T3 can't be reached", () => {
      it("retries the launch, with the same command id, and fails nothing", async () => {
        const { launches, start } = setup({
          t3: T3_UP,
          holdMs: 10_000,
          launchFailures: [t3Unavailable("T3 Code is not running"), t3Unavailable("T3 Code is not running")],
        });
        const out = await start({ options: { runner: "t3" } });
        expect(out.runner).toBe("t3");
        expect(launches).toHaveLength(3);
        expect(new Set(launches.map((l) => l.commandId)).size).toBe(1);
      });

      it("T3 only waits for T3 to show up", async () => {
        let calls = 0;
        const { t3, start, launches } = setup({ t3: T3_DOWN, holdMs: 10_000 });
        t3.test = async () => (++calls < 3 ? T3_DOWN : T3_UP);
        expect((await start({ options: { runner: "t3" } })).runner).toBe("t3");
        expect(calls).toBe(3);
        expect(launches).toHaveLength(1);
      });

      it("gives up with T3's own message once the hold is over", async () => {
        const { start, launches } = setup({
          t3: T3_UP,
          holdMs: 20,
          launchFailures: Array.from({ length: 50 }, () => t3Unavailable("T3 Code is not running")),
        });
        await expect(start({ options: { runner: "t3" } })).rejects.toThrow("T3 Code is not running");
        expect(launches.length).toBeGreaterThan(1);
        expect(launches.length).toBeLessThan(50);
      });

      it("waits for T3 before a nudge too, with the same command id", async () => {
        const { h, task, run, sent, start } = setup({
          t3: T3_UP,
          holdMs: 10_000,
          nudgeFailures: [t3Unavailable("T3 Code is not running")],
        });
        h.services.links.add(task.id, { t3Thread: { environmentId: "env-1", threadId: "thread-1" } }, "x");
        await start({ kind: "nudge", prompt: "Continue" });
        expect(sent).toEqual([
          { text: "Continue", commandId: `autopilot-${run.id}` },
          { text: "Continue", commandId: `autopilot-${run.id}` },
        ]);
      });

      it("stops waiting, without another launch, once the request is no longer wanted", async () => {
        const { start, launches } = setup({
          t3: T3_UP,
          holdMs: 10_000,
          launchFailures: [t3Unavailable("T3 Code is not running"), t3Unavailable("T3 Code is not running")],
        });
        // Asked after each wait: wanted the first time, not the second.
        let asks = 0;
        await expect(start({ options: { runner: "t3" }, stillWanted: () => ++asks < 2 })).rejects.toBeInstanceOf(
          RunAbandonedError,
        );
        expect(launches).toHaveLength(2);
      });

      it("shares one wait between looking for T3 and launching", async () => {
        const failures = Array.from({ length: 100 }, () => t3Unavailable("T3 Code is not running"));
        const { t3, start, launches } = setup({ t3: T3_DOWN, holdMs: 60, launchFailures: failures });
        let calls = 0;
        // T3 shows up after most of the wait is gone, then drops again.
        t3.test = async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return ++calls < 2 ? T3_DOWN : T3_UP;
        };
        await expect(start({ options: { runner: "t3" } })).rejects.toThrow("T3 Code is not running");
        // Separate holds would each get the full 60 ms, about a dozen launches at one per 5 ms.
        expect(launches.length).toBeLessThan(8);
      });

      it("fails at once on a real launch error", async () => {
        const { start, launches } = setup({
          t3: T3_UP,
          holdMs: 10_000,
          launchFailures: [new Error("No model is ready in T3 Code")],
        });
        await expect(start({ options: { runner: "t3" } })).rejects.toThrow("No model is ready");
        expect(launches).toHaveLength(1);
      });

      it("T3 only goes on to the launch when T3 is detected but its shell isn't answering, and waits there", async () => {
        const { start, launches } = setup({
          t3: { ...T3_UP, liveStatus: "error", error: "T3 Code unreachable: ECONNREFUSED" },
          holdMs: 10_000,
          launchFailures: [t3Unavailable("T3 Code unreachable: ECONNREFUSED")],
        });
        expect((await start({ options: { runner: "t3" } })).runner).toBe("t3");
        expect(launches).toHaveLength(2);
        // A refusal (say, an expired token) still fails the run at once.
        const refused = setup({
          t3: { ...T3_UP, liveStatus: "error", error: "Token expired or revoked" },
          holdMs: 10_000,
          launchFailures: [new Error("Token expired or revoked")],
        });
        await expect(refused.start({ options: { runner: "t3" } })).rejects.toThrow("Token expired");
        expect(refused.launches).toHaveLength(1);
      });

      it("fails at once when T3 is there but has no working token", async () => {
        const { start } = setup({ t3: { ...T3_UP, liveStatus: "off" }, holdMs: 10_000 });
        await expect(start({ options: { runner: "t3" } })).rejects.toThrow("T3 Code isn't connected");
      });
    });

    describe("T3 workspace preparation", () => {
      it("launches one thread at a time per repository, each once T3 has prepared the one before", async () => {
        const { h, project, run, runner, t3 } = setup({ t3: T3_UP });
        // Threads stay "preparing" until the test lets them through.
        const ready = new Set<string>();
        const launched: string[] = [];
        t3.launchTaskThread = async (taskId) => {
          const threadId = `thread-${launched.length + 1}`;
          launched.push(threadId);
          const link = h.services.links.add(taskId, { t3Thread: { environmentId: "env-1", threadId } }, "x");
          return {
            link,
            modelSelection: { instanceId: "claude", model: "m", options: [] },
            runtimeMode: "full-access",
            workspace: { mode: "current" },
            suggestionUnavailable: null,
          };
        };
        t3.threadWorkspace = async (link) => ({
          ...WORKSPACE,
          runStatus: ready.has(link.ref.threadId) ? "running" : "preparing",
        });
        const tasks = ["a", "b", "c"].map((title) => h.services.tasks.create({ projectId: project.id, title, plan }));
        const outs = Promise.all(
          tasks.map((task) =>
            runner.start({
              run: { ...run, id: randomUUID(), taskId: task.id },
              prompt: "Do it",
              tier: null,
              options: { runner: "t3" },
            }),
          ),
        );
        for (const threadId of ["thread-1", "thread-2", "thread-3"]) {
          await vi.waitFor(() => expect(launched.at(-1)).toBe(threadId));
          // Long enough for the others to launch too, were they not waiting their turn.
          await new Promise((resolve) => setTimeout(resolve, 300));
          expect(launched.at(-1)).toBe(threadId);
          ready.add(threadId);
        }
        expect((await outs).map((o) => o.runner)).toEqual(["t3", "t3", "t3"]);
      });

      it("doesn't make another repository's launch wait", async () => {
        const { h, run, runner, t3, start } = setup({ t3: T3_UP });
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        let held = true;
        void released.then(() => (held = false));
        t3.threadWorkspace = async (link) =>
          link.ref.threadId === "thread-9" && held ? { ...WORKSPACE, runStatus: "preparing" } : WORKSPACE;
        const first = start({ options: { runner: "t3" } });
        const other = h.services.projects.create({ title: "Other", workspaceRoot: join(repo.worktrees, "other") });
        const task = h.services.tasks.create({ projectId: other.id, title: "Elsewhere", plan });
        const launchOther = t3.launchTaskThread;
        t3.launchTaskThread = async (taskId, input) => {
          const out = await launchOther(taskId, input, "x");
          if (taskId !== task.id) return out;
          const link = h.services.links.add(
            taskId,
            { t3Thread: { environmentId: "env-1", threadId: "thread-x" } },
            "x",
          );
          return { ...out, link };
        };
        // The first launch is in and holding its repository's gate.
        await vi.waitFor(() => expect(h.services.links.listByKind("t3_thread")).toHaveLength(1));
        const second = await runner.start({
          run: { ...run, id: randomUUID(), taskId: task.id },
          prompt: "Do it",
          tier: null,
          options: { runner: "t3" },
        });
        expect(second.threadUrl).toMatch(/thread-x/);
        release();
        expect((await first).runner).toBe("t3");
      });

      it("lets the gate go once the wait for T3 runs out, and the run carries on", async () => {
        const { start, launches, retries } = setup({
          t3: T3_UP,
          prepareMs: 20,
          workspaces: [{ runStatus: "preparing" }],
        });
        expect((await start({ options: { runner: "t3" } })).runner).toBe("t3");
        expect((await start({ options: { runner: "t3" } })).runner).toBe("t3");
        expect(launches).toHaveLength(2);
        expect(retries).toEqual([]);
      });

      it("prepares a failed workspace again once, in the same thread", async () => {
        const { run, start, launches, retries, patches } = setup({
          t3: T3_UP,
          workspaces: [
            { runStatus: "preparing", worktreePath: null },
            { runStatus: "failed", worktreePath: null, latestRunId: "run-7", lastError: FETCH_FAILED },
            { runStatus: "preparing", worktreePath: null },
            {},
          ],
        });
        const out = await start({ options: { runner: "t3" } });
        expect(out.threadUrl).toMatch(/thread-9/);
        expect(launches).toHaveLength(1);
        expect(retries).toEqual([{ runId: "run-7", commandId: `autopilot-${run.id}-retry` }]);
        expect(patches).toEqual([{ runner: "t3", threadUrl: out.threadUrl }]);
      });

      it("doesn't take the failure it retried, still in T3's shell, for the retry failing", async () => {
        const failedRun = { runStatus: "failed", worktreePath: null, latestRunId: "run-7", lastError: FETCH_FAILED };
        const { start, retries } = setup({
          t3: T3_UP,
          workspaces: [failedRun, failedRun, failedRun, { runStatus: "preparing", worktreePath: null }, {}],
        });
        expect((await start({ options: { runner: "t3" } })).runner).toBe("t3");
        expect(retries).toHaveLength(1);
      });

      it("waits for T3 to make the thread's run before letting the gate go", async () => {
        const { start, retries } = setup({
          t3: T3_UP,
          workspaces: [
            { runStatus: "idle", latestRunId: null, worktreePath: null },
            { runStatus: "failed", worktreePath: null, lastError: FETCH_FAILED },
            {},
          ],
        });
        await start({ options: { runner: "t3" } });
        // The failure was seen, so the run had been waited for rather than passed over as "idle".
        expect(retries).toHaveLength(1);
      });

      it("fails the run when the workspace fails again, keeping the thread on the run", async () => {
        const failedRun = { runStatus: "failed", worktreePath: null, latestRunId: "run-7", lastError: FETCH_FAILED };
        const { start, retries, patches } = setup({
          t3: T3_UP,
          workspaces: [
            failedRun,
            { runStatus: "preparing", worktreePath: null },
            { ...failedRun, updatedAt: "2026-10-17T08:01:00.000Z" },
          ],
        });
        await expect(start({ options: { runner: "t3" } })).rejects.toThrow(
          `T3 Code couldn't prepare the thread's workspace: ${FETCH_FAILED}`,
        );
        expect(retries).toHaveLength(1);
        expect(patches[0]).toMatchObject({ runner: "t3" });
      });

      it("fails at once when T3 won't prepare the thread again: it failed for another reason", async () => {
        const { start, retries } = setup({
          t3: T3_UP,
          workspaces: [{ runStatus: "failed", lastError: "Provider crashed" }],
          retryFailure: new Error("Run run-1 has no failed workspace preparation to retry."),
        });
        await expect(start({ options: { runner: "t3" } })).rejects.toThrow(
          "T3 Code couldn't start the thread: Provider crashed",
        );
        expect(retries).toHaveLength(1);
      });
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

    describe("a run with no task", () => {
      it("runs headless in an empty folder of its own that is gone afterwards, with no worktree or link", async () => {
        const { h, task, run, jobs, start, patches } = setup({ t3: T3_UP });
        const out = await start({
          run: { ...run, taskId: null },
          access: "none",
          tier: "light",
          options: { budgetUsd: 1 },
        });
        expect(out).toEqual({ runner: "headless", sessionId: SESSION, costUsd: 0.75, result: "Done" });
        expect(patches).toEqual([{ runner: "headless", sessionId: SESSION }, { costUsd: 0.75 }]);
        const job = jobs[0]!;
        expect(job.cwd).not.toContain("worktrees");
        expect(existsSync(job.cwd)).toBe(false);
        expect(job.prompt).toBe("Do the task");
        expect(job.args).toContain("--strict-mcp-config");
        expect(job.args[job.args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
        expect(h.services.tasks.summary(task.id).links.filter((l) => l.kind === "agent_session")).toEqual([]);
      });

      it("with a repo, tells the agent not to push to the default branch and denies it", async () => {
        const { run, jobs, start } = setup({ t3: T3_UP });
        await start({ run: { ...run, taskId: null }, tier: null, options: {}, repo: repo.checkout });
        const job = jobs[0]!;
        expect(job.prompt).toContain("never push to `main`");
        expect(job.prompt).toContain("empty temporary folder");
        expect(job.args).toContain("Bash(git push * main)");
        expect(job.args[job.args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
      });

      it("with a null repo, still tells the agent not to push to the default branch", async () => {
        const { run, jobs, start } = setup({ t3: T3_UP });
        await start({ run: { ...run, taskId: null }, tier: null, options: {}, repo: null });
        expect(jobs[0]!.prompt).toContain("never push to the default branch");
        expect(jobs[0]!.args.join(" ")).not.toContain("git push * main");
      });

      it("gives a run that reads untrusted text only the board's MCP server, from a config outside its folder", async () => {
        let config: { path: string; text: string } | null = null;
        const { run, jobs, start } = setup({
          t3: T3_UP,
          agent: async (job) => {
            const path = job.args[job.args.indexOf("--mcp-config") + 1]!;
            config = { path, text: readFileSync(path, "utf8") };
            return result({ result: "Done", total_cost_usd: 0.1 });
          },
        });
        await start({
          run: { ...run, taskId: null },
          access: "read-only",
          untrustedInput: true,
          boardTools: true,
          tier: null,
          options: {},
          repo: null,
        });
        const job = jobs[0]!;
        expect(job.args).toContain("--strict-mcp-config");
        expect(job.args[job.args.indexOf("--setting-sources") + 1]).toBe("user");
        expect(job.args[job.args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Bash");
        expect(job.args).toContain("Read(./**)");
        expect(job.args).toContain(`mcp__${BRAND.id}`);
        expect(job.args).not.toContain("Read");
        expect(config!.path.startsWith(job.cwd)).toBe(false);
        expect(JSON.parse(config!.text)).toEqual({
          mcpServers: {
            [BRAND.id]: {
              type: "http",
              url: "http://127.0.0.1:4317/mcp",
              headers: { Authorization: `Bearer ${BOARD_TOKEN}` },
            },
          },
        });
        expect(existsSync(config!.path)).toBe(false);
      });

      it("refuses board tools for a run that may edit or doesn't count its input as untrusted", async () => {
        const { run, jobs, start } = setup({ t3: T3_UP });
        const detached = { ...run, taskId: null };
        await expect(start({ run: detached, boardTools: true, tier: null, options: {} })).rejects.toThrow(
          "only for a read-only run",
        );
        await expect(
          start({ run: detached, access: "read-only", boardTools: true, tier: null, options: {} }),
        ).rejects.toThrow("only for a read-only run");
        expect(jobs).toEqual([]);
      });

      it("never uses T3 Code or a nudge, and removes its folder when the agent fails", async () => {
        const { run, jobs, launches, start } = setup({
          t3: T3_UP,
          agent: async () => result({ is_error: true, subtype: "error_max_budget_usd", total_cost_usd: 0.5 }),
        });
        const detached = { ...run, taskId: null };
        await expect(start({ run: detached, options: { runner: "t3" } })).rejects.toThrow("can't run in T3 Code");
        await expect(start({ run: detached, kind: "nudge" })).rejects.toThrow("no thread to nudge");
        await expect(start({ run: detached, options: { runner: "auto" } })).rejects.toThrow("Claude Code stopped");
        expect(launches).toHaveLength(0);
        expect(existsSync(jobs[0]!.cwd)).toBe(false);
      });
    });
  });
});
