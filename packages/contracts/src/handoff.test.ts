import { describe, expect, it } from "vitest";
import { BRAND } from "./brand.ts";
import { defaultHandoffMode, handoffModeError, taskBoardUrl, taskHandoffPrompt, taskReferenceLine } from "./handoff.ts";
import { EMPTY_MODEL_TIERS, type SuggestedModel } from "./modelTiers.ts";

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

describe("subagent work prompt", () => {
  const suggestedModel: SuggestedModel = { tier: "light", reason: "Small" };
  const prompt = taskHandoffPrompt({
    task: { ...task, suggestedModel },
    boardUrl: "http://x",
    mode: "work",
    subagent: true,
  });

  it("reports back instead of asking the user or running the review loop", () => {
    expect(prompt).toContain("You are a subagent");
    expect(prompt).toContain(`Call get_task("abc-123")`);
    expect(prompt).toContain("mark the step blocked");
    expect(prompt).toContain(
      "don't run the review loop and don't open a pull request, even though the result describes the loop and a self-review",
    );
    expect(prompt).toContain("end your reply with a short report");
  });

  it("leaves out the model line and T3 thread linking, which belong to the orchestrator", () => {
    expect(prompt).not.toContain("Suggested model");
    expect(prompt).not.toContain("link(t3Thread");
    expect(prompt).toContain("Don't link a T3 thread");
  });
});

describe("orchestrate prompt", () => {
  const epic = { id: "epic-1", number: 7, title: "Epics", kind: "epic" as const };
  const prompt = taskHandoffPrompt({ task: epic, boardUrl: "http://x", mode: "orchestrate" });

  it("starts from the epic overview and plans unplanned tasks with the user first", () => {
    expect(prompt).toContain(`Let's run the epic #7 "Epics"`);
    expect(prompt).toContain(`epic_overview("epic-1")`);
    expect(prompt).toContain("save each with set_plan (with suggestedModel) and move_task it to planned");
  });

  it("offers subagents first, then prompts to paste, without assuming one harness", () => {
    const subagents = prompt.indexOf("get_handoff_prompt(task, subagent: true)");
    const manual = prompt.indexOf("give me get_handoff_prompt(task)");
    expect(subagents).toBeGreaterThan(0);
    expect(manual).toBeGreaterThan(subagents);
    expect(prompt).toContain("Claude Code's Agent tool, Copilot CLI's subagents, or your harness's equivalent");
    expect(prompt).toContain("own git worktree");
  });

  it("runs the review loop for subagent tasks and leaves the epic itself alone", () => {
    expect(prompt).toContain("call start_review(task) for the open round's reviewer brief");
    expect(prompt).toContain("fresh reviewer subagent working in the task's worktree");
    expect(prompt).toContain("resolve_finding");
    expect(prompt).toContain("the board's own reviewer has it");
    expect(prompt).toContain("Don't set_plan, move or review the epic itself");
  });

  it("links the orchestrator's own thread to the epic unless the board already did", () => {
    expect(prompt).toContain("link this thread to #7");
    const linked = taskHandoffPrompt({ task: epic, boardUrl: "http://x", mode: "orchestrate", linkedThread: true });
    expect(linked).toContain("already linked to the epic");
    expect(linked).not.toContain("t3Thread");
  });
});

describe("handoffModeError", () => {
  it("orchestrates epics only, and gives subagents work prompts only", () => {
    expect(handoffModeError({ number: 7, kind: "epic" }, "orchestrate")).toBeNull();
    expect(handoffModeError({ number: 7, kind: "epic" }, "work")).toContain("is an epic");
    expect(handoffModeError({ number: 9, kind: "task" }, "orchestrate")).toContain("isn't an epic");
    expect(handoffModeError({ number: 9 }, "work", true)).toBeNull();
    expect(handoffModeError({ number: 9 }, "plan", true)).toContain("Only work prompts go to subagents");
  });
});

describe("defaultHandoffMode", () => {
  it("orchestrates epics", () => {
    expect(defaultHandoffMode({ kind: "epic", status: "backlog", progress: { done: 0, total: 0 } })).toBe(
      "orchestrate",
    );
  });

  it("plans backlog and plan-less tasks, works otherwise", () => {
    expect(defaultHandoffMode({ status: "backlog", progress: { done: 0, total: 3 } })).toBe("plan");
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

describe("suggested model in the prompt", () => {
  const tiers = {
    ...EMPTY_MODEL_TIERS,
    standard: {
      description: null,
      t3: { selection: { instanceId: "claude", model: "sonnet", options: [] }, label: "Claude Sonnet 5.5" },
    },
    deep: { description: "Opus 5.5, high effort", t3: null },
  };

  it("names the tier's description, else its T3 label, else the bare tier, in a copied work prompt", () => {
    const work = (suggestedModel: SuggestedModel, modelTiers = tiers) =>
      taskHandoffPrompt({ task: { ...task, suggestedModel }, boardUrl: "http://x", mode: "work", modelTiers });
    expect(work({ tier: "deep", reason: "Touches the migration runner." })).toContain(
      "Suggested model: deep (Opus 5.5, high effort): Touches the migration runner. Switch your session's model if it differs.",
    );
    expect(work({ tier: "standard", reason: null })).toContain("Suggested model: standard (Claude Sonnet 5.5). Switch");
    expect(work({ tier: "light", reason: null })).toContain("Suggested model: light. Switch");
  });

  it("leaves it out of planning prompts, board-started threads and tasks without one", () => {
    const suggested = { ...task, suggestedModel: { tier: "deep" as const, reason: null } };
    expect(taskHandoffPrompt({ task: suggested, boardUrl: "http://x", mode: "plan" })).not.toContain("Suggested model");
    expect(
      taskHandoffPrompt({ task: suggested, boardUrl: "http://x", mode: "work", linkedThread: true }),
    ).not.toContain("Suggested model");
    expect(taskHandoffPrompt({ task, boardUrl: "http://x", mode: "work" })).not.toContain("Suggested model");
  });
});
