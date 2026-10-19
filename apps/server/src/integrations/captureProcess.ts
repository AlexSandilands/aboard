import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { killTree, liveGroups, POSIX_GROUPS } from "./processTree.ts";

// Running a program to its end and keeping what it printed, with a timeout that ends its whole tree. Shared by
// Autopilot's shell actions and script actions.

/** What is held of the interleaved output while the program runs, so a chatty one can't fill memory. */
const BUFFER_MAX = 64_000;
/** How long a timed-out program gets to end before it is killed outright and the run is given up on. */
const KILL_GRACE_MS = 5_000;
/** The most stdout kept: the start, since that is what a reader parses. Past it the rest is dropped. */
export const STDOUT_MAX = 1_000_000;

export interface CaptureRequest {
  exe: string;
  args: string[];
  cwd: string;
  /** The whole environment of the program. */
  env: Record<string, string>;
  /** Written to its stdin, which is then closed. Without it stdin is closed at once. */
  stdin?: string;
  timeoutMs: number;
  /** The tail of the interleaved output the result keeps. */
  tail: number;
}

export interface Captured {
  /** Null when it was killed (a timeout) or ended by a signal. */
  exitCode: number | null;
  /** The tail of stdout and stderr, interleaved as they came. */
  output: string;
  /** What it wrote to stdout (the first STDOUT_MAX characters), apart from stderr. */
  stdout: string;
  stdoutTruncated: boolean;
  /** The tail of what it wrote to stderr. */
  stderr: string;
  timedOut: boolean;
}

export function captureProcess(request: CaptureRequest): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.exe, request.args, {
      cwd: request.cwd,
      env: request.env,
      windowsHide: true,
      detached: POSIX_GROUPS,
      stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const group = POSIX_GROUPS ? child.pid : undefined;
    if (group !== undefined) liveGroups.add(group);
    let output = "";
    let stdout = "";
    let stdoutTruncated = false;
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let grace: NodeJS.Timeout | null = null;
    const take = (stream: "stdout" | "stderr") => {
      // A chunk can end inside a multi-byte character.
      const decoder = new StringDecoder("utf8");
      return (chunk: Buffer) => {
        const text = decoder.write(chunk);
        output = (output + text).slice(-BUFFER_MAX);
        if (stream === "stderr") {
          stderr = (stderr + text).slice(-BUFFER_MAX);
        } else if (stdout.length + text.length > STDOUT_MAX) {
          stdout += text.slice(0, STDOUT_MAX - stdout.length);
          stdoutTruncated = true;
        } else {
          stdout += text;
        }
      };
    };
    child.stdout?.on("data", take("stdout"));
    child.stderr?.on("data", take("stderr"));
    const result = (code: number | null): Captured => ({
      exitCode: timedOut ? null : code,
      output: output.slice(-request.tail),
      stdout,
      stdoutTruncated,
      stderr: stderr.slice(-request.tail),
      timedOut,
    });
    const finish = (outcome: Captured | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (group !== undefined) liveGroups.delete(group);
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // A tree that ignores SIGTERM (or holds the pipes open) mustn't keep the run going forever.
      grace = setTimeout(() => {
        killTree(child, true);
        finish(result(null));
      }, KILL_GRACE_MS);
    }, request.timeoutMs);
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(result(code)));
    if (request.stdin !== undefined && child.stdin) {
      // A program that ends without reading its stdin must not fail the run with EPIPE.
      child.stdin.on("error", () => {});
      child.stdin.end(request.stdin);
    }
  });
}
