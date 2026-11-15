import { randomUUID } from "node:crypto";
import { RUN_HERE, type MachineRoute } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { renderTaskDetail } from "../mcp/format.ts";
import { createTestHarness } from "../test/harness.ts";

// Where a task runs (remote-machines.md#choosing-the-machine): the task's choice, the project's default, and the lock.

const routes: MachineRoute[] = [{ kind: "ssh", target: "engine", port: null, remotePort: 4318 }];

function setup() {
  const h = createTestHarness();
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const engine = s.machines.add({ instanceId: randomUUID(), name: "engine", routes });
  const task = s.tasks.create({
    projectId: project.id,
    title: "Build it",
    plan: { phases: [{ title: "Build", steps: [{ title: "Do it" }] }] },
    actor: "u",
  });
  return { h, s, project, engine, task };
}

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
};

describe("where a task runs", () => {
  it("sets a task's machine, says so in its activity, and clears it", () => {
    const { s, engine, task } = setup();
    expect(s.tasks.setRunOn(task.id, engine.id, "user").runOn).toBe(engine.id);
    expect(s.tasks.detail(task.id).events.at(-1)).toMatchObject({ type: "run_on", payload: { machine: "engine" } });
    expect(s.tasks.setRunOn(task.id, RUN_HERE, "user").runOn).toBe(RUN_HERE);
    expect(s.tasks.setRunOn(task.id, null, "user").runOn).toBeNull();
  });

  it("refuses a machine the board doesn't have, an epic and a manual task", () => {
    const { s, project, task } = setup();
    expect(codeOf(() => s.tasks.setRunOn(task.id, "nope", "user"))).toBe("VALIDATION");
    const epic = s.tasks.create({ projectId: project.id, title: "Epic", kind: "epic", actor: "u" });
    expect(codeOf(() => s.tasks.setRunOn(epic.id, RUN_HERE, "user"))).toBe("VALIDATION");
    const manual = s.tasks.create({ projectId: project.id, title: "Call", manual: true, actor: "u" });
    expect(codeOf(() => s.tasks.setRunOn(manual.id, RUN_HERE, "user"))).toBe("VALIDATION");
  });

  it("locks once the task has started, and while a machine holds it", () => {
    const { h, s, engine, task } = setup();
    s.tasks.move(task.id, { status: "in_progress" }, "agent");
    expect(codeOf(() => s.tasks.setRunOn(task.id, engine.id, "user"))).toBe("CONFLICT");
    s.tasks.move(task.id, { status: "planned" }, "user");
    h.db
      .prepare("INSERT INTO task_holds (task_id, machine_id, held_at, after_log_id) VALUES (?, ?, ?, 0)")
      .run(task.id, engine.id, new Date().toISOString());
    expect(codeOf(() => s.tasks.setRunOn(task.id, RUN_HERE, "user"))).toBe("CONFLICT");
  });

  it("keeps a project's default, which a machine the board doesn't have can't be", () => {
    const { s, project, engine } = setup();
    expect(s.projects.update(project.id, { runOn: engine.id }).runOn).toBe(engine.id);
    expect(s.projects.update(project.id, { runOn: RUN_HERE }).runOn).toBeNull();
    expect(codeOf(() => s.projects.update(project.id, { runOn: "nope" }))).toBe("VALIDATION");
  });
});

describe("where a task runs, in get_task", () => {
  it("names the machine a task will start on, and that only the user changes it", () => {
    const { s, task } = setup();
    const detail = s.tasks.detail(task.id);
    const text = renderTaskDetail(detail, undefined, { startsOn: { machineName: "engine", source: "project" } });
    expect(text).toContain(
      "Machine: engine (its project's default; Autopilot hands the task to it when it starts the task",
    );
    expect(text).toContain("Only the user changes where a task runs");
    expect(renderTaskDetail(detail, undefined)).not.toContain("Machine:");
  });

  it("says a held task stays on its machine until the user pulls it back", () => {
    const { s, task } = setup();
    const held = { ...s.tasks.detail(task.id), hold: { machineId: "m", machineName: "engine", since: "", waiting: 0 } };
    expect(renderTaskDetail(held, undefined)).toContain("It stays there until the user pulls it back");
  });
});
