import { z } from "zod";

// The git hosts the board talks to for pull requests, issues and the backup repo. Each kind has a pure definition
// here (what to call things, which CLI signs in, which hosts are its own) that the server and the web app share; the
// server's GitHost (apps/server/src/integrations/gitHost.ts) carries the behaviour. Only GitHub exists today
// (docs/decisions/0014-git-hosts.md).

export const GitHostKind = z.enum(["github"]);
export type GitHostKind = z.infer<typeof GitHostKind>;

export interface GitHostDefinition {
  kind: GitHostKind;
  /** The host's name, as people say it: "GitHub". */
  label: string;
  /** What the host calls a pull request, short ("PR") and in full ("pull request"). */
  terminology: { short: string; long: string };
  /** The CLI the board borrows its sign-in from. */
  cli: {
    /** The command: "gh". */
    name: string;
    /** "GitHub CLI". */
    label: string;
    /** The command that signs it in, to a given host when there is one. */
    loginCommand(host?: string): string;
  };
  /**
   * Whether a host name is this kind's without asking its CLI. Any other host is this kind's only once the CLI is
   * signed in to it, since any URL with `/owner/repo/pull/n` parses as a PR.
   */
  claimsHost(host: string): boolean;
}

export const GITHUB_HOST: GitHostDefinition = {
  kind: "github",
  label: "GitHub",
  terminology: { short: "PR", long: "pull request" },
  cli: {
    name: "gh",
    label: "GitHub CLI",
    loginCommand: (host) => (host ? `gh auth login --hostname ${host}` : "gh auth login"),
  },
  // github.com, GHE.com data residency, and Enterprise Server instances named for it (`github.example.com`).
  claimsHost(host) {
    const h = host.toLowerCase();
    return h === "github.com" || h.endsWith(".ghe.com") || h.split(".").includes("github");
  },
};

export const GIT_HOST_DEFINITIONS: Record<GitHostKind, GitHostDefinition> = { github: GITHUB_HOST };

export const gitHostDefinition = (kind: GitHostKind): GitHostDefinition => GIT_HOST_DEFINITIONS[kind];

/** One host the CLI holds a login for. */
export const GitHostAccount = z.object({
  host: z.string(),
  login: z.string().nullable(),
  authenticated: z.boolean(),
});
export type GitHostAccount = z.infer<typeof GitHostAccount>;

/** One git host kind as the board can use it now: its CLI, and the hosts that CLI is signed in to. */
export const GitHostStatus = z.object({
  kind: GitHostKind,
  /** Whether the CLI is installed. */
  available: z.boolean(),
  /** The CLI's version, when it reports one. */
  version: z.string().nullable(),
  /** Signed in to at least one host. */
  authenticated: z.boolean(),
  error: z.string().nullable(),
  /** Hosts the CLI holds a login for. Empty when it is too old to report them. */
  accounts: z.array(GitHostAccount),
});
export type GitHostStatus = z.infer<typeof GitHostStatus>;
