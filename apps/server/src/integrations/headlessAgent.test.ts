import { ACTOR_HEADER, BRAND } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { RUN_SERVER_NAME } from "../mcp/runTokens.ts";
import {
  agentArgs,
  boardMcpConfig,
  mcpWaitEnv,
  parseAgentOutput,
  pushDenyRules,
  runToolsMcpConfig,
} from "./headlessAgent.ts";

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
    expect(args).not.toContain("--effort");
    const effortful = agentArgs({
      access: "edit",
      budgetUsd: 3,
      sessionId: SESSION,
      model: "sonnet",
      effort: "high",
      defaultBranch: "main",
    });
    expect(after(effortful, "--effort")).toBe("high");
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

  it("allows an edit agent the extra tools it is given, and still denies the pushes and merges", () => {
    const args = agentArgs({
      access: "edit",
      budgetUsd: 1,
      sessionId: SESSION,
      model: null,
      defaultBranch: "main",
      tools: ["mcp__issue-tracker", "mcp__issue-tracker__search_jira"],
    });
    const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
    expect(allowed).toEqual(
      expect.arrayContaining(["Bash", `mcp__${BRAND.id}`, "mcp__issue-tracker", "mcp__issue-tracker__search_jira"]),
    );
    const denied = args.slice(args.indexOf("--disallowedTools") + 1);
    expect(denied).toEqual(expect.arrayContaining(pushDenyRules("main")));
    expect(args).not.toContain("--strict-mcp-config");
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

  it("gives an untrusted agent with a board config that board's server and nothing more", () => {
    const args = agentArgs({
      access: "read-only",
      budgetUsd: 1,
      sessionId: SESSION,
      model: null,
      defaultBranch: null,
      untrusted: true,
      boardMcpConfig: "/tmp/board-mcp.json",
      tools: ["Bash(gh pr view *)"],
    });
    expect(after(args, "--mcp-config")).toBe("/tmp/board-mcp.json");
    expect(args).toContain("--strict-mcp-config");
    expect(after(args, "--setting-sources")).toBe("user");
    expect(after(args, "--tools")).toBe("Read,Grep,Glob,Bash");
    expect(args).toEqual(expect.arrayContaining(["Read(./**)", `mcp__${BRAND.id}`, "Bash(gh pr view *)"]));
    expect(args).not.toContain("Read");
    expect(args).not.toContain("Bash(git diff *)");
  });

  it("gives an untrusted agent with run tools the run's server and nothing more", () => {
    const base = {
      access: "read-only",
      budgetUsd: 1,
      sessionId: SESSION,
      model: null,
      defaultBranch: null,
      runTools: { url: "http://127.0.0.1:1/mcp/run", configPath: "/tmp/run-mcp.json" },
    } as const;
    const locked = agentArgs({ ...base, untrusted: true });
    expect(locked).toContain("--strict-mcp-config");
    expect(after(locked, "--mcp-config")).toBe("/tmp/run-mcp.json");
    const allowed = locked.slice(locked.indexOf("--allowedTools") + 1, locked.indexOf("--disallowedTools"));
    expect(allowed).toContain(`mcp__${RUN_SERVER_NAME}`);
    // No gh, and not the board's own tools.
    expect(allowed.some((t) => t.includes("gh "))).toBe(false);
    expect(allowed).not.toContain(`mcp__${BRAND.id}`);
    // With a board config too, both servers and no other.
    const both = agentArgs({ ...base, untrusted: true, boardMcpConfig: "/tmp/board-mcp.json" });
    expect(both.slice(both.indexOf("--mcp-config") + 1, both.indexOf("--setting-sources"))).toEqual([
      "/tmp/run-mcp.json",
      "/tmp/board-mcp.json",
    ]);
    // Any other run keeps the user's servers and gets the run's on top.
    const open = agentArgs(base);
    expect(open).not.toContain("--strict-mcp-config");
    expect(after(open, "--mcp-config")).toBe("/tmp/run-mcp.json");
    // A no-tools run gets none.
    const none = agentArgs({ ...base, access: "none" });
    expect(none).not.toContain("--mcp-config");
    expect(none).not.toContain(`mcp__${RUN_SERVER_NAME}`);
  });

  it("builds the run tools' MCP config, with the run token in a header", () => {
    const token = ["r", "1"].join("");
    expect(JSON.parse(runToolsMcpConfig("http://127.0.0.1:1/mcp/run", token))).toEqual({
      mcpServers: {
        [RUN_SERVER_NAME]: {
          type: "http",
          url: "http://127.0.0.1:1/mcp/run",
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    });
  });

  it("builds a board-only MCP config, with the token only when there is one", () => {
    expect(JSON.parse(boardMcpConfig("http://127.0.0.1:1/mcp", null))).toEqual({
      mcpServers: { [BRAND.id]: { type: "http", url: "http://127.0.0.1:1/mcp" } },
    });
    const token = ["t", "1"].join("");
    expect(JSON.parse(boardMcpConfig("http://127.0.0.1:1/mcp", token)).mcpServers[BRAND.id].headers).toEqual({
      Authorization: `Bearer ${token}`,
    });
  });

  it("can pin the actor the board records the run's writes under", () => {
    expect(
      JSON.parse(boardMcpConfig("http://127.0.0.1:1/mcp", null, "improve-run")).mcpServers[BRAND.id].headers,
    ).toEqual({
      [ACTOR_HEADER]: "improve-run",
    });
  });

  it("denies the tools it is told to, after --disallowedTools and before the budget", () => {
    const merge = `mcp__${BRAND.id}__merge_task_pr`;
    const args = agentArgs({
      access: "read-only",
      budgetUsd: 1,
      sessionId: SESSION,
      model: null,
      defaultBranch: "main",
      deniedTools: [merge],
    });
    const denied = args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--max-budget-usd"));
    expect(denied).toContain(merge);
    expect(denied).toContain("Bash(gh pr merge*)");
    expect(args.indexOf(merge)).toBeGreaterThan(args.indexOf("--disallowedTools"));
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

  it("holds an isolated read-only agent apart from the user's servers and the checkout's settings", () => {
    const base = { access: "read-only", budgetUsd: 1, sessionId: SESSION, model: null, defaultBranch: null } as const;
    const args = agentArgs({ ...base, isolated: true, ephemeral: true });
    expect(args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--setting-sources", "user"]));
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain(`mcp__${BRAND.id}`);
    expect(args).toContain("Bash(git diff *)");
    // Its run tools are the only server it gets.
    const tools = agentArgs({ ...base, isolated: true, runTools: { url: "http://x", configPath: "/tmp/run.json" } });
    expect(tools.slice(tools.indexOf("--strict-mcp-config"), tools.indexOf("--strict-mcp-config") + 3)).toEqual([
      "--strict-mcp-config",
      "--mcp-config",
      "/tmp/run.json",
    ]);
    // Without it, a read-only agent keeps the user's servers, the board's included.
    expect(agentArgs(base)).toContain(`mcp__${BRAND.id}`);
    expect(agentArgs(base)).not.toContain("--strict-mcp-config");
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

  it("waits for the user's MCP servers only when its tools name one and it gets them", () => {
    const jira = ["mcp__jira-mcp__get_jira_issue"];
    const wait = { MCP_CONNECTION_NONBLOCKING: "false" };
    expect(mcpWaitEnv({ access: "edit", tools: jira })).toEqual(wait);
    expect(mcpWaitEnv({ access: "read-only", tools: ["Bash(gh pr view *)", ...jira] })).toEqual(wait);
    // The board's own server, or no MCP tools at all, needs no wait.
    expect(mcpWaitEnv({ access: "edit", tools: [`mcp__${BRAND.id}`, `mcp__${BRAND.id}__move_task`] })).toEqual({});
    expect(mcpWaitEnv({ access: "edit", tools: ["Bash(gh pr review *)"] })).toEqual({});
    expect(mcpWaitEnv({ access: "edit" })).toEqual({});
    // These runs get no user servers (--strict-mcp-config), so there is nothing to wait for.
    expect(mcpWaitEnv({ access: "none", tools: jira })).toEqual({});
    expect(mcpWaitEnv({ access: "read-only", untrusted: true, tools: jira })).toEqual({});
    // Run tools are a run's only way to read its target, so it waits for them, locked down or not.
    expect(mcpWaitEnv({ access: "read-only", untrusted: true, runTools: true })).toEqual(wait);
    expect(mcpWaitEnv({ access: "edit", runTools: true })).toEqual(wait);
    expect(mcpWaitEnv({ access: "none", runTools: true })).toEqual({});
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
      usage: [],
    });
    const budget = JSON.stringify({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 3.01 });
    expect(parseAgentOutput(budget, false)).toMatchObject({ ok: false, error: "error max budget usd", costUsd: 3.01 });
    expect(parseAgentOutput(JSON.stringify({ subtype: "success", result: "x" }), true)).toMatchObject({ ok: false });
    expect(() => parseAgentOutput("", false)).toThrow("no JSON result");
  });
});
