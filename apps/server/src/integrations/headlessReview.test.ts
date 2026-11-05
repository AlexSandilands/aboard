import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentJob } from "./headlessAgent.ts";
import { createHeadlessReviewer, headlessArgs, headlessPrompt, parseHeadlessOutput } from "./headlessReview.ts";

const codexAnswer = (text: string) =>
  [
    JSON.stringify({ type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" }),
    JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");

describe("headless review", () => {
  it("runs read-only, without MCP servers, within the budget", () => {
    const args = headlessArgs(1.5);
    expect(args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--no-session-persistence"]));
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("1.5");
    expect(args).toContain("Bash(git diff *)");
    expect(args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--disallowedTools") + 4)).toEqual([
      "Edit",
      "Write",
      "NotebookEdit",
    ]);
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toMatchObject({ required: ["summary", "findings"] });
  });

  it("runs the chosen model, or the CLI's default when there is none", () => {
    const args = headlessArgs(1.5, "sonnet");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(headlessArgs(1.5, null)).not.toContain("--model");
    expect(headlessArgs(1.5)).not.toContain("--model");
  });

  it("passes the chosen effort, and none otherwise", () => {
    const args = headlessArgs(1.5, "sonnet", "high");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(headlessArgs(1.5, "sonnet")).not.toContain("--effort");
    expect(headlessArgs(1.5, null, null)).not.toContain("--effort");
  });

  it("may read the folders it is given, and none otherwise", () => {
    const args = headlessArgs(1.5, null, null, ["/data/attachments/t1"]);
    expect(args.slice(args.indexOf("--add-dir"), args.indexOf("--add-dir") + 2)).toEqual([
      "--add-dir",
      "/data/attachments/t1",
    ]);
    expect(headlessArgs(1.5)).not.toContain("--add-dir");
  });

  it("tells the reviewer to open the screenshots only when the task has some", () => {
    const input = {
      taskNumber: 7,
      round: 1,
      taskText: "#7",
      skill: { source: "global" as const, name: "review-loop", path: "/h/SKILL.md" },
      baseRef: null,
    };
    expect(headlessPrompt({ ...input, hasImages: true })).toContain("Open each one (with the Read tool");
    expect(headlessPrompt(input)).not.toContain("screenshots");
  });

  it("puts the task inline and diffs against the base branch", () => {
    const prompt = headlessPrompt({
      taskNumber: 7,
      round: 2,
      taskText: "#7 Add exports [Review]",
      skill: { source: "global", name: "review-loop", path: "/h/skills/review-loop/SKILL.md" },
      baseRef: "origin/main",
    });
    expect(prompt).toContain("review round 2");
    expect(prompt).toContain("`git merge-base HEAD origin/main`");
    expect(prompt).not.toContain("$(");
    expect(prompt).toContain('"review-loop" at /h/skills/review-loop/SKILL.md');
    expect(prompt).toContain("#7 Add exports [Review]");
  });

  it("reviews on Codex, read-only and isolated, with the findings schema in strict form", async () => {
    const jobs: AgentJob[] = [];
    let schema: unknown = null;
    const review = createHeadlessReviewer(async (job) => {
      jobs.push(job);
      schema = JSON.parse(readFileSync(job.args[job.args.indexOf("--output-schema") + 1]!, "utf8"));
      return codexAnswer(
        JSON.stringify({
          summary: "One bug",
          findings: [{ severity: "major", title: "Off by one", file: "a.ts", line: 3, body: null, suggestion: null }],
        }),
      );
    });
    const out = await review({
      provider: "codex",
      cli: "/opt/codex",
      cwd: "/w",
      prompt: "p",
      budgetUsd: 1,
      model: "gpt-5.5",
      effort: "high",
    });
    expect(out).toEqual({
      summary: "One bug",
      findings: [{ severity: "major", title: "Off by one", file: "a.ts", line: 3 }],
      costUsd: null,
    });
    const job = jobs[0]!;
    expect(job).toMatchObject({ cli: "/opt/codex", command: "codex", label: "Codex", cwd: "/w" });
    expect(job.args).toEqual(
      expect.arrayContaining(["--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "--ephemeral"]),
    );
    expect(job.args).toEqual(expect.arrayContaining(["--model", "gpt-5.5", "-c", "model_reasoning_effort=high"]));
    expect(schema).toMatchObject({ additionalProperties: false, required: ["summary", "findings"] });
  });

  it("names the provider when its review fails or doesn't fit the schema", async () => {
    const failing = createHeadlessReviewer(async () =>
      JSON.stringify({ type: "turn.failed", error: { message: "rate limited" } }),
    );
    const job = { provider: "codex", cli: null, cwd: "/w", prompt: "p", budgetUsd: 1, model: null } as const;
    await expect(failing(job)).rejects.toThrow("Codex's review failed: rate limited");
    const odd = createHeadlessReviewer(async () => codexAnswer(JSON.stringify({ summary: 3 })));
    await expect(odd(job)).rejects.toThrow("Codex's result didn't match the expected shape");
  });

  it("keeps Claude Code's own reviewer argv", async () => {
    const jobs: AgentJob[] = [];
    const review = createHeadlessReviewer(async (job) => {
      jobs.push(job);
      return JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: { summary: "ok", findings: [] },
      });
    });
    await review({ cli: null, cwd: "/w", prompt: "p", budgetUsd: 2, model: "sonnet" });
    expect(jobs[0]!.args).toEqual(headlessArgs(2, "sonnet", null, []));
  });

  it("parses structured findings and surfaces failures", () => {
    const ok = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.42,
      structured_output: { summary: "One bug", findings: [{ severity: "major", title: "Off by one", line: 3 }] },
    });
    expect(parseHeadlessOutput(`warning: something\n${ok}\n`)).toEqual({
      summary: "One bug",
      findings: [{ severity: "major", title: "Off by one", line: 3 }],
      costUsd: 0.42,
    });
    const budget = JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true });
    expect(() => parseHeadlessOutput(budget)).toThrow("error max budget usd");
    expect(() => parseHeadlessOutput("")).toThrow("no JSON result");
  });
});
