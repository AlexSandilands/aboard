import { describe, expect, it } from "vitest";
import { BRAND } from "./brand.ts";
import {
  BUILTIN_PLAN_SKILL_BODY,
  planningSessionLabel,
  planTasksPrompt,
  planTasksShortPrompt,
  taskNumberList,
} from "./planPrompt.ts";

const project = { id: "p-1", title: "Billing API" };
const tasks = [
  { id: "t-3", number: 3, title: "Add invoices" },
  { id: "t-4", number: 4, title: "Fix rounding" },
  { id: "t-7", number: 7, title: "Export CSV" },
];

describe("planTasksPrompt", () => {
  it("lists every task with its get_task call and embeds the built-in skill", () => {
    const prompt = planTasksPrompt({ project, tasks, skill: { source: "builtin" }, boardUrl: "http://x//" });
    expect(prompt).toContain(`Let's plan 3 tasks in the Billing API project on the ${BRAND.id} task board together.`);
    expect(prompt).toContain("Board: http://x/");
    expect(prompt).toContain('- #3 "Add invoices": get_task("t-3")');
    expect(prompt).toContain('- #7 "Export CSV": get_task("t-7")');
    expect(prompt).toContain("Don't implement anything.");
    expect(prompt).toContain(BUILTIN_PLAN_SKILL_BODY.trim());
    expect(prompt).toContain('label: "Planning #3, #4, #7"');
  });

  it("points at a chosen skill instead of embedding the built-in one", () => {
    const skill = { source: "project" as const, name: "plan-it", path: "/repo/.claude/skills/plan-it/SKILL.md" };
    const prompt = planTasksPrompt({ project, tasks, skill, boardUrl: "http://x" });
    expect(prompt).toContain('read the skill "plan-it" at /repo/.claude/skills/plan-it/SKILL.md and follow it');
    expect(prompt).not.toContain("# Planning tasks");
  });

  it("tells a board-started session it is already linked", () => {
    const prompt = planTasksPrompt({
      project,
      tasks,
      skill: { source: "builtin" },
      boardUrl: "http://x",
      linked: true,
    });
    expect(prompt).toContain("already linked it to every task");
    expect(prompt).not.toContain("link(task, t3Thread");
  });

  it("speaks of one task in the singular", () => {
    const prompt = planTasksPrompt({ project, tasks: tasks.slice(0, 1), skill: { source: "builtin" }, boardUrl: "x" });
    expect(prompt).toContain("Let's plan a task in the Billing API project");
  });
});

describe("planning helpers", () => {
  it("joins task numbers for prose and labels", () => {
    expect(taskNumberList(tasks)).toBe("#3, #4 and #7");
    expect(taskNumberList(tasks.slice(0, 1))).toBe("#3");
    expect(planningSessionLabel(tasks)).toBe("Planning #3, #4, #7");
  });

  it("has a short prompt that fetches the full one over MCP", () => {
    const short = planTasksShortPrompt(tasks);
    expect(short).toContain('get_handoff_prompt(tasks: ["#3", "#4", "#7"], mode: "plan")');
    expect(short).toContain("don't link it again");
    expect(short).not.toMatch(/[%\n]/);
  });

  it("prints the plan before asking, and restates it last", () => {
    expect(BUILTIN_PLAN_SKILL_BODY).toContain("Print the plan first");
    expect(BUILTIN_PLAN_SKILL_BODY).toContain("Only then ask");
    expect(BUILTIN_PLAN_SKILL_BODY).toContain("restate what was saved");
  });
});
