import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, type PrSnapshot, type StartSessionResult, type TaskLink } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createGitFixture, git } from "../test/gitRepo.ts";
import { createTestHarness } from "../test/harness.ts";
import { PROCESS_TEST_TIMEOUT } from "../test/timeouts.ts";
import { remoteRepo, shortPrompt } from "./sessionLaunch.ts";
import { cmdQuote, shQuote, type LaunchSpec, type TerminalHost } from "./terminal.ts";

const WT_SETTINGS = JSON.stringify({
  defaultProfile: "{cmd}",
  profiles: {
    list: [
      { guid: "{cmd}", name: "Command Prompt", commandline: "%SystemRoot%\\System32\\cmd.exe" },
      { guid: "{bash}", name: "Git Bash", commandline: "C:\\Git\\bin\\bash.exe" },
    ],
  },
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A board whose project folder is a temp dir, with `claude` (and `copilot` unless left out) on PATH. */
function appWith(
  opts: { host?: Partial<TerminalHost>; copilot?: boolean; repo?: string; spawnError?: Error; worktrees?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "launch-"));
  dirs.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), "");
  if (opts.copilot !== false) writeFileSync(join(bin, "copilot"), "");
  const spawned: LaunchSpec[] = [];
  const host: TerminalHost = {
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Local", PATH: bin, PATHEXT: ".EXE" },
    readFile: (path) => (path.includes("Microsoft.WindowsTerminal_") ? WT_SETTINGS : null),
    which: (name) => (name === "wt.exe" ? "C:\\WindowsApps\\wt.exe" : null),
    ...opts.host,
  };
  const ctx = createTestHarness({
    ...(opts.worktrees ? { worktreesDir: opts.worktrees } : {}),
    integrations: {
      terminalHost: () => host,
      spawnTerminal: (spec) => {
        spawned.push(spec);
        return opts.spawnError ? Promise.reject(opts.spawnError) : Promise.resolve();
      },
    },
  });
  const s = ctx.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: opts.repo ?? root });
  const task = s.tasks.create({ projectId: project.id, title: "Work" });
  const start = async (input: Record<string, unknown>) => {
    const res = await ctx.request(`/api/tasks/${task.id}/sessions`, {
      method: "POST",
      json: {
        harness: "claude-code",
        mode: "work",
        prompt: "Go",
        model: null,
        workspace: { mode: "current" },
        ...input,
      },
    });
    return { status: res.status, body: (await res.json()) as StartSessionResult };
  };
  const sessionLinks = () =>
    s.tasks
      .summary(task.id)
      .links.filter((l): l is Extract<TaskLink, { kind: "agent_session" }> => l.kind === "agent_session");
  return { ...ctx, root, spawned, task, start, sessionLinks };
}

const WINDOW = `${BRAND.id}-1`;

describe("starting a session from the board", () => {
  it("opens Claude Code in the task's Windows Terminal window with the prompt as one argument, and links it", async () => {
    const app = appWith();
    const { status, body } = await app.start({ prompt: "Work on #1.\nThen tell me.", model: "opus" });
    expect(status).toBe(201);
    expect(body).toMatchObject({ launched: true, cwd: app.root, branch: null, shortPrompt: null, error: null });

    const [link] = app.sessionLinks();
    expect(link).toMatchObject({
      label: "Implementing #1",
      window: WINDOW,
      ref: { harness: "claude-code", cwd: app.root },
    });
    expect(body.linkId).toBe(link!.id);
    const id = link!.ref.sessionId;
    expect(app.spawned).toEqual([
      {
        file: "wt.exe",
        args: [
          "-w",
          WINDOW,
          "new-tab",
          "-p",
          "{cmd}",
          "-d",
          app.root,
          "%SystemRoot%\\System32\\cmd.exe",
          "/k",
          "claude",
          "--model",
          "opus",
          "--session-id",
          id,
          "--name",
          "Implementing #1",
          "--",
          // Line breaks become spaces on Windows; the session reads the prompt the same.
          "Work on #1. Then tell me.",
        ],
        cwd: app.root,
      },
    ]);
    expect(body.command).toBe(
      `cd /d ${cmdQuote(app.root)} && claude --model opus --session-id ${id} --name "Implementing #1" -- "Work on #1. Then tell me."`,
    );
  });

  it("starts Copilot CLI with -i, labels a planning session and lets the task's other sessions share its window", async () => {
    const app = appWith();
    await app.start({});
    await app.start({ harness: "copilot-cli", mode: "plan", prompt: "Plan it" });
    const [, planning] = app.sessionLinks();
    expect(planning).toMatchObject({ label: "Planning #1", window: WINDOW, ref: { harness: "copilot-cli" } });
    expect(app.spawned[1]!.args.slice(0, 2)).toEqual(["-w", WINDOW]);
    expect(app.spawned[1]!.args.slice(-7)).toEqual([
      "copilot",
      "--session-id",
      planning!.ref.sessionId,
      "--name",
      "Planning #1",
      "-i",
      "Plan it",
    ]);
  });

  it("starts the CLI set in Settings rather than the one on PATH", async () => {
    const app = appWith({ host: { platform: "linux", which: () => "/usr/bin/xterm", readFile: () => null } });
    const own = join(app.root, "bin", "claude");
    app.services.settings.update({ headlessReviewCli: own });
    await app.start({});
    expect(app.spawned[0]!.args.at(-1)).toContain(`${shQuote(own)} --session-id`);
  });

  it("passes a POSIX prompt as written, quoted once for bash", async () => {
    const app = appWith({ host: { platform: "linux", which: () => "/usr/bin/xterm", readFile: () => null } });
    await app.start({ prompt: `It's "fine": $(rm -rf /); 100%\nnext` });
    const script = app.spawned[0]!.args.at(-1)!;
    expect(script).toContain(`'It'\\''s "fine": $(rm -rf /); 100%\nnext'`);
    // A terminal that isn't Windows Terminal can't be brought back, so no window is recorded.
    expect(app.sessionLinks()[0]!.window).toBeUndefined();
  });

  it("points an epic's short prompt at its orchestrating prompt", () => {
    const text = shortPrompt("orchestrate", { id: "epic-1", number: 7 }, "linux");
    expect(text).toContain("Let's run the epic #7");
    expect(text).toContain('get_handoff_prompt(task: "epic-1", mode: "orchestrate")');
    expect(shortPrompt("work", { id: "t-1", number: 8 }, "linux")).toContain('get_task("t-1")');
  });

  it("falls back to a short prompt when the prompt can't go on a Windows command line", async () => {
    const app = appWith();
    const { body } = await app.start({ prompt: "Use %PATH% here" });
    expect(body.shortReason).toMatch(/contains %/);
    expect(body.shortPrompt).toBe(shortPrompt("work", app.task, "win32"));
    // Windows Terminal is given every `;` as `\;`, which it passes on as `;`.
    expect(app.spawned[0]!.args.at(-1)).toBe(body.shortPrompt!.replaceAll(";", "\\;"));
    expect(body.shortPrompt).not.toContain('"');
  });

  it("falls back to a short prompt when the prompt is too long for cmd", async () => {
    const app = appWith();
    const { body } = await app.start({ prompt: "word ".repeat(2000) });
    expect(body.shortReason).toMatch(/too long/);
    expect(app.spawned[0]!.args.at(-1)).toMatch(/^Let's work on #1 from the/);
    expect(app.sessionLinks()).toHaveLength(1);
  });

  it("returns the command to run by hand, and links its session without a window, when the terminal won't start", async () => {
    const app = appWith({ spawnError: new Error("spawn wt.exe ENOENT") });
    const { status, body } = await app.start({});
    expect(status).toBe(201);
    expect(body).toMatchObject({ launched: false });
    expect(body.error).toMatch(/ENOENT/);
    // The prompt tells the agent the board linked it, so the board does, with the id the command carries.
    const [link] = app.sessionLinks();
    expect(body.linkId).toBe(link!.id);
    expect(body.command).toContain(`claude --session-id ${link!.ref.sessionId}`);
    expect(link).toMatchObject({ label: "Implementing #1", ref: { cwd: app.root } });
    expect(link!.window).toBeUndefined();
  });

  it("passes Claude Code a prompt starting with - after --, so it isn't read as an option", async () => {
    const app = appWith({ host: { platform: "linux", which: () => "/usr/bin/xterm", readFile: () => null } });
    await app.start({ prompt: "- fix the bug" });
    expect(app.spawned[0]!.args.at(-1)).toContain(`--name 'Implementing #1' -- '- fix the bug'; exec bash`);
  });

  it("refuses before making a worktree when there is no terminal to open", async () => {
    const app = appWith({ host: { platform: "linux", which: () => null, readFile: () => null } });
    const { status, body } = await app.start({ workspace: { mode: "new_worktree", baseRef: "main" } });
    expect(status).toBe(400);
    // The project folder isn't a repository, so reaching git would have failed with another message.
    expect((body as unknown as { error: { message: string } }).error.message).toMatch(/^No terminal to open/);
    expect(app.sessionLinks()).toHaveLength(0);
  });

  it("refuses a CLI that isn't installed, a bad model and a mode that doesn't fit", async () => {
    const app = appWith({ copilot: false });
    expect((await app.start({ harness: "copilot-cli" })).status).toBe(400);
    expect((await app.start({ model: "opus; calc" })).status).toBe(400);
    expect((await app.start({ mode: "orchestrate" })).status).toBe(400);
    const epic = app.services.tasks.create({ projectId: app.task.projectId, title: "Epic", kind: "epic" });
    const res = await app.request(`/api/tasks/${epic.id}/sessions`, {
      method: "POST",
      json: { harness: "claude-code", mode: "work", prompt: "Go", model: null, workspace: { mode: "current" } },
    });
    expect(res.status).toBe(400);
    expect(app.spawned).toHaveLength(0);
  });

  it("starts an epic's orchestrating session and links it to the epic", async () => {
    const app = appWith();
    const epic = app.services.tasks.create({ projectId: app.task.projectId, title: "Epic", kind: "epic" });
    const res = await app.request(`/api/tasks/${epic.id}/sessions`, {
      method: "POST",
      json: {
        harness: "claude-code",
        mode: "orchestrate",
        prompt: "Run it",
        model: null,
        workspace: { mode: "current" },
      },
    });
    expect(res.status).toBe(201);
    const links = app.services.tasks.summary(epic.id).links;
    expect(links).toMatchObject([{ kind: "agent_session", label: `Orchestrating #${epic.number}` }]);
    expect(app.spawned).toHaveLength(1);
  });

  it("lists which CLIs are installed", async () => {
    const app = appWith({ copilot: false });
    const res = await app.request("/api/agent-clis");
    expect(await res.json()).toEqual([
      { harness: "claude-code", available: true, path: join(app.root, "bin", "claude") },
      { harness: "copilot-cli", available: false, path: null },
    ]);
  });

  it("offers the tier's CLI model and the checkout when the folder isn't a repository", async () => {
    const app = appWith();
    app.services.settings.update({
      modelTiers: { deep: { description: null, t3: null, cli: { "claude-code": "opus", "copilot-cli": " " } } },
    });
    app.services.tasks.update(app.task.id, { suggestedModel: { tier: "deep" } }, "u");
    const res = await app.request(`/api/tasks/${app.task.id}/session-launch-options`);
    expect(await res.json()).toMatchObject({
      workspaceRoot: app.root,
      isRepo: false,
      branches: [],
      defaultBaseRef: null,
      models: { "claude-code": "opus", "copilot-cli": null },
      tier: "deep",
      model: { name: "Deep", source: "tier", label: null },
      namedWindow: true,
    });
  });

  it("offers the model a task label picks over its tier, and says which label", async () => {
    const app = appWith();
    app.services.settings.update({
      modelTiers: { deep: { description: null, t3: null, cli: { "claude-code": "opus" } } },
      modelProfiles: [
        { id: "fast", name: "Fast", labels: ["quick"], description: null, t3: null, cli: { "copilot-cli": "gpt-5" } },
      ],
    });
    app.services.tasks.update(app.task.id, { suggestedModel: { tier: "deep" }, labels: ["quick"] }, "u");
    const res = await app.request(`/api/tasks/${app.task.id}/session-launch-options`);
    expect(await res.json()).toMatchObject({
      models: { "claude-code": null, "copilot-cli": "gpt-5" },
      tier: "deep",
      model: { name: "Fast", source: "label", label: "quick" },
    });
  });

  it("won't save a tier's CLI model that isn't a model name", () => {
    const app = appWith();
    expect(() =>
      app.services.settings.update({
        modelTiers: { light: { description: null, t3: null, cli: { "claude-code": "haiku && calc" } } },
      }),
    ).toThrow(/Not a model name/);
  });
});

describe("starting a session in a new worktree", { timeout: PROCESS_TEST_TIMEOUT }, () => {
  it("branches from the chosen ref and runs the session there", async () => {
    const repo = createGitFixture();
    try {
      const app = appWith({ repo: repo.checkout, worktrees: repo.worktrees });
      const options = (await (await app.request(`/api/tasks/${app.task.id}/session-launch-options`)).json()) as {
        isRepo: boolean;
        branches: string[];
        defaultBaseRef: string;
      };
      expect(options.isRepo).toBe(true);
      expect(options.branches).toEqual(expect.arrayContaining(["main", "origin/main", "origin/feature"]));
      // Origin's copy, which Autopilot's worktrees start from too: the local branch can be behind.
      expect(options.defaultBaseRef).toBe("origin/main");

      const { body } = await app.start({ workspace: { mode: "new_worktree", baseRef: "origin/feature" } });
      expect(body.launched).toBe(true);
      expect(body.branch).toMatch(new RegExp(`^${BRAND.id}/1-[0-9a-f]{8}$`));
      expect(existsSync(body.cwd)).toBe(true);
      expect(body.cwd.startsWith(join(repo.worktrees, "sessions"))).toBe(true);
      expect(git(body.cwd, "rev-parse", "HEAD")).toBe(git(repo.checkout, "rev-parse", "origin/feature"));
      expect(app.spawned[0]!.cwd).toBe(body.cwd);
      expect(app.sessionLinks()[0]!.ref.cwd).toBe(body.cwd);
    } finally {
      repo.cleanup();
    }
  });

  it("works on a pull request's own branch to fix it, and only on a branch the task's open PR has", async () => {
    const repo = createGitFixture();
    try {
      const app = appWith({ repo: repo.checkout, worktrees: repo.worktrees });
      const prSnapshot = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
        state: "open",
        title: "Add the feature",
        checks: "failing",
        reviewDecision: null,
        mergeable: "mergeable",
        headRef: "feature",
        updatedAt: null,
        headOid: git(repo.checkout, "rev-parse", "origin/feature"),
        ...over,
      });
      const fix = { mode: "fix", workspace: { mode: "pr_branch", branch: "feature" } };

      // No PR on the task: nothing to push to, so nothing is made.
      const none = await app.start(fix);
      expect(none.status).toBe(400);
      expect(app.sessionLinks()).toEqual([]);

      const added = app.services.links.add(app.task.id, { value: "https://github.com/acme/app/pull/7" }, "agent");
      app.services.links.setSnapshot(added.id, prSnapshot());
      const { status, body } = await app.start(fix);
      expect(status).toBe(201);
      expect(body.launched).toBe(true);
      // Origin's copy of the PR's branch, on a local branch of its own that tracks nothing, so a bare push can't land on it.
      expect(git(body.cwd, "rev-parse", "HEAD")).toBe(git(repo.checkout, "rev-parse", "origin/feature"));
      expect(body.branch).toMatch(new RegExp(`^${BRAND.id}/1-[0-9a-f]{8}$`));
      expect(body.cwd.startsWith(join(repo.worktrees, "sessions"))).toBe(true);
      expect(app.sessionLinks()[0]).toMatchObject({ label: "Fixing the PR of #1", ref: { cwd: body.cwd } });

      // A PR in another repository than origin's isn't one of this checkout's branches, whatever it is called here.
      // (Refused before any worktree is made, so nothing reaches the network.)
      const originUrl = git(repo.checkout, "remote", "get-url", "origin");
      git(repo.checkout, "remote", "set-url", "origin", "https://github.com/acme/other.git");
      expect((await app.start(fix)).status).toBe(400);
      git(repo.checkout, "remote", "set-url", "origin", originUrl);

      // A branch the task's PRs don't have, a merged PR and the default branch are refused.
      expect((await app.start({ ...fix, workspace: { mode: "pr_branch", branch: "other" } })).status).toBe(400);
      app.services.links.setSnapshot(added.id, prSnapshot({ state: "merged" }));
      expect((await app.start(fix)).status).toBe(400);
      app.services.links.setSnapshot(added.id, prSnapshot({ headRef: "main" }));
      const onDefault = await app.start({ ...fix, workspace: { mode: "pr_branch", branch: "main" } });
      expect(onDefault.status).toBe(400);
    } finally {
      repo.cleanup();
    }
  });
});

describe("remoteRepo", () => {
  it("reads the host and repository of the URL forms git remotes use", () => {
    const want = { host: "github.com", repo: "acme/app" };
    expect(remoteRepo("https://github.com/acme/app.git")).toEqual(want);
    expect(remoteRepo("https://user:token@GitHub.com/Acme/App/")).toEqual(want);
    expect(remoteRepo("git@github.com:acme/app.git")).toEqual(want);
    expect(remoteRepo("ssh://git@github.com:22/acme/app")).toEqual(want);
    expect(remoteRepo("https://github.example.io/acme/app")).toEqual({ host: "github.example.io", repo: "acme/app" });
    // A local path names no repository to compare with.
    expect(remoteRepo(String.raw`C:\Users\me\origin.git`)).toBeNull();
    expect(remoteRepo("/srv/git/app.git")).toBeNull();
  });
});

describe("shortPrompt for a fix", () => {
  it("names the PR's branch and keeps the safety rules", () => {
    const text = shortPrompt("fix", { id: "t-1", number: 78 }, "linux", "feat/x");
    expect(text).toContain("fix the pull request on branch feat/x of #78");
    expect(text).toContain(`get_task("t-1")`);
    expect(text).toContain("Never force-push, never push to the default branch and never merge");
  });
});

describe("starting a planning session from the board", () => {
  const sessionLinksOf = (app: ReturnType<typeof appWith>, taskId: string) =>
    app.services.tasks
      .summary(taskId)
      .links.filter((l): l is Extract<TaskLink, { kind: "agent_session" }> => l.kind === "agent_session");

  const plan = async (app: ReturnType<typeof appWith>, input: Record<string, unknown>) => {
    const res = await app.request(`/api/projects/${app.task.projectId}/plan-session`, {
      method: "POST",
      json: { harness: "claude-code", prompt: "Plan them", model: null, ...input },
    });
    return { status: res.status, body: (await res.json()) as StartSessionResult & { error?: unknown } };
  };

  it("runs in the project's checkout and links the one session to every task", async () => {
    const app = appWith();
    const second = app.services.tasks.create({ projectId: app.task.projectId, title: "More" });
    const { status, body } = await plan(app, { taskIds: [app.task.id, `#${second.number}`] });
    expect(status).toBe(201);
    expect(body).toMatchObject({ launched: true, cwd: app.root, branch: null, shortPrompt: null });
    const [first] = sessionLinksOf(app, app.task.id);
    const [other] = sessionLinksOf(app, second.id);
    expect(first).toMatchObject({ label: "Planning #1, #2", window: WINDOW, ref: { cwd: app.root } });
    expect(other!.ref.sessionId).toBe(first!.ref.sessionId);
    expect(body.linkId).toBe(first!.id);
    expect(app.spawned).toHaveLength(1);
    expect(app.spawned[0]!.args).toContain("Planning #1, #2");
  });

  it("starts nothing when a task can't be planned there", async () => {
    const app = appWith();
    const planned = app.services.tasks.create({ projectId: app.task.projectId, title: "Planned" });
    app.services.plans.setPlan(planned.id, { phases: [{ title: "x", steps: [{ title: "y" }] }] }, "user");
    app.services.tasks.move(planned.id, { status: "planned" }, "user");
    const epic = app.services.tasks.create({ projectId: app.task.projectId, title: "Epic", kind: "epic" });
    const elsewhere = app.services.projects.create({ title: "Beta" });
    const foreign = app.services.tasks.create({ projectId: elsewhere.id, title: "Foreign" });
    for (const id of [planned.id, epic.id, foreign.id]) {
      const { status } = await plan(app, { taskIds: [app.task.id, id] });
      expect(status).toBe(400);
    }
    expect(app.spawned).toHaveLength(0);
    expect(sessionLinksOf(app, app.task.id)).toHaveLength(0);
  });

  it("falls back to a short prompt that fetches the planning prompt over MCP", async () => {
    const app = appWith();
    const { body } = await plan(app, { taskIds: [app.task.id], prompt: "word ".repeat(2000) });
    expect(body.shortReason).toMatch(/too long/);
    // Windows command lines get single quotes for double ones.
    expect(body.shortPrompt).toContain("get_handoff_prompt(tasks: ['#1'], mode: 'plan')");
    expect(sessionLinksOf(app, app.task.id)).toHaveLength(1);
  });
});
