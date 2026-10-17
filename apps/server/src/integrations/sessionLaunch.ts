import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_HARNESSES,
  AgentHarness,
  BRAND,
  isAbsolutePath,
  newSessionArgv,
  sessionLabel,
  StartSessionInput as StartSessionInputSchema,
  taskWindowName,
  tierCliModel,
  type AgentCliStatus,
  type AppSettings,
  type SessionLaunchOptions,
  type StartSessionInput,
  type StartSessionResult,
} from "@repo/contracts";
import { createWorktree, defaultBranchOf } from "../autopilot/worktrees.ts";
import { AppError } from "../errors.ts";
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
}

type SessionServices = Pick<Services, "tasks" | "projects" | "links" | "settings">;

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
): string {
  const text =
    `${mode === "plan" ? "Let's plan" : "Let's work on"} #${task.number} from the ${BRAND.id} task board: ` +
    `call get_task("${task.id}") on the ${BRAND.id} MCP server first. The board started this session and already ` +
    "linked it to the task; don't link it again.";
  const fitted = textArgument(text, platform);
  if ("error" in fitted) throw new Error(`The short prompt can't go on a command line: ${fitted.error}`);
  return fitted.value;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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

  /** The task and the folder its project lives in, which every launch starts from. */
  const subject = (taskId: string) => {
    const s = deps.services();
    const task = s.tasks.summary(taskId);
    if (task.kind === "epic") throw new AppError("VALIDATION", "An epic's sessions start from its tasks");
    const root = s.projects.get(task.projectId).workspaceRoot;
    return { task, root: root && isAbsolutePath(root) && isDirectory(root) ? root : null };
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

  return {
    clis,

    async options(taskId) {
      const { task, root } = subject(taskId);
      const settings = deps.services().settings.get();
      const h = deps.host();
      const { isRepo, branches } = root ? await branchesOf(root) : { isRepo: false, branches: [] };
      const defaultBranch = isRepo && root ? await defaultBranchOf(deps.runGit, root).catch(() => null) : null;
      const defaultBaseRef =
        (defaultBranch && branches.find((b) => b === defaultBranch || b === `origin/${defaultBranch}`)) ??
        branches[0] ??
        null;
      const tier = task.suggestedModel?.tier ?? null;
      const resolved = terminal(settings, h);
      return {
        clis: AgentHarness.options.map((harness) => cliStatus(settings, harness, h)),
        workspaceRoot: root,
        isRepo,
        branches,
        defaultBaseRef,
        models: {
          "claude-code": tierCliModel(settings.modelTiers, tier, "claude-code"),
          "copilot-cli": tierCliModel(settings.modelTiers, tier, "copilot-cli"),
        },
        tier,
        namedWindow: "launch" in resolved && resolved.focus !== undefined,
      };
    },

    async start(taskId, rawInput, actor) {
      const input = StartSessionInputSchema.parse(rawInput);
      const { task, root } = subject(taskId);
      if (!root) throw new AppError("VALIDATION", "The task's project has no folder to start a session in");
      const settings = deps.services().settings.get();
      const h = deps.host();
      const harness = AGENT_HARNESSES[input.harness];
      const cli = cliStatus(settings, input.harness, h);
      if (!cli.available) {
        throw new AppError("VALIDATION", `${harness.label} isn't installed: set its path in Settings → Integrations`);
      }

      // The configured path when one is set; the bare name otherwise, so the terminal's own PATH finds it.
      const exe = configuredCli(settings, input.harness);
      // Checked before any worktree is made, so a terminal that can't run leaves nothing behind.
      const resolved = terminal(settings, h);
      if (!("launch" in resolved)) throw new AppError("VALIDATION", `No terminal to open: ${resolved.error}`);
      // cmd reads a quoted first word as the whole line's quotes and strips them, breaking the rest.
      if (resolved.shell === "cmd" && /\s/.test(exe)) {
        throw new AppError("VALIDATION", `Command Prompt can't start a CLI whose path has spaces (${exe})`);
      }

      const sessionId = randomUUID();
      let cwd = root;
      let branch: string | null = null;
      if (input.workspace.mode === "new_worktree") {
        try {
          const worktree = await createWorktree(deps.runGit, {
            repo: root,
            root: join(deps.worktreesDir, "sessions"),
            taskNumber: task.number,
            runId: sessionId,
            baseRef: input.workspace.baseRef,
            branchPrefix: SESSION_BRANCH_PREFIX,
          });
          cwd = worktree.path;
          branch = worktree.branch;
        } catch (error) {
          throw new AppError("VALIDATION", `Couldn't make the worktree: ${messageOf(error)}`);
        }
      }

      const label = sessionLabel(input.mode, task.number);
      const argvFor = (prompt: string) => {
        const argv = newSessionArgv({ harness: input.harness, sessionId, model: input.model, name: label, prompt });
        return [exe, ...argv.slice(1)];
      };
      const window = resolved.focus ? taskWindowName(task.number) : undefined;

      // The prompt as it can go on this command line, else a short one built from the task alone (the web app copies
      // the full prompt to the clipboard instead).
      const fitted = textArgument(input.prompt, h.platform);
      const short = () => shortPrompt(input.mode, task, h.platform);
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
        branch,
        shortPrompt: shortReason ? argv.at(-1)! : null,
        shortReason,
      };
      if (!spec) return { ...result, launched: false, error: launchError, linkId: null };

      try {
        await deps.spawn(spec);
      } catch (error) {
        log.warn(`[sessions] couldn't start ${displayLaunch(spec, h.platform)}: ${messageOf(error)}`);
        return {
          ...result,
          launched: false,
          error: `Couldn't start ${resolved.label}: ${messageOf(error)}`,
          linkId: null,
        };
      }
      const link = deps
        .services()
        .links.add(
          task.id,
          { agentSession: { harness: input.harness, sessionId, cwd }, label },
          actor,
          window ? { window } : {},
        );
      deps.linked?.(link.id);
      return { ...result, launched: true, error: null, linkId: link.id };
    },
  };
}
