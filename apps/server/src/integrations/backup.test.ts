import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, machineNameFrom } from "@repo/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import { PROCESS_TEST_TIMEOUT } from "../test/timeouts.ts";
import { writeDumpDir } from "../services/backup/files.ts";
import { commitMessage, createBackupIntegration, defaultRunGit, type RunGit } from "./backup.ts";

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
function setup(opts: { remote?: string; root?: string; machineName?: string; runGit?: RunGit } = {}) {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), `${BRAND.id}-gitbackup-`));
  if (!opts.root) dirs.push(root);
  const remote = opts.remote ?? join(root, "remote.git");
  if (!opts.remote) {
    mkdirSync(remote);
    git(remote, "init", "--quiet", "--bare");
  }
  const machineName = opts.machineName ?? "laptop";
  const clone = join(root, `clone-${machineName}-${randomUUID().slice(0, 8)}`);
  const h = createTestHarness();
  const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const task = h.services.tasks.create({ projectId: project.id, title: "Feature" });
  h.services.settings.update({ backupDir: clone, backupRemote: remote, machineName });
  const warnings: string[] = [];
  const instanceId = randomUUID();
  const backup = createBackupIntegration({
    services: () => h.services,
    attachmentsDir: join(root, "attachments"),
    instanceId,
    ...(opts.runGit ? { runGit: opts.runGit } : {}),
    log: { warn: (m: string) => warnings.push(m) },
  });
  return { ...h, root, remote, clone, project, task, backup, warnings, instanceId };
}

/** The files at the tip of the remote's default branch. */
const remoteFiles = (remote: string) => git(remote, "ls-tree", "-r", "--name-only", "HEAD").trim().split("\n");

/** A commit's subjects that touched `path`, following renames: the file's history. */
const historyOf = (repo: string, path: string) =>
  git(repo, "log", "--follow", "--format=%s", "--", path).trim().split("\n").filter(Boolean);

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

describe("machine folders", { timeout: PROCESS_TEST_TIMEOUT }, () => {
  it("writes a fresh repo as backup.json and this machine's folder, with its identity in the manifest", async () => {
    const { backup, remote, task, instanceId } = setup();
    expect((await backup.run()).lastError).toBeNull();
    const files = remoteFiles(remote);
    expect(files).toContain("backup.json");
    expect(files).toContain("laptop/manifest.json");
    expect(files.filter((f) => !f.startsWith("laptop/"))).toEqual(["backup.json"]);
    expect(JSON.parse(git(remote, "show", "HEAD:backup.json"))).toEqual({ app: BRAND.id, repoFormat: 1 });
    const manifest = JSON.parse(git(remote, "show", "HEAD:laptop/manifest.json")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ instanceId, machineName: "laptop" });
    expect(files.some((f) => f.startsWith("laptop/tasks/") && f.endsWith(`task-${task.number}.json`))).toBe(true);
  });

  it("moves a flat backup into this machine's folder in its own commit, keeping history, and says so once", async () => {
    const { backup, remote, root, clone, services, task } = setup();
    // A backup made by a version from before machine folders: the dump at the root of the repo.
    const old = join(root, "old");
    mkdirSync(old);
    git(old, "clone", "--quiet", remote, ".");
    writeDumpDir(old, services.backup.dump());
    git(old, "add", "-A");
    git(old, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "Old backup");
    git(old, "push", "--quiet", "origin", "HEAD");
    const taskFile = remoteFiles(remote).find((f) => f.endsWith(`task-${task.number}.json`))!;

    git(root, "clone", "--quiet", remote, clone);
    const status = await backup.run();
    expect(status.lastError).toBeNull();
    expect(log(remote)).toEqual(["Back up board: settings and history", "Move the backup into laptop/", "Old backup"]);
    const files = remoteFiles(remote);
    expect(files.filter((f) => !f.startsWith("laptop/"))).toEqual(["backup.json"]);
    expect(historyOf(clone, `laptop/${taskFile}`)).toEqual(["Move the backup into laptop/", "Old backup"]);
    const notices = services.notifications.list({ kind: "backup_notice" }).items;
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe("Backup moved into laptop/");

    services.tasks.update(task.id, { title: "Later" }, "user");
    await backup.run();
    expect(services.notifications.list({ kind: "backup_notice" }).items).toHaveLength(1);
  });

  it("lets two machines share one remote, even when one committed while the other pushed", async () => {
    const a = setup();
    const b = setup({ root: a.root, remote: a.remote, machineName: "desktop" });
    // The desktop backs up before it is pointed at the remote, so its first commit (with its own backup.json) is
    // made before it has seen the laptop's, and has to be rebased onto it.
    b.services.settings.update({ backupRemote: null });
    expect((await b.backup.run()).lastError).toBeNull();
    expect((await a.backup.run()).lastError).toBeNull();

    b.services.settings.update({ backupRemote: a.remote });
    expect((await b.backup.run()).lastError).toBeNull();
    a.services.tasks.update(a.task.id, { title: "Laptop edit" }, "user");
    b.services.tasks.update(b.task.id, { title: "Desktop edit" }, "user");
    expect((await a.backup.run()).lastError).toBeNull();
    expect((await b.backup.run()).lastError).toBeNull();
    expect((await a.backup.run()).lastError).toBeNull();

    const tops = new Set(remoteFiles(a.remote).map((f) => f.split("/")[0]));
    expect([...tops].sort((x, y) => x!.localeCompare(y!))).toEqual(["backup.json", "desktop", "laptop"]);
    expect(log(a.remote)).toHaveLength(4);

    const machines = await a.backup.machines();
    expect(machines.map((m) => [m.folder, m.current, m.instanceId])).toEqual([
      ["desktop", false, b.instanceId],
      ["laptop", true, a.instanceId],
    ]);
    expect(machines.every((m) => m.lastCommitAt !== null)).toBe(true);
  });

  it("refuses a machine name another machine's folder already has, ignoring case", async () => {
    const a = setup();
    expect((await a.backup.run()).lastError).toBeNull();
    const b = setup({ root: a.root, remote: a.remote, machineName: "Laptop" });
    const status = await b.backup.run();
    expect(status.lastError).toMatch(/already has a folder laptop for another machine.*choose another machine name/);
    expect(status.lastCommit).toBeNull();
    expect(log(a.remote)).toHaveLength(1);
  });

  it("refuses a taken name even when it committed its own folder of that name before seeing the remote", async () => {
    const a = setup();
    const b = setup({ root: a.root, remote: a.remote });
    b.services.settings.update({ backupRemote: null });
    expect((await b.backup.run()).lastError).toBeNull();
    expect((await a.backup.run()).lastError).toBeNull();

    b.services.settings.update({ backupRemote: a.remote });
    const status = await b.backup.run();
    expect(status.lastError).toMatch(/already has a folder laptop for another machine.*choose another machine name/);
    expect(log(a.remote)).toHaveLength(1);

    // Choosing another name, as the error says, recovers: the local commit that wrote into laptop/ is set aside.
    const localHead = git(b.clone, "rev-parse", "HEAD").trim();
    b.services.settings.update({ machineName: "desktop" });
    expect((await b.backup.run()).lastError).toBeNull();
    const kept = git(b.clone, "branch", "--list", "--format=%(refname:short)", "unpushed-backups-*").trim();
    expect(git(b.clone, "rev-parse", kept).trim()).toBe(localHead);
    expect(b.services.notifications.list({ kind: "backup_notice" }).items[0]!.body).toContain(kept);
    expect(JSON.parse(git(a.remote, "show", "HEAD:laptop/manifest.json"))).toMatchObject({ instanceId: a.instanceId });
    expect(JSON.parse(git(a.remote, "show", "HEAD:desktop/manifest.json"))).toMatchObject({
      instanceId: b.instanceId,
    });
    expect((await a.backup.run()).lastError).toBeNull();
  });

  it("sets aside unpushed commits whose folder differs only in case from another machine's", async () => {
    const a = setup({ machineName: "Laptop" });
    // On Windows and macOS the rebase of laptop/ onto another machine's Laptop/ fails; Linux tells the two apart, so
    // the first pull after joining the remote is made to fail the same way.
    let failPull = true;
    const runGit: RunGit = (args, cwd) => {
      if (failPull && args.includes("pull")) {
        failPull = false;
        return Promise.resolve({ code: 1, stdout: "", stderr: "CONFLICT (add/add): laptop/manifest.json" });
      }
      return defaultRunGit(args, cwd);
    };
    const b = setup({ root: a.root, remote: a.remote, runGit });
    b.services.settings.update({ backupRemote: null });
    expect((await b.backup.run()).lastError).toBeNull();
    const localHead = git(b.clone, "rev-parse", "HEAD").trim();
    expect((await a.backup.run()).lastError).toBeNull();

    // Already renamed, as the clash error would have asked.
    b.services.settings.update({ backupRemote: a.remote, machineName: "desktop" });
    expect((await b.backup.run()).lastError).toBeNull();
    const kept = git(b.clone, "branch", "--list", "--format=%(refname:short)", "unpushed-backups-*").trim();
    expect(git(b.clone, "rev-parse", kept).trim()).toBe(localHead);
    const tops = new Set(remoteFiles(a.remote).map((f) => f.split("/")[0]));
    expect([...tops].sort((x, y) => x!.localeCompare(y!))).toEqual(["backup.json", "desktop", "Laptop"]);
  });

  it("keeps the host name's default from the first backup on", async () => {
    const { backup, remote, services } = setup();
    services.settings.update({ machineName: null });
    const name = machineNameFrom(hostname());
    expect((await backup.run()).lastError).toBeNull();
    expect(services.settings.get()).toMatchObject({ machineName: name, machineNameIsDefault: false });
    expect(remoteFiles(remote)).toContain(`${name}/manifest.json`);
  });

  it("renames its folder when only the case of the name changes", async () => {
    // Only the outcome: on a case-sensitive file system `git add` sees the change of case either way.
    const { backup, remote, services } = setup();
    await backup.run();
    services.settings.update({ machineName: "Laptop" });
    expect((await backup.run()).lastError).toBeNull();
    const tops = new Set(remoteFiles(remote).map((f) => f.split("/")[0]));
    expect([...tops].sort((x, y) => x!.localeCompare(y!))).toEqual(["backup.json", "Laptop"]);
  });

  it("renames its folder when the machine is renamed, keeping history", async () => {
    const { backup, remote, clone, services, task } = setup();
    await backup.run();
    const taskFile = remoteFiles(remote)
      .find((f) => f.endsWith(`task-${task.number}.json`))!
      .slice("laptop/".length);

    services.settings.update({ machineName: "work-laptop" });
    expect((await backup.run()).lastError).toBeNull();
    const files = remoteFiles(remote);
    expect(files.some((f) => f.startsWith("laptop/"))).toBe(false);
    expect(files).toContain(`work-laptop/${taskFile}`);
    expect(log(remote).slice(0, 2)).toEqual([
      "Back up board: settings and history",
      "Rename the backup folder laptop/ to work-laptop/",
    ]);
    expect(historyOf(clone, `work-laptop/${taskFile}`)).toEqual([
      "Rename the backup folder laptop/ to work-laptop/",
      "Back up board: 1 added",
    ]);
  });
});

describe("restoring from the backup repo", { timeout: PROCESS_TEST_TIMEOUT }, () => {
  it("lists this machine's commits and reads an older one without touching the clone", async () => {
    const { backup, clone, services, task } = setup();
    await backup.run();
    services.tasks.update(task.id, { title: "Renamed" }, "user");
    await backup.run();
    const history = await backup.history();
    expect(history.map((c) => c.subject)).toEqual(["Back up board: 1 task changed", "Back up board: 1 added"]);
    const head = git(clone, "rev-parse", "HEAD").trim();

    const diff = await backup.diff({ commit: history[1]!.commit });
    expect(diff).toMatchObject({ folder: "laptop", otherMachine: false, counts: { missing: 0, changed: 1 } });
    expect(diff.tasks).toEqual([expect.objectContaining({ number: task.number, title: "Feature", change: "changed" })]);
    // The clone is where it was, with no worktree left behind.
    expect(git(clone, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(git(clone, "worktree", "list").trim().split("\n")).toHaveLength(1);

    await expect(backup.diff({ commit: "--output=x" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(backup.diff({ commit: "deadbeef" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("puts deleted and changed tasks back, reporting each one", async () => {
    const { backup, services, task, project } = setup();
    const other = services.tasks.create({ projectId: project.id, title: "Other" });
    await backup.run();
    services.tasks.update(task.id, { title: "Renamed" }, "user");
    services.tasks.update(other.id, { archived: true }, "user");
    services.tasks.delete(other.id, "user");

    const first = await backup.restoreTasks({ numbers: [other.number, task.number] }, "user");
    expect(first.results).toEqual([
      { number: other.number, ok: true, boardNumber: other.number, error: null },
      { number: task.number, ok: false, boardNumber: null, error: expect.stringMatching(/still on the board/) },
    ]);
    const forced = await backup.restoreTasks({ numbers: [task.number], force: true }, "user");
    expect(forced.results[0]).toMatchObject({ ok: true });
    expect(services.tasks.detail(task.id).title).toBe("Feature");
  });

  it("restores the whole board from another machine's folder, taking the folder over when asked", async () => {
    const root = mkdtempSync(join(tmpdir(), `${BRAND.id}-gitbackup-`));
    dirs.push(root);
    const old = setup({ root, machineName: "old-pc" });
    await old.backup.run();
    const fresh = setup({ root, remote: old.remote, machineName: "new-pc" });
    fresh.services.tasks.update(fresh.task.id, { title: "Only on the new PC" }, "user");
    await fresh.backup.run();

    const diff = await fresh.backup.diff({ machine: "old-pc" });
    expect(diff.otherMachine).toBe(true);
    await expect(fresh.backup.restoreBoard({ machine: "old-pc", confirm: "RESTORE" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    fresh.events.length = 0;
    const result = await fresh.backup.restoreBoard({
      machine: "old-pc",
      confirm: "RESTORE",
      otherMachine: "take-over",
    });
    expect(result).toMatchObject({ tookOver: "old-pc", safetyCopy: null });
    expect(fresh.events).toContainEqual({ type: "board.reset" });
    expect(fresh.services.tasks.detail(old.task.id).title).toBe("Feature");
    expect(fresh.services.settings.get().machineName).toBe("old-pc");

    // The run it started writes the folder as this board's, so later runs don't refuse the name. It runs git, which
    // takes far longer than waitFor's default second on a Windows runner.
    await vi.waitFor(() => expect(fresh.backup.status().running).toBe(false), { timeout: PROCESS_TEST_TIMEOUT });
    const status = await fresh.backup.run();
    expect(status.lastError).toBeNull();
    const machines = await fresh.backup.machines();
    expect(machines.find((m) => m.folder === "old-pc")).toMatchObject({ instanceId: fresh.instanceId, current: true });
  });
});

describe("commitMessage", () => {
  it("counts task files by change", () => {
    expect(
      commitMessage(["M  tasks/2026-10/task-1.json", "A  tasks/2026-10/task-2.json", "M  events/2026-10.json"]),
    ).toBe("Back up board: 1 task changed, 1 added");
    expect(commitMessage(["D  tasks/2026-09/task-3.json"])).toBe("Back up board: 1 removed");
    expect(commitMessage(["M  settings.json"])).toBe("Back up board: settings and history");
    expect(commitMessage(["A  laptop/tasks/2026-10/task-4.json"])).toBe("Back up board: 1 added");
  });
});
