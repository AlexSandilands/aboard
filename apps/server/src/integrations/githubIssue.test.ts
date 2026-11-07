import { describe, expect, it } from "vitest";
import { GhError, type RunGh } from "./gh.ts";
import { createGitHosts, gitHostIssues } from "./gitHosts.ts";
import { createGithubHost } from "./githubHost.ts";
import type { FetchFn } from "./t3.ts";

/** gh signed in to github.com and ghe.example.com, handing out a token; `missing` when it isn't installed. */
const runGh =
  (missing = false): RunGh =>
  async (args) => {
    if (missing) throw new GhError("gh CLI not found", true);
    if (args[0] === "--version") return "gh version 2.96.0";
    if (args[0] === "auth" && args[1] === "status") {
      const hosts = ["github.com", "ghe.example.com"];
      return JSON.stringify({
        hosts: Object.fromEntries(hosts.map((host) => [host, [{ state: "success", active: true, host, login: "me" }]])),
      });
    }
    if (args[0] === "auth" && args[1] === "token") return ["fake", "credential", args[3]].join("-");
    throw new GhError(`unexpected gh ${args.join(" ")}`, false);
  };

function issues(handler: (url: string) => Response, opts: { missing?: boolean } = {}) {
  const urls: string[] = [];
  const fetch: FetchFn = async (url) => {
    urls.push(url);
    return handler(url);
  };
  const host = createGithubHost({ runGh: runGh(opts.missing), fetch });
  return { urls, issues: gitHostIssues(createGitHosts([host])) };
}

describe("reading an issue to import", () => {
  it("reads the title, body, label names and state from the issue's own host", async () => {
    const { urls, issues: read } = issues(() =>
      Response.json({
        number: 45,
        html_url: "https://github.com/acme/app/issues/45",
        title: "T",
        body: null,
        state: "closed",
        user: { login: "ana" },
        labels: [{ name: "bug", color: "f00" }, "chore"],
      }),
    );
    expect(await read.getIssue({ host: "github.com", repo: "acme/app", number: 45 })).toMatchObject({
      title: "T",
      body: "",
      labels: ["bug", "chore"],
      state: "closed",
    });
    await read.getIssue({ host: "ghe.example.com", repo: "team/svc", number: 8 });
    expect(urls).toEqual([
      "https://api.github.com/repos/acme/app/issues/45",
      "https://ghe.example.com/api/v3/repos/team/svc/issues/8",
    ]);
  });

  it("explains a missing gh and a failed read", async () => {
    const missing = issues(() => Response.json({}), { missing: true }).issues;
    await expect(missing.getIssue({ host: "github.com", repo: "a/b", number: 1 })).rejects.toThrow(
      "GitHub CLI (gh) is not installed",
    );
    const failing = issues(() => Response.json({ message: "Not Found" }, { status: 404 })).issues;
    await expect(failing.getIssue({ host: "github.com", repo: "a/b", number: 1 })).rejects.toThrow(
      "Could not read a/b#1: Not Found",
    );
  });

  it("sends no request, so no token, to a host gh isn't signed in to", async () => {
    const { urls, issues: read } = issues(() => Response.json({}));
    const ref = { host: "github.attacker.example", repo: "a/b", number: 1 };
    await expect(read.getIssue(ref)).rejects.toThrow(
      "GitHub CLI (gh) is not signed in to github.attacker.example: run `gh auth login --hostname github.attacker.example`",
    );
    await expect(read.listSubIssues(ref)).rejects.toThrow(/not signed in to github\.attacker\.example/);
    expect(urls).toEqual([]);
  });

  it("pages through the sub-issues, once each", async () => {
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ html_url: `https://github.com/acme/app/issues/${from + i}` }));
    const { urls, issues: read } = issues((url) =>
      Response.json(url.endsWith("&page=1") ? page(100, 100) : [...page(1, 300), ...page(1, 100)]),
    );
    const subIssues = await read.listSubIssues({ host: "github.com", repo: "acme/app", number: 45 });
    expect(subIssues).toHaveLength(101);
    expect(subIssues.at(-1)).toBe("https://github.com/acme/app/issues/300");
    expect(urls).toEqual([
      "https://api.github.com/repos/acme/app/issues/45/sub_issues?per_page=100&page=1",
      "https://api.github.com/repos/acme/app/issues/45/sub_issues?per_page=100&page=2",
    ]);
    const failing = issues(() => Response.json({ message: "Not Found" }, { status: 404 })).issues;
    await expect(failing.listSubIssues({ host: "github.com", repo: "a/b", number: 1 })).rejects.toThrow(
      "Could not read the sub-issues of a/b#1: Not Found",
    );
  });
});
