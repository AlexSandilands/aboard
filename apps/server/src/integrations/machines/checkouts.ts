import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CopiedProject } from "@repo/contracts";
import { AppError } from "../../errors.ts";
import type { GitResult } from "../backup.ts";
import { remoteRepo } from "../gitRemote.ts";

// A runner's checkouts of the board's projects (docs/features/remote-machines.md#projects-on-a-machine). A project
// is the repository its `origin` names, never a path: the board's folder means nothing here. The runner clones each
// one once, on demand, into its own data dir.

/** A first clone of a large repository over a slow link. */
const CLONE_TIMEOUT_MS = 30 * 60_000;

export type CloneRepo = (url: string, dir: string) => Promise<GitResult>;

const defaultClone: CloneRepo = (url, dir) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["clone", "--", url, dir],
      // A missing credential fails instead of waiting for input nobody will type, and only the transports a
      // repository is cloned over are allowed: the URL came from another machine, and `ext::` runs a command.
      {
        timeout: CLONE_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https:http:ssh:git" },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr: stderr || (error?.message ?? "") });
      },
    );
  });

/** `host/owner/repo`, lower case: what makes two checkouts the same project. Null for a URL that names none. */
export function remoteIdentity(url: string): string | null {
  const repo = remoteRepo(url.trim());
  return repo ? `${repo.host}/${repo.repo}` : null;
}

export interface Checkouts {
  /**
   * The folder of the runner's checkout of `project`, cloning it first when there is none; null for a project with
   * no repository. Throws CONFLICT, with git's reason, when the repository can't be reached from this machine.
   */
  ensure(project: CopiedProject): Promise<string | null>;
}

export function createCheckouts(deps: {
  /** `<data dir>/repos`. */
  dir: string;
  machineName: () => string;
  clone?: CloneRepo;
}): Checkouts {
  const clone = deps.clone ?? defaultClone;
  /** One clone per folder at a time: two tasks of a project handed over together share it. */
  const cloning = new Map<string, Promise<string>>();

  /** The folder for a repository, named from the URL that is cloned: `github.com-acme-app`. Never outside `dir`. */
  const folderOf = (remote: string): string => {
    const name = remote.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
    return join(deps.dir, name || "repo");
  };

  return {
    ensure(project) {
      if (!project.remoteUrl) return Promise.resolve(null);
      const url = project.remoteUrl;
      const remote = remoteIdentity(url);
      // Only what names a repository on a host: nothing git would read as an option, a path here or a command.
      if (remote === null || /^[-\s]|::/.test(url)) {
        return Promise.reject(new AppError("VALIDATION", `${url} isn't a repository URL this machine can clone`));
      }
      // The folder comes from the URL itself, not from what the request says the URL is.
      const dir = folderOf(remote);
      if (existsSync(join(dir, ".git"))) return Promise.resolve(dir);
      const running = cloning.get(dir);
      if (running) return running;
      const job = (async () => {
        mkdirSync(deps.dir, { recursive: true });
        const result = await clone(url, dir);
        if (result.code !== 0) {
          // A clone that stopped halfway would pass for a checkout next time.
          rmSync(dir, { recursive: true, force: true });
          const reason = result.stderr.trim().split("\n").at(-1) ?? "git clone failed";
          throw new AppError("CONFLICT", `${deps.machineName()} can't clone ${url}: ${reason}`);
        }
        return dir;
      })().finally(() => cloning.delete(dir));
      cloning.set(dir, job);
      return job;
    },
  };
}
