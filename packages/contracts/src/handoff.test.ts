import { describe, expect, it } from "vitest";
import { BRAND } from "./brand.ts";
import { defaultHandoffMode, taskBoardUrl, taskHandoffPrompt, taskReferenceLine } from "./handoff.ts";

const task = { id: "abc-123", number: 9, title: "Hand tasks to agents" };

describe("taskHandoffPrompt", () => {
  it("points a work session at the task and the skill", () => {
    const prompt = taskHandoffPrompt({ task, boardUrl: "http://127.0.0.1:5317/", mode: "work" });
    expect(prompt).toContain(`Let's work on #9 "Hand tasks to agents" from the ${BRAND.id} task board.`);
    expect(prompt).toContain("Board: http://127.0.0.1:5317/?task=abc-123");
    expect(prompt).toContain(`Call get_task("abc-123") on the ${BRAND.id} MCP server first`);
    expect(prompt).toContain("add_note");
    expect(prompt).not.toContain("already linked");
    expect(prompt).toContain("link(t3Thread: {environmentId, threadId})");
    expect(prompt).toContain("Jira issue");
  });

  it("asks a planning session to collaborate and not implement", () => {
    const prompt = taskHandoffPrompt({ task, boardUrl: "http://x", mode: "plan" });
    expect(prompt).toContain("Let's plan #9");
    expect(prompt).toContain("Ask me clarifying questions");
    expect(prompt).toContain("set_plan");
    expect(prompt).toContain("Don't implement anything yet.");
  });

  it("tells a board-started thread it is already linked, instead of asking it to link itself", () => {
    const prompt = taskHandoffPrompt({ task, boardUrl: "http://x", mode: "work", linkedThread: true });
    expect(prompt).toContain("already linked to the task");
    expect(prompt).not.toContain("t3Thread");
  });

  it("asks a planning session to link itself too", () => {
    expect(taskHandoffPrompt({ task, boardUrl: "http://x", mode: "plan" })).toContain("link(t3Thread:");
  });
});

describe("defaultHandoffMode", () => {
  it("plans ideas and plan-less tasks, works otherwise", () => {
    expect(defaultHandoffMode({ status: "idea", progress: { done: 0, total: 3 } })).toBe("plan");
    expect(defaultHandoffMode({ status: "planned", progress: { done: 0, total: 0 } })).toBe("plan");
    expect(defaultHandoffMode({ status: "in_progress", progress: { done: 1, total: 3 } })).toBe("work");
  });
});

it("taskBoardUrl encodes the id and trims trailing slashes", () => {
  expect(taskBoardUrl("http://h:1//", "a b")).toBe("http://h:1/?task=a%20b");
});

it("taskReferenceLine points at the task by uuid", () => {
  expect(taskReferenceLine({ task, boardUrl: "http://127.0.0.1:5317/" })).toBe(
    [
      `#9 "Hand tasks to agents"`,
      "Board: http://127.0.0.1:5317/?task=abc-123",
      `Call get_task("abc-123") on the ${BRAND.id} MCP server, then continue from the current step.`,
    ].join("\n"),
  );
});
