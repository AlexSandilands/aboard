import { BRAND } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { agentArgs, parseAgentOutput, pushDenyRules } from "./headlessAgent.ts";

const SESSION = "11111111-2222-4333-8444-555555555555";
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("headless agent", () => {
  it("auto-accepts edits within the budget, keeps its session and reaches the board", () => {
    const args = agentArgs({
      access: "edit",
      budgetUsd: 3,
      sessionId: SESSION,
      model: "sonnet",
      defaultBranch: "main",
    });
    expect(after(args, "--permission-mode")).toBe("acceptEdits");
    expect(after(args, "--max-budget-usd")).toBe("3");
    expect(after(args, "--session-id")).toBe(SESSION);
    expect(after(args, "--model")).toBe("sonnet");
    expect(args).not.toContain("--no-session-persistence");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--json-schema");
    expect(args).toEqual(expect.arrayContaining(["Bash", "Edit", `mcp__${BRAND.id}`]));
  });

  it("runs read-only with extra tools and a schema", () => {
    const args = agentArgs({
      access: "read-only",
      budgetUsd: 1,
      sessionId: SESSION,
      model: null,
      defaultBranch: null,
      tools: ["Bash(gh pr review *)"],
      outputSchema: { type: "object" },
    });
    expect(after(args, "--permission-mode")).toBe("dontAsk");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("Bash");
    expect(args).toEqual(expect.arrayContaining(["Bash(git diff *)", "Bash(gh pr review *)"]));
    expect(args.slice(args.indexOf("--disallowedTools") + 1).slice(0, 3)).toEqual(["Edit", "Write", "NotebookEdit"]);
    expect(JSON.parse(after(args, "--json-schema")!)).toEqual({ type: "object" });
  });

  it("can have no tools at all: none built in, no MCP servers, nothing allowed", () => {
    const args = agentArgs({
      access: "none",
      budgetUsd: 1,
      sessionId: SESSION,
      model: null,
      defaultBranch: null,
      tools: ["Bash(gh pr review *)"],
    });
    expect(after(args, "--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(after(args, "--permission-mode")).toBe("dontAsk");
    expect(args).not.toContain("--allowedTools");
    for (const tool of ["Read", "Bash(gh pr review *)", `mcp__${BRAND.id}`]) expect(args).not.toContain(tool);
  });

  it("denies force-pushes, pushes to the default branch and merging, in every written form", () => {
    const rules = pushDenyRules("main");
    for (const rule of [
      "Bash(git push --force*)",
      "Bash(git push * --force*)",
      "Bash(git push * -f)",
      "Bash(git push * +*)",
      "Bash(git -C * push * --force*)",
      "Bash(git push * main)",
      "Bash(git push * *:main)",
      "Bash(git push * *:refs/heads/main)",
      "Bash(git -C * push * main)",
      "Bash(gh pr merge*)",
    ]) {
      expect(rules).toContain(rule);
    }
    // A rule ending in ":*" is Claude Code's prefix syntax and would deny every push.
    expect(rules.filter((r) => r.endsWith(":*)"))).toEqual([]);
    expect(pushDenyRules(null).some((r) => r.includes("main"))).toBe(false);
    const args = agentArgs({ access: "edit", budgetUsd: 1, sessionId: SESSION, model: null, defaultBranch: "main" });
    expect(args.slice(args.indexOf("--disallowedTools") + 1)).toEqual(expect.arrayContaining(rules));
  });

  it("reads the outcome, with the cost even when the run stopped", () => {
    const ok = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Opened PR #9",
      session_id: SESSION,
      total_cost_usd: 1.25,
    });
    expect(parseAgentOutput(`noise\n${ok}`, false)).toEqual({
      ok: true,
      error: null,
      result: "Opened PR #9",
      output: undefined,
      sessionId: SESSION,
      costUsd: 1.25,
    });
    const budget = JSON.stringify({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 3.01 });
    expect(parseAgentOutput(budget, false)).toMatchObject({ ok: false, error: "error max budget usd", costUsd: 3.01 });
    expect(parseAgentOutput(JSON.stringify({ subtype: "success", result: "x" }), true)).toMatchObject({ ok: false });
    expect(() => parseAgentOutput("", false)).toThrow("no JSON result");
  });
});
