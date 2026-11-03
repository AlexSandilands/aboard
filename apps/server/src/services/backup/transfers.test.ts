import { randomUUID } from "node:crypto";
import type { MachineInfo, TaskTransfer } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../../test/harness.ts";
import { transfersIn } from "./transfers.ts";

const NO_INFO: MachineInfo = { remotes: {}, busyTaskIds: [] };
const SOURCE = { folder: "laptop", instanceId: "laptop-id" };

/** A board to take tasks from, and one to bring them onto. */
function boards() {
  const from = createTestHarness({ instanceId: SOURCE.instanceId });
  const to = createTestHarness();
  const fromProject = from.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const task = from.services.tasks.create({ projectId: fromProject.id, title: "Feature" });
  const toProject = to.services.projects.create({ title: "Elsewhere", workspaceRoot: "/desk/alpha" });
  return { from, to, fromProject, toProject, task };
}

const options = (
  overrides: Partial<Parameters<ReturnType<typeof boards>["to"]["services"]["backup"]["importTasks"]>[2]> = {},
) => ({
  mode: "move" as const,
  projectMap: {},
  source: SOURCE,
  machineName: "desktop",
  info: NO_INFO,
  remotes: new Map<string, string>(),
  attachmentsFrom: null,
  actor: "user",
  ...overrides,
});

describe("importing tasks from another machine", () => {
  it("matches projects by id, then remote, then name, and asks for the rest", () => {
    const { from, to, fromProject, toProject } = boards();
    const named = to.services.projects.create({ title: "alpha " });
    const dump = from.services.backup.dump();
    expect(to.services.backup.matchProjects(dump, NO_INFO, new Map())).toEqual([
      { id: fromProject.id, title: "Alpha", remote: null, matchId: named.id, matchedBy: "name" },
    ]);
    const info = { ...NO_INFO, remotes: { [fromProject.id]: "github.com/me/alpha" } };
    expect(
      to.services.backup.matchProjects(dump, info, new Map([[toProject.id, "github.com/me/alpha"]]))[0],
    ).toMatchObject({ matchId: toProject.id, matchedBy: "remote", remote: "github.com/me/alpha" });

    const other = createTestHarness();
    other.services.projects.create({ title: "Beta" });
    expect(other.services.backup.matchProjects(dump, NO_INFO, new Map())[0]).toMatchObject({
      matchId: null,
      matchedBy: null,
    });
  });

  it("matches the same project only while it is live here", () => {
    const { from, fromProject } = boards();
    const dump = from.services.backup.dump();
    expect(from.services.backup.matchProjects(dump, NO_INFO, new Map())[0]).toMatchObject({
      matchId: fromProject.id,
      matchedBy: "id",
    });
    from.services.projects.update(fromProject.id, { archived: true });
    expect(from.services.backup.matchProjects(dump, NO_INFO, new Map())[0]).toMatchObject({
      matchId: null,
      matchedBy: null,
    });
  });

  it("needs a project for tasks whose project didn't match, and takes the one picked", () => {
    const { from, to, fromProject, toProject, task } = boards();
    const dump = from.services.backup.dump();
    const [unmatched] = to.services.backup.importTasks(dump, [task.id], options());
    expect(unmatched).toMatchObject({ ok: false, error: "Pick a project here for Alpha" });

    const [picked] = to.services.backup.importTasks(
      dump,
      [task.id],
      options({ projectMap: { [fromProject.id]: toProject.id } }),
    );
    expect(picked).toMatchObject({ ok: true, boardNumber: 1, error: null, warning: null });
    expect(to.services.tasks.detail(task.id)).toMatchObject({ projectId: toProject.id, number: 1, title: "Feature" });
  });

  it("refuses to move a task with work going on, and warns when copying it", () => {
    const { from, to, fromProject, toProject, task } = boards();
    const dump = from.services.backup.dump();
    const busy = { ...NO_INFO, busyTaskIds: [task.id] };
    const projectMap = { [fromProject.id]: toProject.id };
    expect(to.services.backup.offer(dump, busy)[0]).toMatchObject({ busy: true, onBoard: "no" });
    const [moved] = to.services.backup.importTasks(dump, [task.id], options({ info: busy, projectMap }));
    expect(moved).toMatchObject({ ok: false, error: expect.stringMatching(/Autopilot run was going on it/) });
    const [copied] = to.services.backup.importTasks(dump, [task.id], options({ mode: "copy", info: busy, projectMap }));
    expect(copied).toMatchObject({ ok: true, warning: expect.stringMatching(/carries on there/) });
  });

  it("leaves T3 thread and agent session links behind, keeps the rest, and the epic only if it is here", () => {
    const { from, to, fromProject, toProject, task } = boards();
    const epic = from.services.tasks.create({ projectId: fromProject.id, title: "Epic", kind: "epic" });
    from.services.tasks.update(task.id, { epicId: epic.id }, "user");
    from.services.links.add(task.id, { value: "https://github.com/me/alpha/pull/7" }, "user");
    from.services.links.add(
      task.id,
      { agentSession: { harness: "claude-code", sessionId: randomUUID(), cwd: "/work/alpha" } },
      "user",
    );
    const dump = from.services.backup.dump();
    const [result] = to.services.backup.importTasks(
      dump,
      [task.id],
      options({ projectMap: { [fromProject.id]: toProject.id } }),
    );
    expect(result).toMatchObject({ ok: true, warning: "1 T3 thread or agent session link left behind." });
    const detail = to.services.tasks.detail(task.id);
    expect(detail.links.map((l) => l.kind)).toEqual(["pr"]);
    expect(detail.parent).toBeNull();
    expect(detail.events.find((e) => e.type === "imported")?.payload).toMatchObject({
      mode: "move",
      from: "laptop",
      fromNumber: task.number,
      droppedLinks: 1,
    });

    // Brought in with its epic, it goes back into it.
    const other = boards();
    const otherEpic = other.from.services.tasks.create({ projectId: other.fromProject.id, title: "E", kind: "epic" });
    other.from.services.tasks.update(other.task.id, { epicId: otherEpic.id }, "user");
    const results = other.to.services.backup.importTasks(
      other.from.services.backup.dump(),
      [other.task.id, otherEpic.id],
      options({ projectMap: { [other.fromProject.id]: other.toProject.id } }),
    );
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(other.to.services.tasks.detail(other.task.id).parent?.id).toBe(otherEpic.id);
  });
});

describe("applyTransfer", () => {
  const transfer = (taskId: string, overrides: Partial<TaskTransfer> = {}): TaskTransfer => ({
    transferId: randomUUID(),
    taskId,
    from: "laptop",
    fromInstanceId: SOURCE.instanceId,
    fromNumber: 1,
    sourceUpdatedAt: "2999-01-01T00:00:00.000Z",
    toMachine: "desktop",
    toInstanceId: "desktop-id",
    toNumber: 57,
    at: new Date().toISOString(),
    ...overrides,
  });

  it("archives the task once, says where it went, and ignores other boards' transfers", () => {
    const { from, task } = boards();
    const move = transfer(task.id);
    expect(from.services.backup.applyTransfer({ ...move, fromInstanceId: "someone-else" }, { actor: "backup" })).toBe(
      "not_ours",
    );
    expect(from.services.backup.applyTransfer(move, { actor: "backup" })).toBe("archived");
    expect(from.services.backup.applyTransfer(move, { actor: "backup" })).toBe("already_applied");
    const detail = from.services.tasks.detail(task.id);
    expect(detail.archivedAt).not.toBeNull();
    expect(detail.movedTo).toEqual({ machine: "desktop", number: 57, at: move.at });
    expect(detail.events.filter((e) => e.type === "moved_away")).toHaveLength(1);
    expect(from.services.notifications.list().items).toEqual([]);
    // Kept in the dump, so the source's backup says which transfers it has acted on.
    expect(from.services.backup.dump().applied_transfers).toEqual([
      expect.objectContaining({ transfer_id: move.transferId, outcome: "archived" }),
    ]);
  });

  it("acts on moves recorded against the folder it backs up to, whichever board owned it then", () => {
    const { from, task } = boards();
    // This board took the laptop's folder over: the move names the board that backed up to it before.
    const move = transfer(task.id, { fromInstanceId: "old-laptop-board" });
    expect(from.services.backup.applyTransfer(move, { actor: "backup", folder: "work" })).toBe("not_ours");
    expect(from.services.backup.applyTransfer(move, { actor: "backup", folder: "Laptop" })).toBe("archived");
  });

  it("won't move a task again from a copy that already moved away, and flags two moves that crossed", () => {
    const { from, task } = boards();
    from.services.backup.applyTransfer(transfer(task.id), { actor: "backup" });
    const dump = from.services.backup.dump();
    const third = createTestHarness();
    third.services.projects.create({ title: "Alpha" });
    expect(third.services.backup.offer(dump, NO_INFO)[0]).toMatchObject({
      movedTo: { machine: "desktop", number: 57 },
    });
    const [moved] = third.services.backup.importTasks(dump, [task.id], options());
    expect(moved).toMatchObject({
      ok: false,
      error: "laptop already moved it to desktop as #57; move it from desktop",
    });
    const [copied] = third.services.backup.importTasks(dump, [task.id], options({ mode: "copy" }));
    expect(copied).toMatchObject({ ok: true, warning: expect.stringMatching(/from before that/) });

    // A second board took it from an older backup before this one had applied the first move.
    const crossed = transfer(task.id, { toMachine: "work", toNumber: 3 });
    expect(from.services.backup.applyTransfer(crossed, { actor: "backup" })).toBe("archived");
    expect(from.services.notifications.list().items).toEqual([
      expect.objectContaining({ title: `#${task.number} was moved to both desktop and work` }),
    ]);
  });

  it("forgets where a task went once it is unarchived here", () => {
    const { from, task } = boards();
    from.services.backup.applyTransfer(transfer(task.id), { actor: "backup" });
    from.services.tasks.update(task.id, { archived: false }, "user");
    expect(from.services.tasks.detail(task.id).movedTo).toBeNull();
  });

  it("still archives a task that changed after the backup it was taken from, and tells the inbox", () => {
    const { from, task } = boards();
    const move = transfer(task.id, { sourceUpdatedAt: "2000-01-01T00:00:00.000Z" });
    expect(from.services.backup.applyTransfer(move, { actor: "backup" })).toBe("archived");
    expect(from.services.notifications.list().items).toEqual([
      expect.objectContaining({ kind: "backup_notice", taskId: task.id, title: expect.stringMatching(/changes left/) }),
    ]);
  });

  it("skips a move older than this board's own move of the task back here", () => {
    const { from, task } = boards();
    // The desktop took the task, then the laptop moved it back before it had seen the first move.
    const away = transfer(task.id, { at: "2026-01-01T00:00:00.000Z" });
    const desktop = createTestHarness({ instanceId: "desktop-id" });
    desktop.services.projects.create({ title: "Alpha" });
    desktop.services.backup.importTasks(from.services.backup.dump(), [task.id], options({ mode: "copy" }));
    const [back] = from.services.backup.importTasks(desktop.services.backup.dump(), [task.id], {
      ...options(),
      source: { folder: "desktop", instanceId: "desktop-id" },
      machineName: "laptop",
    });
    // It is still live here, so it can't come back over itself.
    expect(back).toMatchObject({ ok: false });
    from.services.tasks.update(task.id, { archived: true }, "user");
    const [returned] = from.services.backup.importTasks(desktop.services.backup.dump(), [task.id], {
      ...options(),
      source: { folder: "desktop", instanceId: "desktop-id" },
      machineName: "laptop",
    });
    expect(returned).toMatchObject({ ok: true, boardNumber: task.number });
    expect(from.services.backup.applyTransfer(away, { actor: "backup" })).toBe("skipped");
    expect(from.services.tasks.detail(task.id).archivedAt).toBeNull();
  });

  it("reads transfers from every folder once, oldest first", () => {
    const row = (id: string, at: string) => ({
      transfer_id: id,
      task_id: "t",
      from_machine: "laptop",
      from_instance_id: null,
      from_number: 1,
      source_updated_at: at,
      to_machine: "desktop",
      to_instance_id: "d",
      to_number: 2,
      at,
    });
    const list = transfersIn([
      [row("b", "2026-02-01"), row("a", "2026-03-01")],
      [row("b", "2026-02-01"), { transfer_id: "broken" }],
    ]);
    expect(list.map((t) => t.transferId)).toEqual(["b", "a"]);
  });
});
