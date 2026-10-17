import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@repo/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import { PROCESS_TEST_TIMEOUT } from "../test/timeouts.ts";
import { commitMessage, createBackupIntegration } from "./backup.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Run git as on a CI runner: no user identity (and none guessed from the host name) and no system or global
// defaults such as init.defaultBranch, so a dev machine's git config can't hide a failure.
const gitEnv = {
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
};
let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), `${BRAND.id}-gitconfig-`));
  const config = join(home, ".gitconfig");
  writeFileSync(config, "[user]\n\tuseConfigOnly = true\n");
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(gitEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const log = (repo: string) => git(repo, "log", "--format=%s", "--all").trim().split("\n").filter(Boolean);

/** A board, an empty bare repo as the remote and an empty folder for the clone. Uses the machine's real git. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), `${BRAND.id}-gitbackup-`));
  dirs.push(root);
  const remote = join(root, "remote.git");
  mkdirSync(remote);
  git(remote, "init", "--quiet", "--bare");
  const clone = join(root, "clone");
  const h = createTestHarness();
  const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const task = h.services.tasks.create({ projectId: project.id, title: "Feature" });
  h.services.settings.update({ backupDir: clone, backupRemote: remote });
  const warnings: string[] = [];
  const backup = createBackupIntegration({
    services: () => h.services,
    attachmentsDir: join(root, "attachments"),
    log: { warn: (m: string) => warnings.push(m) },
  });
  return { ...h, root, remote, clone, task, backup, warnings };
}

// Real git processes are slow on a loaded Windows machine.
describe("git backup", { timeout: PROCESS_TEST_TIMEOUT }, () => {
  it("clones the remote, commits and pushes, and makes no commit when nothing changed", async () => {
    const { backup, remote, services, task } = setup();
    const first = await backup.run();
    expect(first).toMatchObject({ lastError: null, running: false });
    expect(first.lastCommit).toMatch(/^[0-9a-f]+$/);
    expect(first.lastPushAt).not.toBeNull();
    expect(log(remote)).toEqual(["Back up board: 1 added"]);

    const second = await backup.run();
    expect(second.lastCommit).toBe(first.lastCommit);
    expect(log(remote)).toHaveLength(1);

    services.tasks.update(task.id, { title: "Renamed" }, "user");
    await backup.run();
    expect(log(remote)[0]).toBe("Back up board: 1 task changed");
  });

  it("keeps commits locally when a push fails and pushes them on the next run", async () => {
    const { backup, remote, root, clone, services, task } = setup();
    await backup.run();

    services.settings.update({ backupRemote: join(root, "missing.git") });
    services.tasks.update(task.id, { title: "Offline edit" }, "user");
    const failed = await backup.run();
    expect(failed.lastError).toMatch(/git push/);
    expect(log(clone)[0]).toBe("Back up board: 1 task changed");
    expect(log(remote)).toHaveLength(1);

    services.settings.update({ backupRemote: remote });
    const recovered = await backup.run();
    expect(recovered.lastError).toBeNull();
    expect(log(remote)).toHaveLength(2);
  });

  it("pushes everything to a new, empty remote when the remote changes", async () => {
    const { backup, root, services } = setup();
    await backup.run();
    const next = join(root, "next.git");
    mkdirSync(next);
    git(next, "init", "--quiet", "--bare");
    services.settings.update({ backupRemote: next });
    const status = await backup.run();
    expect(status.lastError).toBeNull();
    expect(log(next)).toEqual(["Back up board: 1 added"]);
  });

  it("works without a remote, keeping commits local", async () => {
    const { backup, clone, services } = setup();
    services.settings.update({ backupRemote: null });
    const status = await backup.run();
    expect(status).toMatchObject({ lastError: null, lastPushAt: null });
    expect(log(clone)).toEqual(["Back up board: 1 added"]);
  });

  it("accepts a new repo that only has a README, and pulls commits made on the remote", async () => {
    const { backup, remote, root, services, task } = setup();
    // A repo created on GitHub with "Add a README".
    const seedClone = join(root, "seed");
    mkdirSync(seedClone);
    git(seedClone, "clone", "--quiet", remote, ".");
    writeFileSync(join(seedClone, "README.md"), "Board backup\n");
    git(seedClone, "add", "README.md");
    git(seedClone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "Initial commit");
    git(seedClone, "push", "--quiet", "origin", "HEAD");

    expect((await backup.run()).lastError).toBeNull();
    expect(log(remote)).toEqual(["Back up board: 1 added", "Initial commit"]);

    // Someone edits the README on GitHub; the next run must not be rejected.
    git(seedClone, "pull", "--quiet");
    writeFileSync(join(seedClone, "README.md"), "Board backup, edited\n");
    git(seedClone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-am", "Edit README");
    git(seedClone, "push", "--quiet", "origin", "HEAD");
    services.tasks.update(task.id, { title: "After the edit" }, "user");
    expect((await backup.run()).lastError).toBeNull();
    expect(log(remote).slice(0, 2)).toEqual(["Back up board: 1 task changed", "Edit README"]);
  });

  it("rebases local backups onto a remote added later that already has a README", async () => {
    const { backup, remote, root, clone, services } = setup();
    services.settings.update({ backupRemote: null });
    await backup.run();
    expect(log(clone)).toEqual(["Back up board: 1 added"]);

    const seedClone = join(root, "seed");
    mkdirSync(seedClone);
    git(seedClone, "clone", "--quiet", remote, ".");
    writeFileSync(join(seedClone, "README.md"), "Board backup\n");
    git(seedClone, "add", "README.md");
    git(seedClone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "Initial commit");
    git(seedClone, "push", "--quiet", "origin", "HEAD");

    services.settings.update({ backupRemote: remote });
    const status = await backup.run();
    expect(status.lastError).toBeNull();
    expect(status.lastPushAt).not.toBeNull();
    expect(log(remote)).toEqual(["Back up board: 1 added", "Initial commit"]);
  });

  it("refuses a folder that is someone else's repo", async () => {
    const { backup, clone, warnings } = setup();
    mkdirSync(clone);
    git(clone, "init", "--quiet");
    writeFileSync(join(clone, "notes.txt"), "not a backup\n");
    git(clone, "add", "notes.txt");
    const status = await backup.run();
    expect(status.lastError).toMatch(/other content/);
    expect(warnings).toHaveLength(1);
    expect(status.lastCommit).toBeNull();
  });
});

describe("commitMessage", () => {
  it("counts task files by change", () => {
    expect(
      commitMessage(["M  tasks/2026-10/task-1.json", "A  tasks/2026-10/task-2.json", "M  events/2026-10.json"]),
    ).toBe("Back up board: 1 task changed, 1 added");
    expect(commitMessage(["D  tasks/2026-09/task-3.json"])).toBe("Back up board: 1 removed");
    expect(commitMessage(["M  settings.json"])).toBe("Back up board: settings and history");
  });
});
