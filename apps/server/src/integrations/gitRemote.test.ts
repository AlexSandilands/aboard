import { describe, expect, it } from "vitest";
import type { GitResult } from "./backup.ts";
import { createRepoUrls, remoteRepo, repoWebUrl } from "./gitRemote.ts";

describe("remoteRepo", () => {
  it("reads the host and repository of the URL forms git remotes use", () => {
    const want = { host: "github.com", repo: "acme/app" };
    expect(remoteRepo("https://github.com/acme/app.git")).toEqual(want);
    expect(remoteRepo("https://user:token@GitHub.com/Acme/App/")).toEqual(want);
    expect(remoteRepo("git@github.com:acme/app.git")).toEqual(want);
    expect(remoteRepo("ssh://git@github.com:22/acme/app")).toEqual(want);
    expect(remoteRepo("https://github.example.io/acme/app")).toEqual({ host: "github.example.io", repo: "acme/app" });
    // A local path names no repository to compare with.
    expect(remoteRepo(String.raw`C:\Users\me\origin.git`)).toBeNull();
    expect(remoteRepo("/srv/git/app.git")).toBeNull();
  });
});

describe("repoWebUrl", () => {
  it("gives the web address without credentials, and nothing for a local path", () => {
    expect(repoWebUrl("git@github.com:acme/app.git\n")).toBe("https://github.com/acme/app");
    expect(repoWebUrl("https://user:secret@github.com/acme/app.git")).toBe("https://github.com/acme/app");
    expect(repoWebUrl("/srv/git/app.git")).toBe("");
  });
});

describe("createRepoUrls", () => {
  const ok = (stdout: string): GitResult => ({ code: 0, stdout, stderr: "" });

  it("reads origin once per folder until it goes stale, and is empty without a folder or remote", async () => {
    let calls = 0;
    let clock = 0;
    const urls = createRepoUrls(
      async (_args, cwd) => {
        calls += 1;
        if (cwd === "/none") return { code: 2, stdout: "", stderr: "No such remote 'origin'" };
        if (cwd === "/broken") throw new Error("git not found");
        return ok("git@github.com:acme/app.git\n");
      },
      () => clock,
    );
    expect(await urls(null)).toBe("");
    expect(await urls("/app")).toBe("https://github.com/acme/app");
    expect(await urls("/app")).toBe("https://github.com/acme/app");
    expect(calls).toBe(1);
    clock += 11 * 60_000;
    await urls("/app");
    expect(calls).toBe(2);
    expect(await urls("/none")).toBe("");
    expect(await urls("/broken")).toBe("");
  });
});
