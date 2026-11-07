import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, type GitHostStatus } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import { PROCESS_TEST_TIMEOUT } from "../test/timeouts.ts";
import { defaultRunGit } from "./backup.ts";
import { createBackupSetup, remoteFailure } from "./backupSetup.ts";
import { GhError, type RunGh } from "./gh.ts";
import { createGithubHost } from "./githubHost.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const signedIn: GitHostStatus = {
  kind: "github",
  available: true,
  version: "2.96.0",
  authenticated: true,
  error: null,
  accounts: [{ host: "github.com", login: "octocat", authenticated: true }],
};
const noGh: GitHostStatus = {
  kind: "github",
  available: false,
  version: null,
  authenticated: false,
  error: "gh CLI not found",
  accounts: [],
};

function setup(opts: { gh?: GitHostStatus; runGh?: RunGh } = {}) {
  const h = createTestHarness();
  const calls: string[][] = [];
  const runGh: RunGh = async (args, o) => {
    calls.push(args);
    if (opts.runGh) return opts.runGh(args, o);
    throw new GhError("unexpected gh call", false);
  };
  const backupSetup = createBackupSetup({
    services: () => h.services,
    host: { ...createGithubHost({ runGh }), checkStatus: async () => opts.gh ?? signedIn },
    runGit: defaultRunGit,
    defaultDir: "/data/backup",
    instanceId: "11111111-1111-4111-8111-111111111111",
  });
  return { h, setup: backupSetup, calls };
}

describe("backup setup info", () => {
  it("reports gh's account, the default folder and the current setup", async () => {
    const { h, setup: s } = setup();
    h.services.settings.update({ machineName: "laptop" });
    expect(await s.info()).toEqual({
      host: { kind: "github", available: true, signedIn: true, login: "octocat" },
      defaultDir: "/data/backup",
      backupDir: null,
      backupRemote: null,
      machineName: "laptop",
      machineNameIsDefault: false,
      suggestedRepoName: `${BRAND.id}-backup`,
    });
  });

  it("says when gh is missing or signed in elsewhere only", async () => {
    expect((await setup({ gh: noGh }).setup.info()).host).toEqual({
      kind: "github",
      available: false,
      signedIn: false,
      login: null,
    });
    const enterprise: GitHostStatus = {
      ...signedIn,
      accounts: [{ host: "ghe.example.com", login: "me", authenticated: true }],
    };
    expect((await setup({ gh: enterprise }).setup.info()).host).toEqual({
      kind: "github",
      available: true,
      signedIn: false,
      login: null,
    });
  });

  it("served at GET /api/backup/setup-info", async () => {
    const h = createTestHarness();
    const res = await h.request("/api/backup/setup-info");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { defaultDir: string; suggestedRepoName: string };
    expect(body.defaultDir).toMatch(/backup/);
    expect(body.suggestedRepoName).toBe(`${BRAND.id}-backup`);
  });
});

describe("creating a GitHub repo", () => {
  it("creates a private repo and returns its HTTPS clone URL", async () => {
    const { setup: s, calls } = setup({
      runGh: async (args) => (args[0] === "repo" ? "https://github.com/octocat/board-backup\n" : "https\n"),
    });
    expect(await s.createRepo("board-backup")).toEqual({
      url: "https://github.com/octocat/board-backup",
      remote: "https://github.com/octocat/board-backup.git",
    });
    expect(calls[0]?.slice(0, 4)).toEqual(["repo", "create", "board-backup", "--private"]);
  });

  it("uses an SSH remote when gh's git protocol is ssh", async () => {
    const { setup: s } = setup({
      runGh: async (args) => (args[0] === "repo" ? "https://github.com/octocat/board-backup\n" : "ssh\n"),
    });
    expect((await s.createRepo("board-backup")).remote).toBe("git@github.com:octocat/board-backup.git");
  });

  it("says when the account already has a repo of that name", async () => {
    const { setup: s } = setup({
      runGh: async () => {
        throw new GhError("GraphQL: Name already exists on this account (createRepository)", false);
      },
    });
    await expect(s.createRepo("board-backup")).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("octocat already has a repo named board-backup"),
    });
  });

  it("refuses without gh or its sign-in, without running gh", async () => {
    const missing = setup({ gh: noGh });
    await expect(missing.setup.createRepo("x")).rejects.toThrow(/isn't installed/);
    const out = setup({ gh: { ...signedIn, authenticated: false, accounts: [] } });
    await expect(out.setup.createRepo("x")).rejects.toThrow(/gh auth login/);
    expect([...missing.calls, ...out.calls]).toEqual([]);
  });

  it("validates the name at POST /api/backup/github-repo", async () => {
    const h = createTestHarness();
    const res = await h.request("/api/backup/github-repo", { method: "POST", json: { name: "no spaces" } });
    expect(res.status).toBe(400);
  });
});

describe("checking a remote", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

  /** A bare repo, filled from a work tree holding `files` (none leaves it empty). */
  function remote(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), `${BRAND.id}-setup-`));
    dirs.push(root);
    const bare = join(root, "remote.git");
    mkdirSync(bare);
    git(bare, "init", "--quiet", "--bare");
    // The branch filled below, so a clone checks it out.
    git(bare, "symbolic-ref", "HEAD", "refs/heads/trunk");
    if (Object.keys(files).length === 0) return bare;
    const work = join(root, "work");
    mkdirSync(work);
    git(work, "init", "--quiet");
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(join(work, path, ".."), { recursive: true });
      writeFileSync(join(work, path), contents);
    }
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "init");
    git(work, "push", "--quiet", bare, "HEAD:refs/heads/trunk");
    return bare;
  }

  it(
    "reads an empty repo, a backup repo's machines, and someone else's repo",
    async () => {
      const { setup: s } = setup();
      expect(await s.checkRemote(remote({}))).toEqual({
        status: "reachable",
        message: null,
        content: "empty",
        machines: [],
      });
      expect((await s.checkRemote(remote({ "README.md": "# hi\n" }))).content).toBe("empty");
      expect((await s.checkRemote(remote({ "src/index.ts": "" }))).content).toBe("other");

      const manifest = (instanceId: string, machineName: string) =>
        JSON.stringify({ app: BRAND.id, instanceId, machineName });
      const backup = remote({
        "backup.json": JSON.stringify({ app: BRAND.id, repoFormat: 1 }),
        "desktop/manifest.json": manifest("22222222-2222-4222-8222-222222222222", "desktop"),
        "laptop/manifest.json": manifest("11111111-1111-4111-8111-111111111111", "laptop"),
      });
      expect(await s.checkRemote(backup)).toEqual({
        status: "reachable",
        message: null,
        content: "backup",
        machines: [
          {
            folder: "desktop",
            instanceId: "22222222-2222-4222-8222-222222222222",
            machineName: "desktop",
            current: false,
            lastCommitAt: null,
          },
          {
            folder: "laptop",
            instanceId: "11111111-1111-4111-8111-111111111111",
            machineName: "laptop",
            current: true,
            lastCommitAt: null,
          },
        ],
      });
    },
    PROCESS_TEST_TIMEOUT,
  );

  it(
    "says when the repo isn't there",
    async () => {
      const result = await setup().setup.checkRemote(join(tmpdir(), `${BRAND.id}-no-such-repo`, "x.git"));
      expect(result).toMatchObject({ status: "not_found", content: null, machines: [] });
      expect(result.message).toBeTruthy();
    },
    PROCESS_TEST_TIMEOUT,
  );

  it("sorts git's errors", () => {
    expect(remoteFailure("remote: Repository not found.\nfatal: repository '…' not found")).toBe("not_found");
    expect(remoteFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe(
      "auth_failed",
    );
    expect(remoteFailure("git@github.com: Permission denied (publickey).")).toBe("auth_failed");
    expect(remoteFailure("fatal: unable to access '…': Could not resolve host: github.com")).toBe("error");
  });

  it("refuses a remote git would read as an option", async () => {
    const h = createTestHarness();
    const res = await h.request("/api/backup/check-remote", { method: "POST", json: { remote: "--upload-pack=x" } });
    expect(res.status).toBe(400);
  });
});
