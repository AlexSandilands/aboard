import { spawn } from "node:child_process";
import { brandEnv } from "@repo/contracts";
import { killTree, liveGroups, POSIX_GROUPS } from "./processTree.ts";

// Autopilot's shell actions: a command the user wrote, run in a project's folder. Task values reach it only as
// environment variables, never in the command line.
//
// Off Windows the command runs in /bin/sh, which expands "$VAR" after parsing, so a value can't become syntax. On
// Windows it runs in PowerShell, not cmd.exe: cmd expands %VAR% before it parses the line, so a task title with
// `& …` in it would run as a command whatever the quoting. PowerShell's $env:VAR is a value, like sh's. One hole
// stays, and it is Windows': Windows PowerShell doesn't escape quotes in the arguments it passes to programs, and a
// .cmd or .bat program (npm, pnpm, npx) parses them again in cmd.exe, so a command that passes a value as an
// argument is injectable. The guide and the editor say so; nothing here can prevent it.

/** How much of the output a run keeps: the end, where errors usually are. */
export const SHELL_OUTPUT_TAIL = 4_000;
/** What is held while the command runs, so a chatty one can't fill memory. */
const BUFFER_MAX = 64_000;
/** How long a timed-out command gets to end before it is killed outright and the run is given up on. */
const KILL_GRACE_MS = 5_000;

export interface ShellRequest {
  command: string;
  cwd: string;
  /** Added to the server's environment, after the board's own variables are taken out. */
  env: Record<string, string>;
  timeoutMs: number;
}

export interface ShellResult {
  /** Null when it was killed (a timeout) or ended by a signal. */
  exitCode: number | null;
  /** The tail of stdout and stderr, interleaved as they came. */
  output: string;
  timedOut: boolean;
}

export type RunShell = (request: ShellRequest) => Promise<ShellResult>;

/**
 * The server's environment without the board's own variables (`ABOARD_TOKEN` and the rest), so a command can't read
 * the API token. Names compare case-insensitively, as Windows treats them.
 */
export function shellEnvironment(
  extra: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const prefix = brandEnv("").toUpperCase();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !key.toUpperCase().startsWith(prefix)) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * The PowerShell script that runs a command and exits with its status: a failing native program's exit code, 1 for
 * a failing cmdlet, else 0 (PowerShell's own `-Command` exit code would lose the program's).
 */
export function powershellScript(command: string): string {
  return [
    // Progress records would reach stderr as CLIXML.
    "$ProgressPreference = 'SilentlyContinue'",
    "try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}",
    command,
    "$__autopilotOk = $?",
    "if (-not $__autopilotOk) { if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 } }",
    "exit 0",
  ].join("\n");
}

/** The program and arguments that run `command`. Encoded for PowerShell, so no quoting reaches its command line. */
export function shellInvocation(command: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === "win32") {
    const encoded = Buffer.from(powershellScript(command), "utf16le").toString("base64");
    return [
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    ];
  }
  return ["/bin/sh", ["-c", command]];
}

export const runShellCommand: RunShell = (request) =>
  new Promise((resolve, reject) => {
    const [exe, args] = shellInvocation(request.command);
    const child = spawn(exe, args, {
      cwd: request.cwd,
      env: shellEnvironment(request.env),
      windowsHide: true,
      detached: POSIX_GROUPS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const group = POSIX_GROUPS ? child.pid : undefined;
    if (group !== undefined) liveGroups.add(group);
    let output = "";
    let timedOut = false;
    let settled = false;
    let grace: NodeJS.Timeout | null = null;
    const take = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > BUFFER_MAX) output = output.slice(-BUFFER_MAX);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const finish = (result: ShellResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (group !== undefined) liveGroups.delete(group);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // A tree that ignores SIGTERM (or holds the pipes open) mustn't keep the run going forever.
      grace = setTimeout(() => {
        killTree(child, true);
        finish({ exitCode: null, output: output.slice(-SHELL_OUTPUT_TAIL), timedOut: true });
      }, KILL_GRACE_MS);
    }, request.timeoutMs);
    child.on("error", (error) => finish(error));
    child.on("close", (code) =>
      finish({ exitCode: timedOut ? null : code, output: output.slice(-SHELL_OUTPUT_TAIL), timedOut }),
    );
  });
