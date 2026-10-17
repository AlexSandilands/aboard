import { describe, expect, it } from "vitest";
import { GhError } from "./gh.ts";
import { createGithubIntegration, parseGhIssue, parseSubIssueUrls } from "./github.ts";

const json = (value: unknown) => JSON.stringify(value);

describe("parseGhIssue", () => {
  it("reads the title, body, label names and state", () => {
    expect(
      parseGhIssue(json({ title: "T", body: null, state: "CLOSED", labels: [{ name: "bug", color: "f00" }] })),
    ).toEqual({ title: "T", body: "", labels: ["bug"], state: "closed" });
    expect(parseGhIssue(json({ title: "T", body: "B", state: "OPEN" }))).toMatchObject({ labels: [], state: "open" });
  });

  it("throws on output that isn't an issue", () => {
    expect(() => parseGhIssue("not json")).toThrow("isn't JSON");
    expect(() => parseGhIssue(json({ state: "OPEN" }))).toThrow("unexpected issue shape");
  });
});

describe("parseSubIssueUrls", () => {
  it("reads one URL per line, once each, skipping anything else", () => {
    const stdout = [
      "https://github.com/acme/app/issues/46",
      "https://github.com/acme/lib/issues/2\r",
      "",
      "null",
      "https://github.com/acme/app/issues/46",
    ].join("\n");
    expect(parseSubIssueUrls(stdout)).toEqual([
      "https://github.com/acme/app/issues/46",
      "https://github.com/acme/lib/issues/2",
    ]);
    expect(parseSubIssueUrls("")).toEqual([]);
  });
});

describe("fetchIssue", () => {
  const integration = (runGh: (args: string[]) => Promise<string>) =>
    createGithubIntegration({
      services: () => {
        throw new Error("not used");
      },
      runGh,
    });

  it("asks gh for the issue, naming the host only when it isn't github.com", async () => {
    const calls: string[][] = [];
    const gh = integration((args) => {
      calls.push(args);
      return Promise.resolve(json({ title: "T", body: "B", state: "OPEN", labels: [] }));
    });
    await gh.fetchIssue({ host: "github.com", repo: "acme/app", number: 45 });
    await gh.fetchIssue({ host: "ghe.example.com", repo: "team/svc", number: 8 });
    expect(calls[0]).toEqual(["issue", "view", "45", "--repo", "acme/app", "--json", "title,body,labels,state"]);
    expect(calls[1]![4]).toBe("ghe.example.com/team/svc");
  });

  it("explains a missing gh and a failed read", async () => {
    const missing = integration(() => Promise.reject(new GhError("gh CLI not found", true)));
    await expect(missing.fetchIssue({ host: "github.com", repo: "a/b", number: 1 })).rejects.toThrow(
      "GitHub CLI (gh) is not installed",
    );
    const failing = integration(() => Promise.reject(new GhError("Could not resolve to an issue", false)));
    await expect(failing.fetchIssue({ host: "github.com", repo: "a/b", number: 1 })).rejects.toThrow(
      "Could not read a/b#1: Could not resolve to an issue",
    );
  });

  it("pages through the sub-issues, naming the host only when it isn't github.com", async () => {
    const calls: string[][] = [];
    const gh = integration((args) => {
      calls.push(args);
      return Promise.resolve("https://ghe.example.com/team/svc/issues/9\n");
    });
    expect(await gh.fetchSubIssues({ host: "github.com", repo: "acme/app", number: 45 })).toEqual([
      "https://ghe.example.com/team/svc/issues/9",
    ]);
    await gh.fetchSubIssues({ host: "ghe.example.com", repo: "team/svc", number: 8 });
    expect(calls[0]).toEqual([
      "api",
      "--paginate",
      "repos/acme/app/issues/45/sub_issues?per_page=100",
      "--jq",
      ".[].html_url",
    ]);
    expect(calls[1]!.slice(0, 3)).toEqual(["api", "--hostname", "ghe.example.com"]);
    const failing = integration(() => Promise.reject(new GhError("HTTP 404", false)));
    await expect(failing.fetchSubIssues({ host: "github.com", repo: "a/b", number: 1 })).rejects.toThrow(
      "Could not read the sub-issues of a/b#1: HTTP 404",
    );
  });
});
