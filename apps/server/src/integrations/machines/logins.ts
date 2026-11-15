import { spawn } from "node:child_process";
import type { MachineLogin, MachineLoginName } from "@repo/contracts";
import { resolveExecutable } from "../claudeCli.ts";

// What a runner can log in to (docs/features/remote-machines.md#status-and-logins): the agent CLIs it runs and what
// it pushes with. Each is a login the machine's user makes themselves; the board only reports what is missing.

export interface ProbeResult {
  /** Null when the program ended by a signal or the timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface LoginProbes {
  /** The program's path on the runner's PATH, or null. */
  find(command: string): string | null;
  run(exe: string, args: string[], timeoutMs: number): Promise<ProbeResult>;
  env: NodeJS.ProcessEnv;
}

const PROBE_TIMEOUT_MS = 15_000;
/** How long an answer is reused: the checks start several programs, and the board asks every half minute. */
const CACHE_MS = 60_000;

const runProbe: LoginProbes["run"] = (exe, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: error.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

const login = (name: MachineLoginName, state: MachineLogin["state"], detail: string | null = null): MachineLogin => ({
  name,
  state,
  detail,
});

/**
 * A CLI whose own command says whether it is logged in, by its exit code: 0 is logged in. A program that can't be
 * run or times out is `unknown`, since that says nothing about the login.
 */
async function cliLogin(
  probes: LoginProbes,
  name: MachineLoginName,
  args: string[],
  fix: string,
): Promise<MachineLogin> {
  const exe = probes.find(name);
  if (!exe) return login(name, "missing", `\`${name}\` isn't on the runner's PATH.`);
  const result = await probes.run(exe, args, PROBE_TIMEOUT_MS);
  if (result.code === 0) return login(name, "ok");
  if (result.code === null) return login(name, "unknown", `\`${name} ${args.join(" ")}\` didn't finish.`);
  return login(name, "logged-out", fix);
}

/**
 * Whether git can push to GitHub: through gh's credential helper, any other helper, or an SSH key GitHub accepts.
 * GitHub only: it is where the board's pull requests are.
 */
async function gitLogin(probes: LoginProbes, gh: MachineLogin): Promise<MachineLogin> {
  const git = probes.find("git");
  if (!git) return login("git", "missing", "`git` isn't on the runner's PATH.");
  const helpers = await probes.run(git, ["config", "--get-regexp", "^credential\\..*helper$"], PROBE_TIMEOUT_MS);
  const helper = helpers.code === 0 ? helpers.stdout.trim() : "";
  // gh's helper answers only while gh is logged in; any other helper is the user's, and taken at its word.
  const viaGh = /gh(\.exe)?["']? auth git-credential/.test(helper);
  if (helper && (!viaGh || gh.state === "ok")) return login("git", "ok");
  const ssh = probes.find("ssh");
  if (ssh) {
    // GitHub greets a key it knows and closes with exit 1; anything else is a key it doesn't.
    const hello = await probes.run(
      ssh,
      ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "git@github.com"],
      PROBE_TIMEOUT_MS,
    );
    if (/successfully authenticated/i.test(hello.stderr + hello.stdout)) return login("git", "ok");
  }
  return login(
    "git",
    "logged-out",
    "git has no way to push to GitHub. Run `gh auth setup-git` on the machine, or add an SSH key to GitHub.",
  );
}

export interface LoginDetector {
  /** The runner's logins, checked now or within the last minute. */
  logins(): Promise<MachineLogin[]>;
  /**
   * The same, waiting at most `maxWaitMs`: past that, the last answer there was (or every login as unknown), while
   * the check carries on for the next call. The checks can take longer than a board waits for an answer.
   */
  loginsWithin(maxWaitMs: number): Promise<MachineLogin[]>;
}

const LOGIN_NAMES: MachineLoginName[] = ["claude", "codex", "gh", "git"];

export function createLoginDetector(overrides: Partial<LoginProbes> = {}, now: () => number = Date.now): LoginDetector {
  const env = overrides.env ?? process.env;
  const probes: LoginProbes = {
    env,
    find: overrides.find ?? ((command) => resolveExecutable(command, env)),
    run: overrides.run ?? runProbe,
  };
  let cached: { at: number; value: Promise<MachineLogin[]> } | null = null;
  let last: MachineLogin[] | null = null;

  const detect = async (): Promise<MachineLogin[]> => {
    const [claude, codex, gh] = await Promise.all([
      cliLogin(probes, "claude", ["auth", "status"], "Run `claude` on the machine and log in."),
      cliLogin(probes, "codex", ["login", "status"], "Run `codex login` on the machine."),
      cliLogin(probes, "gh", ["auth", "status"], "Run `gh auth login` on the machine."),
    ]);
    last = [claude, codex, gh, await gitLogin(probes, gh)];
    return last;
  };

  const logins = (): Promise<MachineLogin[]> => {
    if (!cached || now() - cached.at > CACHE_MS) {
      const value = detect();
      cached = { at: now(), value };
      // A check that threw isn't kept: the next call tries again.
      value.catch(() => {
        if (cached?.value === value) cached = null;
      });
    }
    return cached.value;
  };

  return {
    logins,
    loginsWithin(maxWaitMs) {
      let timer: NodeJS.Timeout | undefined;
      const fallback = new Promise<MachineLogin[]>((resolve) => {
        timer = setTimeout(
          () => resolve(last ?? LOGIN_NAMES.map((name) => login(name, "unknown", "Still being checked."))),
          maxWaitMs,
        );
      });
      return Promise.race([logins(), fallback]).finally(() => clearTimeout(timer));
    },
  };
}
