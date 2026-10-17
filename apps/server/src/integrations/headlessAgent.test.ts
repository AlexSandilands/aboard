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
    expect(args).not.toContain("--name");
    expect(args).not.toContain("--no-session-persistence");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--json-schema");
    expect(args).toEqual(expect.arrayContaining(["Bash", "Edit", `mcp__${BRAND.id}`]));
  });

  it("names the session", () => {
    const args = agentArgs({
      access: "edit",
      budgetUsd: 3,
      sessionId: SESSION,
      model: null,
      name: "Autopilot · Fix PRs · PR #7",
      defaultBranch: null,
    });
    expect(after(args, "--name")).toBe("Autopilot · Fix PRs · PR #7");
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

  it("keeps a read-only agent that reads untrusted text to its worktree, away from MCP servers", () => {
    const base = { access: "read-only", budgetUsd: 1, sessionId: SESSION, model: null, defaultBranch: null } as const;
    const open = agentArgs(base);
    expect(open).toContain(`mcp__${BRAND.id}`);
    expect(open).toContain("Read");
    expect(open).not.toContain("--strict-mcp-config");
    const closed = agentArgs({ ...base, untrusted: true });
    expect(closed).not.toContain(`mcp__${BRAND.id}`);
    expect(closed).toContain("--strict-mcp-config");
    // File tools only reach the working directory: a bare Read would reach any file the user can.
    expect(closed).toEqual(expect.arrayContaining(["Read(./**)", "Grep(./**)", "Glob(./**)"]));
    for (const bare of ["Read", "Grep", "Glob"]) expect(closed).not.toContain(bare);
    // The checkout's own settings (allow rules, hooks) must not apply.
    expect(closed.slice(closed.indexOf("--setting-sources"), closed.indexOf("--setting-sources") + 2)).toEqual([
      "--setting-sources",
      "user",
    ]);
    // And only the built-in tools it needs, whatever the user's own settings allow.
    expect(closed.slice(closed.indexOf("--tools"), closed.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "Read,Grep,Glob,Bash",
    ]);
    expect(open).not.toContain("--tools");
    // git only in exact forms: diff, show and log take any path, and --output= writes to it.
    const allowed = closed.slice(closed.indexOf("--allowedTools") + 1, closed.indexOf("--disallowedTools"));
    const git = allowed.filter((t) => t.startsWith("Bash(git"));
    expect(git).toEqual(["Bash(git rev-parse HEAD)", "Bash(git status --short)", "Bash(git log --oneline -20)"]);
    expect(git.some((t) => t.includes("*"))).toBe(false);
    // Untrusted only means something for a read-only agent.
    expect(agentArgs({ ...base, access: "edit", untrusted: true })).not.toContain("--strict-mcp-config");
    expect(open).not.toContain("--setting-sources");
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
    expect(args).toContain("--no-session-persistence");
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
