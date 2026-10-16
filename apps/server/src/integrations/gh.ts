import { execFile } from "node:child_process";

export const GH_TIMEOUT_MS = 30_000;

/** Runs `gh` with the given args and resolves stdout. Rejects with a GhError on failure. */
export type RunGh = (args: string[], opts?: { timeoutMs?: number }) => Promise<string>;

export class GhError extends Error {
  constructor(
    message: string,
    /** True when the gh binary could not be found. */
    readonly notFound: boolean,
    /** What gh printed before failing; `gh auth status --json` reports signed-out hosts this way. */
    readonly stdout = "",
  ) {
    super(message);
    this.name = "GhError";
  }
}

/**
 * Spawns gh without a shell. On Windows libuv resolves "gh" to gh.exe via PATH, so no
 * extension or shell is needed (verified with gh 2.96 on Windows 11). GH_PROMPT_DISABLED keeps
 * gh from waiting on a prompt nobody can answer.
 */
export const defaultRunGh: RunGh = (args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      {
        timeout: opts?.timeoutMs ?? GH_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reject(new GhError("gh CLI not found", true));
        if (error.killed) return reject(new GhError(`gh ${args[0] ?? ""} timed out`, false));
        const detail = stderr.trim().split(/\r?\n/)[0] || error.message;
        reject(new GhError(detail, false, stdout));
      },
    );
  });
