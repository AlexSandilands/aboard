import { describe, expect, it } from "vitest";
import { changeAutomationPrompt, createAutomationPrompt, fixRunPrompt, outputTail } from "./automationPrompts.ts";
import { BRAND } from "./brand.ts";
import type { CustomAutomation } from "./customAutomations.ts";

const BOARD = "http://127.0.0.1:5317/";

const custom: CustomAutomation = {
  id: "c-1",
  name: "Nudge stale work",
  trigger: { kind: "stale", status: "in_progress", hours: 48 },
  filters: { projectIds: [], labels: [], epicId: null },
  action: {
    kind: "agent",
    prompt: "Read its plan and notes, then add a note saying what is left.",
    skill: "",
    model: "inherit",
    onPrBranch: false,
    allowedTools: [],
    inputs: [],
    slots: [],
    check: null,
    untrustedItems: true,
  },
  armedAt: "2026-11-01T00:00:00Z",
  armedProjects: {},
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
};

describe("createAutomationPrompt", () => {
  const prompt = createAutomationPrompt({ boardUrl: BOARD });

  it("names the skill and draft_automation, and says a draft isn't active", () => {
    expect(prompt).toContain(`${BRAND.id}-automations`);
    expect(prompt).toContain("draft_automation(automation, note)");
    expect(prompt).toContain("never tell me it is active");
    expect(prompt).toContain("Board: http://127.0.0.1:5317/settings/autopilot");
  });
});

describe("changeAutomationPrompt", () => {
  const automation = { key: "custom:c-1", title: "Nudge stale work" };

  it("hands over a custom automation's id and definition and asks for a replacement draft", () => {
    const prompt = changeAutomationPrompt({
      boardUrl: BOARD,
      automation,
      custom,
      sentence: "When a task has been in In Progress for 48 hours, ask an agent.",
    });
    expect(prompt).toContain("id: c-1");
    expect(prompt).toContain("Today: When a task has been in In Progress for 48 hours");
    expect(prompt).toContain('"name": "Nudge stale work"');
    expect(prompt).toContain("Read its plan and notes");
    expect(prompt).toContain("draft_automation(automation, note)");
    expect(prompt).toContain("?automation=custom%3Ac-1");
  });

  it("sends a built-in's agent to the settings, not to a draft that can't change it", () => {
    const prompt = changeAutomationPrompt({
      boardUrl: BOARD,
      automation: { key: "review_prs", title: "Review PRs" },
      custom: null,
      sentence: "Reviews PRs.",
    });
    expect(prompt).toContain("you can't change its settings");
    expect(prompt).toContain("Settings → Autopilot → Review PRs");
    expect(prompt).not.toContain("```json");
  });
});

describe("fixRunPrompt", () => {
  const run = {
    id: "run-9",
    automation: "custom:c-1",
    summary: "Exited with code 2",
    error: "pnpm: command not found",
    detail: "line 1\nline 2\nboom",
    exitCode: 2,
    dryRun: false,
    taskId: "t-4",
  };

  it("carries the error, the exit code and the output, and how to retry", () => {
    const prompt = fixRunPrompt({
      boardUrl: BOARD,
      run,
      automation: { key: "custom:c-1", title: "Nudge stale work" },
      custom,
      task: "#4 Rate-limit refunds",
    });
    expect(prompt).toContain("Run: run-9 · exit code 2");
    expect(prompt).toContain("Error: pnpm: command not found");
    expect(prompt).toContain("boom");
    expect(prompt).toContain("on #4 Rate-limit refunds");
    expect(prompt).toContain('retry_autopilot_run(task, automation: "custom:c-1")');
    expect(prompt).toContain("draft_automation");
  });

  it("doesn't offer a draft for a built-in or a retry for a run without a task", () => {
    const prompt = fixRunPrompt({
      boardUrl: BOARD,
      run: { ...run, taskId: null, error: null, detail: null, exitCode: null },
      automation: { key: "digest", title: "Digest of what changed" },
      custom: null,
      task: null,
    });
    expect(prompt).not.toContain("draft_automation");
    expect(prompt).not.toContain("retry_autopilot_run");
    expect(prompt).not.toContain("Error:");
  });
});

describe("outputTail", () => {
  it("keeps short output whole and cuts a long one at a line", () => {
    expect(outputTail("a\nb")).toBe("a\nb");
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const tail = outputTail(long, 100);
    expect(tail.startsWith("… line")).toBe(true);
    expect(tail.endsWith("line 399")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(104);
  });
});
