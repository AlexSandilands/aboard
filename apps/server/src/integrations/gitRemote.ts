import type { RunGit } from "./backup.ts";

/**
 * The host and repository an `origin` URL names (`https://github.com/acme/app.git`, `git@github.com:acme/app`),
 * lower-cased, or null for anything else (a local path): then there is nothing to compare a PR's repository with.
 */
export function remoteRepo(url: string): { host: string; repo: string } | null {
  const match =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(url) ??
    /^[^@/\s]+@([^:/\s]+):(.+?)(?:\.git)?\/?$/.exec(url);
  return match ? { host: match[1]!.toLowerCase(), repo: match[2]!.toLowerCase() } : null;
}

/** The web address of the repository an `origin` URL names, `https://<host>/<repo>`, or "" when it names none. */
export function repoWebUrl(url: string): string {
  const repo = remoteRepo(url.trim());
  return repo ? `https://${repo.host}/${repo.repo}` : "";
}

/** How long a folder's repository URL is kept before `origin` is read again, so a changed remote shows up. */
const REPO_URL_TTL_MS = 10 * 60_000;

export type RepoUrls = (workspaceRoot: string | null) => Promise<string>;

/**
 * The repository URL of each project folder, from its `origin`, cached per folder: custom automations read it on
 * every pass. "" when there is no folder, no git or no `origin`; never throws, since a missing URL never stops a run.
 */
export function createRepoUrls(runGit: RunGit, now: () => number = Date.now): RepoUrls {
  const cache = new Map<string, { at: number; url: Promise<string> }>();
  return (workspaceRoot) => {
    if (!workspaceRoot) return Promise.resolve("");
    const hit = cache.get(workspaceRoot);
    if (hit && now() - hit.at < REPO_URL_TTL_MS) return hit.url;
    const url = runGit(["remote", "get-url", "origin"], workspaceRoot)
      .then((result) => (result.code === 0 ? repoWebUrl(result.stdout) : ""))
      .catch(() => "");
    cache.set(workspaceRoot, { at: now(), url });
    return url;
  };
}
