import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRAND,
  type CustomHandoff,
  type SessionLaunchOptions,
  type StartCustomHandoffResult,
  type T3LaunchWorkspace,
  type TaskLink,
} from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalPath } from "../autopilot/worktrees.ts";
import { createGitFixture, git } from "../test/gitRepo.ts";
import { createTestHarness } from "../test/harness.ts";
import { PROCESS_TEST_TIMEOUT } from "../test/timeouts.ts";
import type { TaskThreadInput } from "./t3.ts";
import type { LaunchSpec, TerminalHost } from "./terminal.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const handoff = (patch: Partial<CustomHandoff> = {}): CustomHandoff => ({
  id: "sandbox",
  name: "Sandbox check",
  prompt: "{{task}}\n\nRun the sandbox.",
  target: "t3-code",
  skipDialog: true,
  model: "inherit",
  workspace: "current",
  projectIds: null,
  ...patch,
});

/**
 * A board with T3 Code and Claude Code set up, one project in a temp folder (or `repo`) and one task. T3 launches are
 * recorded instead of opening a socket; the terminal is a POSIX one that records what it would run.
 */
function appWith(handoffs: CustomHandoff[], opts: { repo?: string; worktrees?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "handoff-"));
  dirs.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), "");
  const spawned: LaunchSpec[] = [];
  const host: TerminalHost = {
    platform: "linux",
    env: { PATH: bin },
    readFile: () => null,
    which: (name) => (name === "x-terminal-emulator" ? "/usr/bin/x-terminal-emulator" : null),
  };
  const ctx = createTestHarness({
    ...(opts.worktrees ? { worktreesDir: opts.worktrees } : {}),
    integrations: {
      terminalHost: () => host,
      spawnTerminal: (spec) => {
        spawned.push(spec);
        return Promise.resolve();
      },
    },
  });
  const s = ctx.services;
  s.settings.update({
    t3Token: "tok",
    providers: [
      { id: "t3-code", enabled: true },
      { id: "claude-code", enabled: true },
    ],
    modelTiers: {
      deep: {
        description: null,
        t3: null,
        cli: { "claude-code": "opus" },
        cliEffort: { "claude-code": "high" },
      },
    },
    customHandoffs: handoffs,
  });
  const project = s.projects.create({ title: "Alpha", workspaceRoot: opts.repo ?? root });
  const task = s.tasks.create({ projectId: project.id, title: "Work" });

  const launches: Array<{ input: TaskThreadInput; actor: string }> = [];
  /** What the fake T3 runs a launch in when the launch names no workspace. */
  const newWorktree: T3LaunchWorkspace = { mode: "new_worktree", baseRef: "main", startFromOrigin: true };
  ctx.integrations.launchT3TaskThread = (id, input, actor) => {
    launches.push({ input, actor });
    const link = s.links.add(id, { t3Thread: { environmentId: "env", threadId: `th-${launches.length}` } }, actor);
    return Promise.resolve({
      link,
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5", options: [] },
      runtimeMode: "full-access",
      workspace: input.workspace ?? { ...newWorktree, baseRef: input.baseRef ?? "main" },
      suggestionUnavailable: null,
    });
  };

  const start = async (id: string, taskId = task.id, json: Record<string, unknown> = {}) => {
    const res = await ctx.request(`/api/tasks/${taskId}/custom-handoffs/${id}`, { method: "POST", json });
    const body = (await res.json()) as StartCustomHandoffResult & { error?: { code: string; message: string } };
    return { status: res.status, body };
  };
  const sessionLinks = () =>
    s.tasks
      .summary(task.id)
      .links.filter((l): l is Extract<TaskLink, { kind: "agent_session" }> => l.kind === "agent_session");
  return { ...ctx, root, project, task, launches, spawned, start, sessionLinks };
}

describe("starting a custom hand-off as a T3 Code thread", () => {
  it("launches the rendered prompt on the hand-off's model in the project's checkout, and links the thread", async () => {
    const app = appWith([handoff({ model: { tier: "deep" } })]);
    const { status, body } = await app.start("sandbox", app.task.id, { boardUrl: "http://127.0.0.1:5317" });
    expect(status).toBe(201);
    const { input } = app.launches[0]!;
    expect(input.prompt).toBe(body.prompt);
    expect(input.prompt).toContain(`#1 "Work"\nBoard: http://127.0.0.1:5317/?task=${app.task.id}\n`);
    expect(input.prompt).toContain(`Call get_task("${app.task.id}") on the ${BRAND.id} MCP server to read it.`);
    expect(input.prompt).toContain("\n\nRun the sandbox.\n\nThis thread is already linked to the task");
    expect(input).toMatchObject({
      title: "#1 Sandbox check · Work",
      work: true,
      followUp: true,
      modelChoice: { tier: "deep" },
      workspace: { mode: "current" },
    });
    expect(body).toMatchObject({
      name: "Sandbox check",
      target: "t3-code",
      session: null,
      workspace: "current",
      fellBack: false,
      model: "claude-sonnet-5-5",
    });
    expect(body.link).toMatchObject({ kind: "t3_thread", taskId: app.task.id });
    // The deep tier has no T3 Code model here, so the thread started on T3's default: the toast says so.
    expect(body.note).toContain("The Deep tier has no T3 Code model");
  });

  it("leaves the model to the task and uses the board's own URL when the browser sends none", async () => {
    const app = appWith([handoff()]);
    const { body } = await app.start("sandbox");
    expect(app.launches[0]!.input).not.toHaveProperty("modelChoice");
    expect(body.prompt).toMatch(/Board: http:\/\/127\.0\.0\.1:\d+\/\?task=/);
    expect(body.note).toBeNull();
  });

  it("falls back to a new worktree when the task has no worktree of its own, and says so", async () => {
    const app = appWith([handoff({ workspace: "task_worktree" }), handoff({ id: "fresh", workspace: "new_worktree" })]);
    const fallback = await app.start("sandbox");
    expect(app.launches[0]!.input).not.toHaveProperty("workspace");
    expect(fallback.body).toMatchObject({ workspace: "new_worktree", branch: "main", fellBack: true });
    // Asked for a new worktree: nothing fell back.
    const fresh = await app.start("fresh");
    expect(fresh.body).toMatchObject({ workspace: "new_worktree", fellBack: false });
  });

  it("starts an integration epic's task from the epic's branch", async () => {
    const app = appWith([handoff({ workspace: "new_worktree" })]);
    const epic = app.services.tasks.create({ projectId: app.project.id, title: "Epic", kind: "epic" });
    app.services.tasks.setDelivery(epic.id, "integration", "epic/2-epic", "user");
    const child = app.services.tasks.create({ projectId: app.project.id, title: "Child", epicId: epic.id });
    await app.start("sandbox", child.id);
    expect(app.launches[0]!.input).toMatchObject({ baseRef: "epic/2-epic", startFromOrigin: true });
  });
});

describe("starting a custom hand-off as a CLI session", () => {
  it("opens the CLI with the prompt on the hand-off's model, and links the session under the hand-off's name", async () => {
    const app = appWith([handoff({ target: "claude-code", model: { tier: "deep" } })]);
    const { status, body } = await app.start("sandbox");
    expect(status).toBe(201);
    expect(body).toMatchObject({ target: "claude-code", link: null, workspace: "current", model: "opus", note: null });
    expect(body.session).toMatchObject({ launched: true, cwd: app.root });
    const command = body.session!.command;
    expect(command).toContain("--model opus --effort high");
    expect(command).toContain("Run the sandbox.");
    expect(command).toContain("already linked it to the task");
    expect(app.spawned).toHaveLength(1);
    expect(app.sessionLinks().map((l) => l.label)).toEqual(["Sandbox check on #1"]);
  });

  it("runs in the checkout when the folder isn't a repository, whatever the hand-off asked", async () => {
    const app = appWith([handoff({ target: "claude-code", workspace: "task_worktree" })]);
    const { body } = await app.start("sandbox");
    expect(body).toMatchObject({ workspace: "current", fellBack: false, model: null });
    expect(body.session?.cwd).toBe(app.root);
  });

  it("offers the hand-off's model in the dialog's launch options", async () => {
    const app = appWith([handoff({ target: "claude-code", model: { tier: "deep" } })]);
    const options = async (query: string) =>
      (await (
        await app.request(`/api/tasks/${app.task.id}/session-launch-options${query}`)
      ).json()) as SessionLaunchOptions;
    expect((await options("")).models["claude-code"]).toBeNull();
    const preset = await options("?handoff=sandbox");
    expect(preset.models["claude-code"]).toBe("opus");
    expect(preset.efforts?.["claude-code"]).toBe("high");
    expect((await app.request(`/api/tasks/${app.task.id}/session-launch-options?handoff=nope`)).status).toBe(404);
  });
});

describe("a custom hand-off in a repository", { timeout: PROCESS_TEST_TIMEOUT }, () => {
  it("makes a new worktree when the task has none and says so, then runs in the task's worktree once it has one", async () => {
    const repo = createGitFixture();
    try {
      const app = appWith([handoff({ target: "claude-code", workspace: "task_worktree" })], {
        repo: repo.checkout,
        worktrees: repo.worktrees,
      });
      const { body } = await app.start("sandbox");
      expect(body).toMatchObject({ workspace: "new_worktree", fellBack: true });
      expect(body.branch).toMatch(new RegExp(`^${BRAND.id}/1-[0-9a-f]{8}$`));
      expect(git(body.session!.cwd, "rev-parse", "HEAD")).toBe(git(repo.checkout, "rev-parse", "origin/main"));

      // That session's worktree is now the task's own: the next start runs there.
      const again = await app.start("sandbox");
      expect(again.body).toMatchObject({ workspace: "task_worktree", fellBack: false, branch: body.branch });
      // Git names the worktree its own way (long names and forward slashes on Windows), so compare the folders.
      expect(canonicalPath(again.body.session!.cwd)).toBe(canonicalPath(body.session!.cwd));

      // A T3 Code thread for the same task runs in that worktree too, on its branch.
      app.services.settings.update({
        customHandoffs: [handoff({ id: "thread", target: "t3-code", workspace: "task_worktree" })],
      });
      const thread = await app.start("thread");
      expect(app.launches[0]!.input.workspace).toMatchObject({ mode: "existing_worktree", branch: body.branch });
      const launchedIn = app.launches[0]!.input.workspace;
      expect(launchedIn?.mode === "existing_worktree" && canonicalPath(launchedIn.worktreePath)).toBe(
        canonicalPath(body.session!.cwd),
      );
      expect(thread.body).toMatchObject({ workspace: "task_worktree", fellBack: false, branch: body.branch });
    } finally {
      repo.cleanup();
    }
  });
});

describe("a custom hand-off that can't start", () => {
  const message = async (app: ReturnType<typeof appWith>, id: string, taskId?: string) => {
    const { status, body } = await app.start(id, taskId);
    return { status, message: body.error?.message };
  };

  it("is not found under an unknown id", async () => {
    const app = appWith([handoff()]);
    expect(await message(app, "nope")).toEqual({ status: 404, message: "No custom hand-off with id nope" });
    expect(app.launches).toHaveLength(0);
  });

  it("refuses a target whose provider isn't on, or is hidden from the menus", async () => {
    const app = appWith([handoff(), handoff({ id: "codex", target: "codex" })]);
    expect(await message(app, "codex")).toMatchObject({
      status: 400,
      message: expect.stringContaining("Codex isn't added and switched on"),
    });
    app.services.settings.update({ handoffMenus: { "t3-code": false } });
    expect((await message(app, "sandbox")).message).toContain("T3 Code is hidden from the hand-off menus");
    expect(app.launches).toHaveLength(0);
  });

  it("refuses a CLI that isn't installed, before anything is started", async () => {
    const app = appWith([handoff({ target: "codex" })]);
    app.services.settings.update({
      providers: [
        { id: "claude-code", enabled: true },
        { id: "codex", enabled: true },
      ],
    });
    expect((await message(app, "sandbox")).message).toContain("Codex isn't installed");
    expect(app.spawned).toHaveLength(0);
  });

  it("refuses a project it isn't shown on, an epic and a manual task", async () => {
    const app = appWith([handoff({ projectIds: ["another-project"] }), handoff({ id: "all" })]);
    expect((await message(app, "sandbox")).message).toContain("isn't shown on this task's project");
    const epic = app.services.tasks.create({ projectId: app.project.id, title: "Epic", kind: "epic" });
    expect((await message(app, "all", epic.id)).message).toContain("is an epic");
    const manual = app.services.tasks.create({ projectId: app.project.id, title: "Call", manual: true });
    expect((await message(app, "all", manual.id)).message).toContain("is a manual task");
    expect(app.launches).toHaveLength(0);
  });
});
