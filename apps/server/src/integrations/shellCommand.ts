import { spawn } from "node:child_process";
import { brandEnv } from "@repo/contracts";
import { killTree, liveGroups, POSIX_GROUPS } from "./processTree.ts";

// Autopilot's shell actions: a command the user wrote, run by the platform shell (cmd.exe on Windows, /bin/sh
// elsewhere) in a project's folder. Task values reach it only as environment variables, never in the command line.

/** How much of the output a run keeps: the end, where errors usually are. */
export const SHELL_OUTPUT_TAIL = 4_000;
/** What is held while the command runs, so a chatty one can't fill memory. */
const BUFFER_MAX = 64_000;

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

export const runShellCommand: RunShell = (request) =>
  new Promise((resolve, reject) => {
    const child = spawn(request.command, {
      cwd: request.cwd,
      env: shellEnvironment(request.env),
      shell: true,
      windowsHide: true,
      detached: POSIX_GROUPS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const group = POSIX_GROUPS ? child.pid : undefined;
    if (group !== undefined) liveGroups.add(group);
    let output = "";
    let timedOut = false;
    const take = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > BUFFER_MAX) output = output.slice(-BUFFER_MAX);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, request.timeoutMs);
    const done = () => {
      clearTimeout(timer);
      if (group !== undefined) liveGroups.delete(group);
    };
    child.on("error", (error) => {
      done();
      reject(error);
    });
    child.on("close", (code) => {
      done();
      resolve({ exitCode: timedOut ? null : code, output: output.slice(-SHELL_OUTPUT_TAIL), timedOut });
    });
  });
