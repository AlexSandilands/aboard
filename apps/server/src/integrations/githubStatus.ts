import type { GitHostAccount, GitHostStatus } from "@repo/contracts";
import { GITHUB_HOST } from "@repo/contracts";
import { GhError, type RunGh } from "./gh.ts";
import { parseGhAuthStatus } from "./githubApi.ts";
import { messageOf } from "./util.ts";

// Whether gh is installed and which hosts it is signed in to: what decides which PRs are polled and where a token may
// be sent (ADR 0006).

export const GH_STATUS_INTERVAL_MS = 10 * 60_000;

const NOT_SIGNED_IN = `gh is not authenticated (run \`${GITHUB_HOST.cli.loginCommand()}\`)`;

/** "2.96.0" from `gh version 2.96.0 (2026-10-01)`, or null when gh printed something else. */
export function parseGhVersion(stdout: string): string | null {
  return /\bgh version (\S+)/.exec(stdout)?.[1] ?? null;
}

export interface GhStatus {
  /** The last status read; the first call starts a check. */
  current(): GitHostStatus;
  check(): Promise<GitHostStatus>;
  /** The status, read again when older than GH_STATUS_INTERVAL_MS. */
  ensure(): Promise<GitHostStatus>;
  /** The hosts gh is signed in to, on the last status read. */
  signedInHosts(): GitHostAccount[];
  /**
   * Whether gh is signed in to the host, so its token may be sent there. A gh too old to list hosts only vouches for
   * github.com: an env token such as GH_ENTERPRISE_TOKEN would otherwise go to any host a link names.
   */
  signedInTo(host: string): boolean;
}

export function createGhStatus(runGh: RunGh): GhStatus {
  let status: GitHostStatus = {
    kind: "github",
    available: false,
    version: null,
    authenticated: false,
    error: null,
    accounts: [],
  };
  let checkedAt = 0;
  let checking: Promise<GitHostStatus> | null = null;

  const read = async (): Promise<GitHostStatus> => {
    const base = { kind: "github" as const };
    let version: string | null;
    try {
      version = parseGhVersion(await runGh(["--version"], { timeoutMs: 10_000 }));
    } catch (error) {
      const notFound = error instanceof GhError && error.notFound;
      return {
        ...base,
        available: false,
        version: null,
        authenticated: false,
        error: notFound ? "gh CLI not found" : messageOf(error),
        accounts: [],
      };
    }
    let stdout: string;
    try {
      stdout = await runGh(["auth", "status", "--json", "hosts"], { timeoutMs: 15_000 });
    } catch (error) {
      // gh exits non-zero when a login has gone bad, but still prints every host.
      stdout = error instanceof GhError ? error.stdout : "";
    }
    const accounts = parseGhAuthStatus(stdout);
    if (accounts) {
      const authenticated = accounts.some((h) => h.authenticated);
      return {
        ...base,
        available: true,
        version,
        authenticated,
        error: authenticated ? null : NOT_SIGNED_IN,
        accounts,
      };
    }
    // A gh too old for `--json`: fall back to the exit code, which can't say which hosts.
    try {
      await runGh(["auth", "status"], { timeoutMs: 15_000 });
      return { ...base, available: true, version, authenticated: true, error: null, accounts: [] };
    } catch {
      return { ...base, available: true, version, authenticated: false, error: NOT_SIGNED_IN, accounts: [] };
    }
  };

  const check = (): Promise<GitHostStatus> => {
    checking ??= read().then((next) => {
      status = next;
      checkedAt = Date.now();
      checking = null;
      return next;
    });
    return checking;
  };

  const signedInHosts = () => status.accounts.filter((h) => h.authenticated);

  return {
    current() {
      if (checkedAt === 0 && !checking) void check();
      return status;
    },
    check,
    ensure: async () => (checkedAt === 0 || Date.now() - checkedAt > GH_STATUS_INTERVAL_MS ? check() : status),
    signedInHosts,
    signedInTo: (host) =>
      status.accounts.length === 0
        ? status.authenticated && host === "github.com"
        : signedInHosts().some((h) => h.host === host),
  };
}
