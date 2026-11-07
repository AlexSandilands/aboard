import { GITHUB_HOST, type GitHostStatus } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import type { GitHost } from "./gitHost.ts";
import { createGitHosts, gitHostActions } from "./gitHosts.ts";

/** A GitHub-kind host whose CLI is signed in to `signedIn`; only what the registry reads is real. */
function fakeHost(signedIn: string[]): GitHost & { ensured: number } {
  const status: GitHostStatus = {
    kind: "github",
    available: true,
    version: "2.96.0",
    authenticated: signedIn.length > 0,
    error: null,
    accounts: signedIn.map((host) => ({ host, login: "me", authenticated: true })),
  };
  const host = {
    kind: "github",
    definition: GITHUB_HOST,
    ensured: 0,
    status: () => status,
    checkStatus: async () => status,
    async ensureStatus() {
      host.ensured += 1;
      return status;
    },
    claims: (h: string) => GITHUB_HOST.claimsHost(h) || signedIn.includes(h.toLowerCase()),
    reaches: (h: string) => signedIn.includes(h.toLowerCase()),
    holdsTasks: (h: string) => h === "github.com" || signedIn.includes(h),
    requireSignedIn: async () => {},
    prHead: async () => "abc",
    agentHints: () => ({ checks: "checks" }),
  };
  return host as unknown as GitHost & { ensured: number };
}

describe("GitHosts", () => {
  it("finds the kind a host is by its name, or by the CLI being signed in to it", () => {
    const github = fakeHost(["github.com", "git.example.com"]);
    const hosts = createGitHosts([github]);
    expect(hosts.forHost("github.com")).toBe(github);
    expect(hosts.forHost("acme.ghe.com")).toBe(github);
    expect(hosts.forHost("github.example.com")).toBe(github);
    expect(hosts.forHost("git.example.com")).toBe(github);
    expect(hosts.forHost("gitlab.com")).toBeNull();
  });

  it("reads the status before giving up on a host no kind claims by name", async () => {
    const github = fakeHost(["git.example.com"]);
    const hosts = createGitHosts([github]);
    expect(await hosts.resolve("github.com")).toBe(github);
    expect(github.ensured).toBe(0);
    expect(await hosts.resolve("git.example.com")).toBe(github);
    expect(await hosts.resolve("gitlab.com")).toBeNull();
    expect(github.ensured).toBe(2);
  });

  it("holds tasks only for hosts a kind serves", () => {
    const hosts = createGitHosts([fakeHost(["git.example.com"])]);
    expect(hosts.holdsTasks("github.com")).toBe(true);
    expect(hosts.holdsTasks("git.example.com")).toBe(true);
    expect(hosts.holdsTasks("gitlab.com")).toBe(false);
  });

  it("lists each kind's status", () => {
    expect(createGitHosts([fakeHost(["github.com"])]).statuses()).toMatchObject([
      { kind: "github", authenticated: true, accounts: [{ host: "github.com" }] },
    ]);
  });

  it("sends actions to the host serving the PR, and refuses one no kind serves", async () => {
    const actions = gitHostActions(createGitHosts([fakeHost(["github.com"])]), {
      mergeIntoEpicBranch: () => Promise.reject(new Error("no")),
    });
    expect(await actions.prHead({ host: "github.com", repo: "o/r", number: 1 })).toBe("abc");
    await expect(actions.prHead({ host: "gitlab.com", repo: "o/r", number: 1 })).rejects.toThrow(
      "GitHub CLI (gh) is not signed in to gitlab.com: run `gh auth login --hostname gitlab.com`",
    );
  });
});
