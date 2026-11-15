import {
  MachineInstallStepKey,
  RUNNER_INSTALL_RESULT_PREFIX,
  RUNNER_INSTALL_STEP_PREFIX,
  runnerInstallScript,
} from "@repo/contracts";
import { z } from "zod";
import { shQuote } from "../terminal.ts";
import { sshArgs, sshFailure, spawnSsh, type SpawnSsh } from "./ssh.ts";

// Installing a runner on another machine over SSH (docs/features/remote-machines.md#installing-over-ssh): the
// install script is piped to `sh` there, so nothing is copied to the machine or run on it by hand.

/** What `<id>-server pair --json` prints: the pairing code, and where and who the runner is. */
export const RunnerPairOutput = z.object({
  code: z.string().min(1),
  /** The port the runner listens on, on its own loopback. */
  port: z.number().int().min(1).max(65535),
  instanceId: z.uuid(),
  name: z.string(),
  /** The machine's Tailscale address, when it was asked to listen there and has one. */
  // Whatever `tailscale ip` printed there; anything that isn't an address is dropped, not trusted as a host.
  tailscaleIp: z.ipv4().nullable().default(null).catch(null),
});
export type RunnerPairOutput = z.infer<typeof RunnerPairOutput>;

export interface SshInstallInput {
  target: string;
  port: number | null;
  version: string;
  tailscale: boolean;
  /** Where the release files are, instead of GitHub (development). */
  baseUrl: string | null;
}

export interface SshInstallHooks {
  /** A step of the install script started; the ones before it are done. */
  onStep(step: MachineInstallStepKey): void;
  /** A line the remote printed, never one carrying the pairing code. */
  onLog(line: string): void;
}

/** A failed install, with the step it failed in. */
export class SshInstallError extends Error {}

/** Downloading a release over a slow line takes a while; past this something is stuck. */
const INSTALL_TIMEOUT_MS = 15 * 60_000;

/**
 * Runs the install script on `target` and returns the pairing code it ends with. Rejects with a sentence saying
 * what failed: ssh's own failure (exit 255) or the last thing the script said.
 */
export async function runSshInstall(
  input: SshInstallInput,
  hooks: SshInstallHooks,
  spawn: SpawnSsh = spawnSsh,
): Promise<RunnerPairOutput> {
  const flags = [
    "--porcelain",
    "--version",
    input.version,
    ...(input.tailscale ? ["--tailscale"] : []),
    ...(input.baseUrl ? ["--base-url", input.baseUrl] : []),
  ];
  // ssh joins its arguments into one line for the remote shell, so each is quoted here. `sh -s` reads the script
  // from stdin, whatever the user's login shell is.
  const command = ["sh", "-s", "--", ...flags.map(shQuote)].join(" ");
  const child = spawn(sshArgs(input, []).concat(command), runnerInstallScript(input.version));

  // In an object: both are set from callbacks.
  const outcome: { result: RunnerPairOutput | null; unreadable: boolean } = { result: null, unreadable: false };
  let stderr = "";
  let lastLine = "";
  const log = (text: string) => {
    // Never the result, wherever it turns up: it carries the pairing code.
    if (text.trim() === "" || text.includes(RUNNER_INSTALL_RESULT_PREFIX.trim())) return;
    lastLine = text.trim();
    hooks.onLog(text);
  };
  const line = (text: string) => {
    if (text.startsWith(RUNNER_INSTALL_RESULT_PREFIX)) {
      let json: unknown = null;
      try {
        json = JSON.parse(text.slice(RUNNER_INSTALL_RESULT_PREFIX.length));
      } catch {
        // Reported below as an install that ended without a code.
      }
      const parsed = RunnerPairOutput.safeParse(json);
      if (parsed.success) outcome.result = parsed.data;
      else outcome.unreadable = true;
      return;
    }
    if (text.startsWith(RUNNER_INSTALL_STEP_PREFIX)) {
      const step = MachineInstallStepKey.safeParse(text.slice(RUNNER_INSTALL_STEP_PREFIX.length).trim());
      if (step.success) hooks.onStep(step.data);
      return;
    }
    log(text);
  };
  // A buffer per stream: the script prints its result in two writes, and anything the remote says on stderr in
  // between must not land inside that line. Only stdout carries the script's own `@@` lines.
  const reader = (take: (text: string) => void) => {
    let pending = "";
    return {
      feed(chunk: string) {
        const lines = (pending + chunk).split(/\r?\n/);
        pending = lines.pop() ?? "";
        lines.forEach(take);
      },
      end() {
        if (pending) take(pending);
        pending = "";
      },
    };
  };
  const out = reader(line);
  const err = reader(log);
  child.onStdout((chunk) => out.feed(chunk));
  child.onStderr((chunk) => {
    stderr = (stderr + chunk).slice(-4_000);
    err.feed(chunk);
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, INSTALL_TIMEOUT_MS);
  const exit = await child.exit.finally(() => clearTimeout(timer));
  out.end();
  err.end();

  if (timedOut) throw new SshInstallError(`The install on ${input.target} took too long and was stopped.`);
  // 255 is ssh's own: it never logged in, or the connection dropped.
  if (exit.error || exit.code === 255) throw new SshInstallError(sshFailure(input.target, stderr, exit.error));
  if (exit.code !== 0)
    throw new SshInstallError(lastLine || `The install on ${input.target} failed (exit ${exit.code}).`);
  if (!outcome.result) {
    throw new SshInstallError(
      outcome.unreadable
        ? `${input.target} installed the runner but answered with something this board can't read.`
        : `The install on ${input.target} ended without a pairing code.`,
    );
  }
  return outcome.result;
}
