import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import type { SshMachineRoute } from "@repo/contracts";

// Running `ssh` for a connected machine (docs/features/remote-machines.md#routes): the install piped over it and the
// tunnel to the runner's port. The user's own ssh, config, keys and agent are used; nothing is asked on a terminal.

/** A running `ssh`, as much of it as the callers need, so tests can stand in for it. */
export interface SshChild {
  onStdout(listener: (text: string) => void): void;
  onStderr(listener: (text: string) => void): void;
  /** The exit code; null when it was killed, or couldn't be started (`error` says why). */
  exit: Promise<{ code: number | null; error?: string }>;
  kill(): void;
}

/** Starts `ssh` with these arguments, writing `stdin` to it when given. */
export type SpawnSsh = (args: string[], stdin?: string) => SshChild;

export const spawnSsh: SpawnSsh = (args, stdin) => {
  const child = spawn("ssh", args, {
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  const exit = new Promise<{ code: number | null; error?: string }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error: error.message }));
    child.once("close", (code) => resolve({ code }));
  });
  if (stdin !== undefined) {
    // ssh may end before it has read everything (a login that fails); that is reported by its exit, not here.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  }
  return {
    onStdout: (listener) => void child.stdout?.on("data", listener),
    onStderr: (listener) => void child.stderr?.on("data", listener),
    exit,
    kill: () => void child.kill(),
  };
};

/**
 * The options every `ssh` of ours starts with. BatchMode: a password or passphrase prompt would hang with no
 * terminal to answer it, so a login that needs one fails instead. An unknown host key fails too (ssh's default with
 * no terminal): the user accepts it once themselves, rather than the board trusting whatever answers first.
 */
export function sshArgs(route: Pick<SshMachineRoute, "target" | "port">, options: string[] = []): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    ...options,
    ...(route.port ? ["-p", String(route.port)] : []),
    // The target is validated (SshTarget), and `--` ends the options whatever it holds.
    "--",
    route.target,
  ];
}

/** What ssh's own failure means, in a sentence the user can act on. `stderr` is what ssh printed. */
export function sshFailure(target: string, stderr: string, error?: string): string {
  if (error) return `Couldn't run ssh: ${error}. Is OpenSSH installed on this machine?`;
  const text = stderr.trim();
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) {
    return /HAS CHANGED/i.test(text)
      ? `${target}'s host key has changed since this machine last connected to it. Check it is the same machine, then fix ~/.ssh/known_hosts.`
      : `This machine has never connected to ${target}. Run \`ssh ${target}\` once in a terminal to accept its key, then try again.`;
  }
  if (/Permission denied/i.test(text)) {
    return `SSH couldn't log in to ${target} without asking for a password. Set up key login (\`ssh-copy-id ${target}\`), or unlock your key in the SSH agent, and try again.`;
  }
  const last = text.split(/\r?\n/).findLast((line) => line.trim() !== "");
  return last ? `ssh ${target}: ${last.replace(/^ssh: /, "")}` : `ssh ${target} failed`;
}

/** A port on this machine nothing listens on, for a tunnel's local end. */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Whether something accepts connections on a loopback port. */
export function loopbackPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
