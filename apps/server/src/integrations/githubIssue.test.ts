import { describe, expect, it } from "vitest";
import { GhError } from "./gh.ts";
import { createGithubIntegration, parseGhIssue } from "./github.ts";

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
});
