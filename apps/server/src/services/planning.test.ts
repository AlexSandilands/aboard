import type { StartT3ThreadInput, TaskLink } from "@repo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import { planSkillFor, tasksToPlan } from "./planning.ts";

type Harness = ReturnType<typeof createTestHarness>;

const plan = { phases: [{ title: "Build", steps: [{ title: "Do it" }] }] };
const LAUNCH = {
  prompt: "Plan them",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [] },
  runtimeMode: "full-access",
  workspace: { mode: "current" },
} as const;

describe("bulk planning", () => {
  let h: Harness;
  let projectId: string;

  beforeEach(() => {
    h = createTestHarness();
    projectId = h.services.projects.create({ title: "Alpha" }).id;
  });
  afterEach(() => h.db.close());

  const task = (title: string, extra: Record<string, unknown> = {}) =>
    h.services.tasks.create({ projectId, title, ...extra });

  it("takes Backlog and plan-less tasks of the project, in order and once each", () => {
    const a = task("A");
    const b = task("B");
    // In Backlog with a plan already: it can still be re-planned before it starts.
    h.services.plans.setPlan(b.id, plan, "user");
    const tasks = tasksToPlan(h.services, projectId, [`#${b.number}`, a.id, b.id]);
    expect(tasks.map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it("refuses planned tasks, epics, archived, done and other projects' tasks, naming each", () => {
    const planned = task("Planned", { plan });
    h.services.tasks.move(planned.id, { status: "planned" }, "user");
    const epic = task("Epic", { kind: "epic" });
    const archived = task("Old");
    h.services.tasks.update(archived.id, { archived: true }, "user");
    const foreign = h.services.tasks.create({
      projectId: h.services.projects.create({ title: "Beta" }).id,
      title: "F",
    });
    const refs = [planned.id, epic.id, archived.id, foreign.id];
    expect(() => tasksToPlan(h.services, projectId, refs)).toThrow(
      `#${planned.number} already has a plan; #${epic.number} is an epic: plan its tasks instead; #${archived.number} is archived; #${foreign.number} is in another project`,
    );
  });

  it("follows the project's skill, else the board's", () => {
    expect(planSkillFor(h.services, projectId)).toEqual({ source: "builtin" });
    const global = { source: "global", name: "plan-loop", path: "/home/me/.claude/skills/plan-loop/SKILL.md" } as const;
    h.services.settings.update({ planSkill: global });
    expect(planSkillFor(h.services, projectId)).toEqual(global);
    const local = { source: "project", name: "ours", path: "/work/.claude/skills/ours/SKILL.md" } as const;
    h.services.projects.update(projectId, { planSkill: local });
    expect(planSkillFor(h.services, projectId)).toEqual(local);
    expect(h.services.settings.get().planSkill).toEqual(global);
  });

  it("starts one T3 thread for the tasks and links it to each", async () => {
    const a = task("A");
    const b = task("B");
    const started: Array<{ input: StartT3ThreadInput; title: string }> = [];
    h.integrations.startT3ProjectThread = (_id, input, title) => {
      started.push({ input, title });
      return Promise.resolve({ environmentId: "env-1", threadId: "th-plan" });
    };
    const res = await h.request(`/api/projects/${projectId}/plan-thread`, {
      method: "POST",
      json: { ...LAUNCH, taskIds: [a.id, b.id] },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as TaskLink[]).map((l) => l.taskId)).toEqual([a.id, b.id]);
    expect(started).toHaveLength(1);
    expect(started[0]!.title).toBe(`Planning #${a.number}, #${b.number}: Alpha`);
    expect(started[0]!.input).not.toHaveProperty("taskIds");
    for (const id of [a.id, b.id]) {
      expect(h.services.tasks.summary(id).links).toMatchObject([
        { kind: "t3_thread", ref: { environmentId: "env-1", threadId: "th-plan" } },
      ]);
    }
  });

  it("starts no thread when a task can't be planned", async () => {
    const a = task("A");
    const epic = task("Epic", { kind: "epic" });
    let started = 0;
    h.integrations.startT3ProjectThread = () => {
      started++;
      return Promise.resolve({ environmentId: "env-1", threadId: "th" });
    };
    const res = await h.request(`/api/projects/${projectId}/plan-thread`, {
      method: "POST",
      json: { ...LAUNCH, taskIds: [a.id, epic.id] },
    });
    expect(res.status).toBe(400);
    expect(started).toBe(0);
    const empty = await h.request(`/api/projects/${projectId}/plan-thread`, {
      method: "POST",
      json: { ...LAUNCH, taskIds: [] },
    });
    expect(empty.status).toBe(400);
  });
});
