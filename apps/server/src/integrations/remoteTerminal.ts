import { isIP } from "node:net";
import {
  AGENT_HARNESSES,
  BRAND,
  DEFAULT_RUNNER_PORT,
  SshTarget,
  type AgentHarness,
  type MachineRoute,
  type MachineT3Offer,
} from "@repo/contracts";
import { AppError } from "../errors.ts";
import { addressKind } from "../http/addresses.ts";
import { sshArgs, sshFailure, type SpawnSsh } from "./machines/ssh.ts";
import { shQuote } from "./terminal.ts";

// A CLI session on a connected machine, opened in a terminal here (docs/features/agent-sessions.md#on-a-machine):
// `ssh -t` to the machine, then tmux there, attaching to the session's tmux session when it is still open and making
// it otherwise, with the harness's command in the session's folder. tmux is what keeps the session going when the
// terminal here closes or this machine sleeps; opening it again attaches to it.

/** How the board reaches a machine with `ssh`. */
export interface SshRoute {
  target: string;
  port: number | null;
}

/**
 * The machine's first SSH route; else, for a machine reached over Tailscale only, ssh to its tailnet address or
 * `*.ts.net` name, with the user's own ssh config deciding the user. Null when there is neither.
 */
export function sshRouteOf(routes: readonly MachineRoute[]): SshRoute | null {
  const ssh = routes.find((r) => r.kind === "ssh");
  if (ssh?.kind === "ssh") return { target: ssh.target, port: ssh.port };
  for (const route of routes) {
    if (route.kind !== "direct") continue;
    let host: string;
    try {
      host = new URL(route.url).hostname.replace(/^\[|\]$/g, "");
    } catch {
      continue;
    }
    const tailnet = isIP(host) ? addressKind(host) === "tailnet" : /\.ts\.net$/i.test(host);
    if (tailnet && SshTarget.safeParse(host).success) return { target: host, port: null };
  }
  return null;
}

/** The tmux session a CLI session runs in on a machine: named for its id, so opening it again finds it. */
export const tmuxSessionName = (id: string): string => `${BRAND.id}-${id.replace(/-/g, "").slice(0, 12)}`;

/**
 * Where a login shell on the machine may not look but a CLI installer puts things. A non-interactive ssh command
 * reads less of the user's shell setup than a terminal does.
 */
const EXTRA_PATH = "$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin";

/**
 * Quotes text so that both a POSIX shell and fish, the login shells ssh may hand a command to, read it back as
 * written: single quotes, with `'` and `\` written outside them, escaped, where both shells agree on what they mean.
 */
export function loginShellQuote(value: string): string {
  return `'${value.replace(/['\\]/g, (c) => `'\\${c}'`)}'`;
}

/** A POSIX sh script run by a login `sh` on the machine, as the one argument ssh passes to the user's shell. */
const remoteSh = (script: string): string => `sh -lc ${loginShellQuote(script)}`;

/**
 * The tmux session option set once the CLI in it has exited. The shell left behind keeps what the CLI printed
 * readable, but opening the session again must run the CLI, not attach to that shell.
 */
const ENDED_OPTION = "@ended";

/**
 * The longest script the session's tmux command may come from. The tmux client refuses a command over its message
 * size (16 KB) with "command too long", and the script carries it with a little around it; a longer prompt is replaced
 * by the short one, as for a command line here.
 */
export const REMOTE_SCRIPT_MAX = 14_000;

/**
 * The script that opens the session on the machine: attach to its tmux session when the CLI still runs there, else
 * (ending a tmux session whose CLI has exited) make it running the CLI in the session's folder. A shell takes over when
 * the CLI exits, so what it last printed stays readable, and the session is marked as ended. A terminal type the
 * machine has no terminfo for (kitty, Ghostty) would stop tmux, so it falls back to xterm-256color. Double quotes are
 * left out: they can't cross cmd.exe on a Windows board.
 */
export function remoteSessionScript(input: {
  cwd: string;
  argv: readonly string[];
  tmuxName: string;
  /** The runner's own MCP endpoint, given to a CLI that takes one on its command line (see `ownMcpArgs`). */
  mcpUrl?: string | null;
}): string {
  const [cli, ...args] = input.argv.map(shQuote);
  const mcp = input.mcpUrl ? ownMcpArgs(input.argv[0]!, input.mcpUrl) : null;
  const inner =
    `${[cli, ...(mcp ? [mcp] : []), ...args].join(" ")}; ` +
    `tmux set-option -q ${ENDED_OPTION} 1; exec \${SHELL:-/bin/sh} -l`;
  const target = shQuote(`=${input.tmuxName}`);
  return [
    `PATH=${EXTRA_PATH}:$PATH; export PATH`,
    `command -v tmux >/dev/null 2>&1 || { echo tmux is not installed on this machine >&2; exit 3; }`,
    `command -v infocmp >/dev/null 2>&1 && { infocmp $TERM >/dev/null 2>&1 || TERM=xterm-256color; export TERM; }`,
    `cd ${shQuote(input.cwd)} || exit 4`,
    `tmux show-options -qv -t ${target} ${ENDED_OPTION} 2>/dev/null | grep -qx 1 && tmux kill-session -t ${target}`,
    `exec tmux new-session -A -s ${shQuote(input.tmuxName)} -c ${shQuote(input.cwd)} sh -c ${shQuote(inner)}`,
  ].join("; ");
}

/**
 * The runner's own MCP endpoint for a CLI on the machine, as headless runs there get it, since a machine set up only
 * as a runner may have no registration for it: Claude Code's `--mcp-config` and Codex's `-c mcp_servers.<id>.url`,
 * over whatever the user's config says. Copilot CLI is left to the user's config, as its runs are. The value is
 * decoded on the machine from base64, so no double quote has to cross the shells in between; it has no spaces.
 */
export function ownMcpArgs(cli: string, url: string): string | null {
  const harness = (["claude-code", "codex"] as const).find((h) => AGENT_HARNESSES[h].cli === cli.split(/[\\/]/).pop());
  if (!harness) return null;
  const value =
    harness === "claude-code"
      ? JSON.stringify({ mcpServers: { [BRAND.id]: { type: "http", url } } })
      : JSON.stringify(url);
  const decoded = `$(printf %s ${Buffer.from(value).toString("base64")} | base64 -d)`;
  return harness === "claude-code" ? `--mcp-config ${decoded}` : `-c mcp_servers.${BRAND.id}.url=${decoded}`;
}

/** The runner's port on its own loopback, where its MCP endpoint is, as the machine's routes tell it. */
export function runnerPortOf(routes: readonly MachineRoute[]): number {
  for (const route of routes) {
    if (route.kind === "ssh") return route.remotePort;
    try {
      const url = new URL(route.url);
      if (url.protocol === "http:" && url.port) return Number(url.port);
    } catch {
      // Not a URL: the next route may say.
    }
  }
  return DEFAULT_RUNNER_PORT;
}

/** The command a terminal here runs: `ssh -t` to the machine with the session's script. */
export function remoteSessionArgv(route: SshRoute, script: string): string[] {
  return ["ssh", "-t", ...(route.port ? ["-p", String(route.port)] : []), "--", route.target, remoteSh(script)];
}

/** What the machine said before the session opened. */
export interface RemotePreflight {
  /** The CLI still runs in the session's tmux session there: opening it attaches to it. */
  open: boolean;
}

/**
 * Asks the machine, over a non-interactive ssh, whether the session can open there: tmux, the folder and the CLI,
 * and whether its tmux session is still open. Throws a VALIDATION AppError with what to do when it can't; `details`
 * carries `{ t3: "offer", machineId }` (MachineT3Offer), since a T3 Code thread on the machine needs none of these.
 */
export async function remotePreflight(
  spawn: SpawnSsh,
  machine: { id: string; name: string },
  route: SshRoute,
  /** `cwd` is left out for a session whose folder the machine is about to make. */
  check: { cwd?: string; harness: AgentHarness; exe: string; tmuxName: string },
): Promise<RemotePreflight> {
  const script = [
    `PATH=${EXTRA_PATH}:$PATH`,
    `command -v tmux >/dev/null 2>&1 || echo no-tmux`,
    ...(check.cwd ? [`test -d ${shQuote(check.cwd)} || echo no-folder`] : []),
    `command -v ${shQuote(check.exe)} >/dev/null 2>&1 || echo no-cli`,
    // Open only while the CLI runs in it: once it has exited, the session's shell is all that is left.
    `tmux has-session -t ${shQuote(`=${check.tmuxName}`)} 2>/dev/null && ` +
      `{ tmux show-options -qv -t ${shQuote(`=${check.tmuxName}`)} ${ENDED_OPTION} | grep -qx 1 || echo open; }`,
    `echo checked`,
  ].join("; ");
  const child = spawn([...sshArgs(route), remoteSh(script)]);
  let out = "";
  let err = "";
  child.onStdout((text) => (out += text));
  child.onStderr((text) => (err += text));
  const timer = setTimeout(() => child.kill(), 20_000);
  const exit = await child.exit.finally(() => clearTimeout(timer));
  const machineName = machine.name;
  const offer = t3Offer(machine.id);
  const words = new Set(out.split(/\s+/));
  if (!words.has("checked")) {
    throw new AppError(
      "VALIDATION",
      `${sshFailure(route.target, err, exit.error)} Sessions on ${machineName} open over SSH; a T3 Code thread there doesn't need it.`,
      offer,
    );
  }
  if (words.has("no-tmux")) {
    throw new AppError(
      "VALIDATION",
      `tmux isn't installed on ${machineName}, and sessions there run in tmux so they keep going when the terminal closes. Install it on ${machineName} (\`sudo apt install tmux\` or \`brew install tmux\`) and try again, or start a T3 Code thread there instead.`,
      offer,
    );
  }
  if (words.has("no-folder")) {
    throw new AppError("VALIDATION", `The session's folder no longer exists on ${machineName}: ${check.cwd ?? ""}`);
  }
  if (words.has("no-cli")) {
    throw new AppError(
      "VALIDATION",
      `${AGENT_HARNESSES[check.harness].label} (\`${check.exe}\`) isn't on the PATH of a login shell on ${machineName}. Install it there, or put it on that PATH, and try again.`,
      offer,
    );
  }
  return { open: words.has("open") };
}

/** The `details` of an error a T3 Code thread on that machine would avoid: the web offers one, or to connect it. */
const t3Offer = (machineId: string): MachineT3Offer => ({ t3: "offer", machineId });

/** Why a machine has no way in for a terminal, as a sentence with what to do. */
export function noSshRoute(machine: { id: string; name: string }): AppError {
  return new AppError(
    "VALIDATION",
    `There's no SSH route to ${machine.name}: sessions there open over SSH. Add one under Settings → Integrations → Machines (or reach it over Tailscale), or start a T3 Code thread there instead.`,
    t3Offer(machine.id),
  );
}
