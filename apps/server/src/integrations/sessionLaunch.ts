import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_HARNESSES,
  AgentHarness,
  BRAND,
  handoffModeError,
  isAbsolutePath,
  newSessionArgv,
  planningSessionLabel,
  planTasksShortPrompt,
  sessionLabel,
  StartPlanningSessionInput as StartPlanningSessionInputSchema,
  StartSessionInput as StartSessionInputSchema,
  taskWindowName,
  profileCliEffort,
  profileCliModel,
  resolveTaskModel,
  type AgentCliStatus,
  type AppSettings,
  type CliEffort,
  cliEffortFor,
  type SessionLaunchOptions,
  type StartPlanningSessionInput,
  type StartSessionInput,
  type StartSessionResult,
  type TaskSummary,
  withAttachedImages,
} from "@repo/contracts";
import { createWorktree, defaultBranchOf } from "../autopilot/worktrees.ts";
import { AppError } from "../errors.ts";
import { tasksToPlan } from "../services/planning.ts";
import type { Services } from "../services/types.ts";
import type { RunGit } from "./backup.ts";
import { resolveExecutable } from "./claudeCli.ts";
import { messageOf } from "./github.ts";
import {
  copyCommand,
  displayLaunch,
  fitsCommandLine,
  resolveTerminal,
  textArgument,
  type LaunchSpec,
  type ResolvedTerminal,
  type SpawnTerminal,
  type TerminalHost,
} from "./terminal.ts";
import type { Logger } from "./util.ts";

// Starting a new Claude Code or Copilot CLI session on a task: the CLI opens in a terminal with the hand-off prompt as
// its first message, in a new worktree or the project's checkout, and the board links the session straight away. See
// docs/features/agent-sessions.md and ADR 0009.

/** The new worktrees' branches: `<brand>/<task#>-<id>`, apart from Autopilot's. */
const SESSION_BRANCH_PREFIX = `${BRAND.id}/`;

export interface SessionLaunchIntegration {
  /** Whether each harness's CLI can be started here. */
  clis(): AgentCliStatus[];
  /** What the launch dialog offers for a task: CLIs, branches, the tier's models. */
  options(taskId: string): Promise<SessionLaunchOptions>;
  /**
   * Makes the worktree when asked, opens the CLI in a terminal and links the session. A terminal that won't start
   * isn't an error: the result carries the command to run by hand, and nothing is linked.
   */
  start(taskId: string, input: StartSessionInput, actor: string): Promise<StartSessionResult>;
  /** The same for a session that plans several of a project's tasks: in the project's checkout, linked to each. */
  startPlanning(projectId: string, input: StartPlanningSessionInput, actor: string): Promise<StartSessionResult>;
}

type SessionServices = Pick<Services, "tasks" | "projects" | "links" | "settings" | "attachments">;

/** An image pasted into the launch dialog, where the CLI can open it. */
type LaunchImage = { filename: string; path: string };

/** The CLI a harness runs: the path set in Settings, else its name on PATH. */
const configuredCli = (settings: AppSettings, harness: AgentHarness): string =>
  (harness === "claude-code" ? settings.headlessReviewCli : settings.copilotCli) ?? AGENT_HARNESSES[harness].cli;

/**
 * The first message when the prompt can't go on the command line: a pointer to the task, made from the stored task
 * alone, which every shell can take (no `%`, and textArgument handles the rest).
 */
export function shortPrompt(
  mode: StartSessionInput["mode"],
  task: { id: string; number: number },
  platform: NodeJS.Platform,
  /** The pull request's branch, for a fix. */
  branch?: string,
  /** Pasted images, pointed at after the text: the full prompt, which also has them, is only on the clipboard. */
  images: readonly LaunchImage[] = [],
): string {
  const verb = mode === "plan" ? "Let's plan" : mode === "orchestrate" ? "Let's run the epic" : "Let's work on";
  // An epic's steps live only in its orchestrating prompt, which get_task doesn't carry.
  const first =
    mode === "orchestrate"
      ? `call get_handoff_prompt(task: "${task.id}", mode: "orchestrate") on the ${BRAND.id} MCP server first and follow it.`
      : `call get_task("${task.id}") on the ${BRAND.id} MCP server first.`;
  const text =
    (mode === "fix"
      ? `Let's fix the pull request on branch ${branch ?? "(see the task)"} of #${task.number}`
      : `${verb} #${task.number}`) +
    ` from the ${BRAND.id} task board: ${first} The board started this session and already ` +
    "linked it to the task; don't link it again." +
    (mode === "fix"
      ? ` Fix its failing checks, merge conflicts or requested changes, and push to that branch. Never force-push, never push to the default branch and never merge.`
      : "");
  return fitShort(withAttachedImages(text, images), platform);
}

/** A short prompt as this command line takes it. */
function fitShort(text: string, platform: NodeJS.Platform): string {
  const fitted = textArgument(text, platform);
  if ("error" in fitted) throw new Error(`The short prompt can't go on a command line: ${fitted.error}`);
  return fitted.value;
}

/**
 * The host and repository an `origin` URL names (`https://github.com/acme/app.git`, `git@github.com:acme/app`),
 * lower-cased, or null for anything else (a local path): then there is nothing to compare a PR's repository with.
 */
export function remoteRepo(url: string): { host: string; repo: string } | null {
  const match =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(url) ??
    /^[^@/\s]+@([^:/\s]+):(.+?)(?:\.git)?\/?$/.exec(url);
  return match ? { host: match[1]!.toLowerCase(), repo: match[2]!.toLowerCase() } : null;
}

/**
 * The head branches of the task's open or draft pull requests in this repository: the ones a fix may push to. A PR in
 * another repository than `origin`'s (when that can be told) has its own branches, whatever they are called here.
 */
const prBranches = (task: TaskSummary, origin: { host: string; repo: string } | null): string[] =>
  task.links.flatMap((link) =>
    link.kind === "pr" &&
    (link.snapshot?.state === "open" || link.snapshot?.state === "draft") &&
    !link.snapshot.isCrossRepository &&
    link.snapshot.headRef &&
    (!origin ||
      (link.ref && link.ref.host.toLowerCase() === origin.host && link.ref.repo.toLowerCase() === origin.repo))
      ? [link.snapshot.headRef]
      : [],
  );

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The effort a launch asked for, when the harness's CLI takes it. Refused otherwise: it would only fail in the terminal. */
function launchEffort(harness: AgentHarness, effort: CliEffort | null | undefined): CliEffort | null {
  if (!effort) return null;
  const level = cliEffortFor(harness, effort);
  if (!level) throw new AppError("VALIDATION", `${AGENT_HARNESSES[harness].label} has no effort ${effort}`);
  return level;
}

export function createSessionLaunch(deps: {
  services: () => SessionServices;
  host: () => TerminalHost;
  spawn: SpawnTerminal;
  runGit: RunGit;
  /** Where the board keeps worktrees; sessions' go in its `sessions` folder. */
  worktreesDir: string;
  /** Refreshes a new session link's status, so the card shows it without waiting for the poll. */
  linked?: (linkId: string) => void;
  log?: Logger;
}): SessionLaunchIntegration {
  const log = deps.log ?? console;

  const cliStatus = (settings: AppSettings, harness: AgentHarness, h: TerminalHost): AgentCliStatus => {
    const path = resolveExecutable(configuredCli(settings, harness), h.env, h.platform);
    return { harness, available: path !== null, path };
  };

  const clis = (): AgentCliStatus[] => {
    const settings = deps.services().settings.get();
    const h = deps.host();
    return AgentHarness.options.map((harness) => cliStatus(settings, harness, h));
  };

  const terminal = (settings: AppSettings, h: TerminalHost): ResolvedTerminal | { error: string } => {
    try {
      return resolveTerminal(settings.terminal, h, settings.terminalOpenIn);
    } catch (error) {
      return { error: messageOf(error) };
    }
  };

  /** The folder a project lives in, which every launch starts from, or null when it has none on this machine. */
  const projectRoot = (projectId: string): string | null => {
    const root = deps.services().projects.get(projectId).workspaceRoot;
    return root && isAbsolutePath(root) && isDirectory(root) ? root : null;
  };

  /** The task and the folder its project lives in. */
  const subject = (taskId: string) => {
    const task = deps.services().tasks.summary(taskId);
    return { task, root: projectRoot(task.projectId) };
  };

  /** Local branches, then origin's (without origin/HEAD). Empty when the folder isn't a repository. */
  const branchesOf = async (root: string): Promise<{ isRepo: boolean; branches: string[] }> => {
    const top = await deps.runGit(["rev-parse", "--show-toplevel"], root).catch(() => null);
    if (top?.code !== 0) return { isRepo: false, branches: [] };
    const refs = await deps.runGit(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"],
      root,
    );
    const names = refs.code === 0 ? refs.stdout.split("\n").map((l) => l.trim()) : [];
    return { isRepo: true, branches: names.filter((n) => n && n !== "origin" && n !== "origin/HEAD") };
  };

  /** The harness's CLI and a terminal to open it in, or why a session can't start. */
  const prepare = (harnessId: AgentHarness) => {
    const settings = deps.services().settings.get();
    const h = deps.host();
    const cli = cliStatus(settings, harnessId, h);
    if (!cli.available) {
      throw new AppError(
        "VALIDATION",
        `${AGENT_HARNESSES[harnessId].label} isn't installed: set its path in Settings → Integrations`,
      );
    }

    // The configured path when one is set; the bare name otherwise, so the terminal's own PATH finds it.
    const exe = configuredCli(settings, harnessId);
    // Checked before any worktree is made, so a terminal that can't run leaves nothing behind.
    const resolved = terminal(settings, h);
    if (!("launch" in resolved)) throw new AppError("VALIDATION", `No terminal to open: ${resolved.error}`);
    // cmd reads a quoted first word as the whole line's quotes and strips them, breaking the rest.
    if (resolved.shell === "cmd" && /\s/.test(exe)) {
      throw new AppError("VALIDATION", `Command Prompt can't start a CLI whose path has spaces (${exe})`);
    }
    return { harness: harnessId, h, exe, resolved };
  };

  /** Opens the CLI in a terminal and links the session to each of `taskIds`. */
  const launch = async (
    { harness, h, exe, resolved }: ReturnType<typeof prepare>,
    session: {
      sessionId: string;
      model: string | null;
      effort: CliEffort | null;
      prompt: string;
      cwd: string;
      branch: string | null;
      label: string;
      /** The task whose named window the session opens in. */
      windowTask: number;
      /** A pointer to the work that any command line takes, for when the prompt doesn't fit. */
      short: (platform: NodeJS.Platform) => string;
      taskIds: readonly string[];
      actor: string;
    },
  ): Promise<StartSessionResult> => {
    const { sessionId, cwd, label } = session;
    const argvFor = (prompt: string) => {
      const argv = newSessionArgv({
        harness,
        sessionId,
        model: session.model,
        effort: session.effort,
        name: label,
        prompt,
      });
      return [exe, ...argv.slice(1)];
    };
    const window = resolved.focus ? taskWindowName(session.windowTask) : undefined;

    // The prompt as it can go on this command line, else a short one built from the task alone (the web app copies
    // the full prompt to the clipboard instead).
    const fitted = textArgument(session.prompt, h.platform);
    const short = () => session.short(h.platform);
    let shortReason = "error" in fitted ? `The prompt couldn't go on the command line: ${fitted.error}.` : null;
    let argv = argvFor("value" in fitted ? fitted.value : short());
    let spec: LaunchSpec | null = null;
    let launchError: string | null = null;
    try {
      spec = resolved.launch(argv, cwd, window ? { window } : {});
      if (!fitsCommandLine(spec, h.platform) && !shortReason) {
        shortReason = "The prompt is too long for the command line.";
        argv = argvFor(short());
        spec = resolved.launch(argv, cwd, window ? { window } : {});
      }
    } catch (error) {
      // A folder this terminal can't be given safely: the command can still be run by hand.
      spec = null;
      launchError = messageOf(error);
    }
    const result = {
      command: copyCommand(resolved.shell, argv, cwd),
      cwd,
      branch: session.branch,
      shortPrompt: shortReason ? argv.at(-1)! : null,
      shortReason,
    };
    // Linked whether or not the terminal starts: the prompt tells the agent the board linked it, and the command
    // to run by hand carries the same session id. Only a launched session has a window to bring back.
    const link = (opened: boolean) => {
      const ids = session.taskIds.map((taskId) => {
        const added = deps
          .services()
          .links.add(
            taskId,
            { agentSession: { harness, sessionId, cwd }, label },
            session.actor,
            opened && window ? { window } : {},
          );
        deps.linked?.(added.id);
        return added.id;
      });
      return ids[0]!;
    };
    if (!spec) return { ...result, launched: false, error: launchError, linkId: link(false) };

    try {
      await deps.spawn(spec);
    } catch (error) {
      log.warn(`[sessions] couldn't start ${displayLaunch(spec, h.platform)}: ${messageOf(error)}`);
      return {
        ...result,
        launched: false,
        error: `Couldn't start ${resolved.label}: ${messageOf(error)}`,
        linkId: link(false),
      };
    }
    return { ...result, launched: true, error: null, linkId: link(true) };
  };

  return {
    clis,

    async options(taskId) {
      const { task, root } = subject(taskId);
      const settings = deps.services().settings.get();
      const h = deps.host();
      const { isRepo, branches } = root ? await branchesOf(root) : { isRepo: false, branches: [] };
      const defaultBranch = isRepo && root ? await defaultBranchOf(deps.runGit, root).catch(() => null) : null;
      const defaultBaseRef =
        // Origin's copy first, as Autopilot's worktrees start from it: a local default branch can be behind.
        (defaultBranch &&
          (branches.find((b) => b === `origin/${defaultBranch}`) ?? branches.find((b) => b === defaultBranch))) ??
        branches[0] ??
        null;
      const tier = task.suggestedModel?.tier ?? null;
      const model = resolveTaskModel(task, settings);
      const picked = model.source === "label" || model.source === "tier" ? model.profile : null;
      const resolved = terminal(settings, h);
      return {
        clis: AgentHarness.options.map((harness) => cliStatus(settings, harness, h)),
        workspaceRoot: root,
        isRepo,
        branches,
        defaultBaseRef,
        models: {
          "claude-code": profileCliModel(model.profile, "claude-code"),
          "copilot-cli": profileCliModel(model.profile, "copilot-cli"),
        },
        efforts: {
          "claude-code": profileCliEffort(model.profile, "claude-code"),
          "copilot-cli": profileCliEffort(model.profile, "copilot-cli"),
        },
        tier,
        model: picked ? { name: picked.name, source: model.source as "label" | "tier", label: model.label } : null,
        namedWindow: "launch" in resolved && resolved.focus !== undefined,
      };
    },

    async start(taskId, rawInput, actor) {
      const input = StartSessionInputSchema.parse(rawInput);
      const { task, root } = subject(taskId);
      // An epic's session orchestrates its tasks; a task's does its own work.
      const modeError = handoffModeError(task, input.mode === "fix" ? "work" : input.mode);
      if (modeError) throw new AppError("VALIDATION", modeError);
      if (!root) throw new AppError("VALIDATION", "The task's project has no folder to start a session in");
      const ready = prepare(input.harness);
      const effort = launchEffort(input.harness, input.effort);
      const imageIds = input.attachmentIds ?? [];
      // Checked before a worktree is made, so an image that is gone leaves nothing behind.
      deps.services().attachments.forLaunch(imageIds, task.id);

      const sessionId = randomUUID();
      let cwd = root;
      let branch: string | null = null;
      const { workspace } = input;
      if (workspace.mode === "pr_branch") {
        const originUrl = await deps.runGit(["remote", "get-url", "origin"], root).catch(() => null);
        const origin = originUrl?.code === 0 ? remoteRepo(originUrl.stdout.trim()) : null;
        if (!prBranches(task, origin).includes(workspace.branch)) {
          throw new AppError(
            "VALIDATION",
            `#${task.number} has no open pull request on ${workspace.branch}${origin ? ` in ${origin.repo}` : ""}`,
          );
        }
      }
      if (workspace.mode !== "current") {
        try {
          // A pull request's branch is on origin, and origin's copy is the one to build on; the session pushes back to it.
          const worktree = await createWorktree(deps.runGit, {
            repo: root,
            root: join(deps.worktreesDir, "sessions"),
            taskNumber: task.number,
            runId: sessionId,
            ...(workspace.mode === "pr_branch" ? { branch: workspace.branch } : { baseRef: workspace.baseRef }),
            branchPrefix: SESSION_BRANCH_PREFIX,
          });
          cwd = worktree.path;
          branch = worktree.branch;
        } catch (error) {
          throw new AppError("VALIDATION", `Couldn't make the worktree: ${messageOf(error)}`);
        }
      }

      // Claimed before the prompt is built, so it points at where the files will stay: under the task's folder,
      // backed up and deleted with it.
      const images = imageIds.length > 0 ? deps.services().attachments.claimIds(task.id, imageIds) : [];
      return launch(ready, {
        sessionId,
        model: input.model,
        effort,
        prompt: withAttachedImages(input.prompt, images),
        cwd,
        branch,
        label: sessionLabel(input.mode, task.number),
        windowTask: task.number,
        short: (platform) =>
          shortPrompt(
            input.mode,
            task,
            platform,
            workspace.mode === "pr_branch" ? workspace.branch : undefined,
            images,
          ),
        taskIds: [task.id],
        actor,
      });
    },

    async startPlanning(projectId, rawInput, actor) {
      const input = StartPlanningSessionInputSchema.parse(rawInput);
      // Checked before anything starts, so a list with a task that can't be planned starts nothing.
      const tasks = tasksToPlan(deps.services(), projectId, input.taskIds);
      const root = projectRoot(projectId);
      if (!root) throw new AppError("VALIDATION", "The project has no folder to start a session in");
      const ready = prepare(input.harness);
      const effort = launchEffort(input.harness, input.effort);
      // Not claimed: there is no one task to give them to, so they wait in the pending folder and are swept after a
      // day, by when the session has read them.
      const images = deps.services().attachments.forLaunch(input.attachmentIds ?? [], null);
      // Planning writes no code, so it runs in the project's own checkout.
      return launch(ready, {
        sessionId: randomUUID(),
        model: input.model,
        effort,
        prompt: withAttachedImages(input.prompt, images),
        cwd: root,
        branch: null,
        label: planningSessionLabel(tasks),
        windowTask: tasks[0]!.number,
        short: (platform) => fitShort(withAttachedImages(planTasksShortPrompt(tasks), images), platform),
        taskIds: tasks.map((task) => task.id),
        actor,
      });
    },
  };
}
