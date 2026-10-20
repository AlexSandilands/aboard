import { BRAND } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { agentArgs, claudeDriver, type AgentArgsInput } from "./headlessAgent.ts";
import {
  codexArgs,
  codexDriver,
  codexSessionId,
  copilotArgs,
  copilotDriver,
  headlessDriverFor,
  missingCapability,
  parseCodexOutput,
  parseCopilotOutput,
} from "./headlessDrivers.ts";

const ID = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const input = (extra: Partial<AgentArgsInput> = {}): AgentArgsInput => ({
  access: "edit",
  budgetUsd: 5,
  sessionId: "11111111-2222-4333-8444-555555555555",
  model: null,
  defaultBranch: "main",
  ...extra,
});
const jsonl = (...events: object[]) => events.map((e) => JSON.stringify(e)).join("\n");

describe("the Claude Code driver", () => {
  it("is today's claude -p, argv for argv", () => {
    const args = input({ model: "opus", name: "Autopilot · #1" });
    expect(claudeDriver.args(args)).toEqual(agentArgs(args));
    expect(claudeDriver.capabilities).toMatchObject({ outputSchema: true, untrusted: true, presetSessionId: true });
  });
});

describe("the Codex driver", () => {
  it("runs codex exec outside its sandbox for edits, so git can commit, reading the prompt from stdin", () => {
    expect(codexArgs(input({ model: "gpt-5.5-codex" }))).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "danger-full-access",
      "--model",
      "gpt-5.5-codex",
      "-",
    ]);
  });

  it("runs read-only in the read-only sandbox, on the CLI's default model when none is set", () => {
    expect(codexArgs(input({ access: "read-only" }))).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-",
    ]);
  });

  it("reads the thread id, the last agent message and success", () => {
    const stdout = [
      "Reading prompt from stdin...",
      jsonl(
        { type: "thread.started", thread_id: ID },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "i0", type: "reasoning", text: "thinking" } },
        { type: "item.completed", item: { id: "i1", type: "agent_message", text: "Working on it" } },
        { type: "item.completed", item: { id: "i2", type: "agent_message", text: "Done: pushed the branch" } },
        { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
      ),
    ].join("\n");
    expect(parseCodexOutput(stdout)).toEqual({
      ok: true,
      error: null,
      result: "Done: pushed the branch",
      output: undefined,
      sessionId: ID,
      costUsd: null,
    });
    expect(codexDriver.sessionIdOf?.(JSON.stringify({ type: "thread.started", thread_id: ID.toUpperCase() }))).toBe(ID);
    expect(codexSessionId(JSON.stringify({ type: "thread.started", thread_id: "not-a-uuid" }))).toBeNull();
    expect(codexSessionId("plain text")).toBeNull();
  });

  it("fails on a failed turn, an error event, or output that ends before the turn does", () => {
    const failed = parseCodexOutput(
      jsonl({ type: "thread.started", thread_id: ID }, { type: "turn.failed", error: { message: "rate limited" } }),
    );
    expect(failed).toMatchObject({ ok: false, error: "rate limited", sessionId: ID });
    expect(parseCodexOutput(jsonl({ type: "error", message: "stream disconnected" }))).toMatchObject({
      ok: false,
      error: "stream disconnected",
    });
    expect(parseCodexOutput(jsonl({ type: "thread.started", thread_id: ID }))).toMatchObject({
      ok: false,
      error: "Codex ended before its turn completed",
    });
    expect(parseCodexOutput("")).toMatchObject({ ok: false, error: "no output" });
  });
});

describe("the Copilot CLI driver", () => {
  it("allows edits, the shell and the board, and refuses merging", () => {
    expect(copilotArgs(input({ model: "gpt-5.4", name: "Autopilot · #1" }))).toEqual([
      "--output-format",
      "json",
      "--no-ask-user",
      "--session-id",
      "11111111-2222-4333-8444-555555555555",
      "--allow-tool",
      "write",
      "--allow-tool",
      "shell",
      "--allow-tool",
      BRAND.id,
      "--deny-tool",
      "shell(gh pr merge)",
      "--model",
      "gpt-5.4",
      "--name",
      "Autopilot · #1",
    ]);
  });

  it("gives a read-only run git commands that only read, and no writes", () => {
    const args = copilotArgs(input({ access: "read-only" }));
    const allowed = args.flatMap((arg, i) => (args[i - 1] === "--allow-tool" ? [arg] : []));
    expect(allowed).toContain("shell(git log)");
    expect(allowed).not.toContain("write");
    expect(allowed).not.toContain("shell");
    expect(args.slice(args.indexOf("--deny-tool"))).toEqual([
      "--deny-tool",
      "shell(gh pr merge)",
      "--deny-tool",
      "write",
    ]);
  });

  it("reads the session, the final message (or the task's summary) and errors", () => {
    const stdout = jsonl(
      { type: "session.warning", data: { message: "MCP disabled" } },
      { type: "session.start", data: { sessionId: ID } },
      { type: "assistant.message", data: { content: "Looking" } },
      { type: "assistant.message", data: { content: "" } },
      { type: "session.task_complete", data: { summary: "Fixed the bug and pushed" } },
    );
    expect(parseCopilotOutput(stdout)).toMatchObject({
      ok: true,
      result: "Fixed the bug and pushed",
      sessionId: ID,
      costUsd: null,
    });
    expect(parseCopilotOutput(jsonl({ type: "session.error", data: { message: "quota" } }))).toMatchObject({
      ok: false,
      error: "quota",
    });
    const refused = `${jsonl({ type: "session.warning", data: { message: "x" } })}\nError: Access denied by policy settings\n`;
    expect(parseCopilotOutput(refused)).toMatchObject({ ok: false, error: "Access denied by policy settings" });
    expect(parseCopilotOutput(jsonl({ type: "session.start", data: { sessionId: ID } }))).toMatchObject({
      ok: false,
      error: "no result returned",
    });
  });
});

describe("choosing a driver", () => {
  it("knows what each harness can do", () => {
    expect(codexDriver.capabilities).toEqual({
      outputSchema: false,
      untrusted: false,
      noTools: false,
      toolRules: false,
      budget: false,
      presetSessionId: false,
    });
    expect(copilotDriver.capabilities.presetSessionId).toBe(true);
    expect(copilotDriver.capabilities.budget).toBe(false);
  });

  it("names what a run needs that the harness can't do", () => {
    expect(missingCapability(codexDriver, { access: "edit" })).toBeNull();
    expect(missingCapability(codexDriver, { access: "read-only" })).toBeNull();
    expect(missingCapability(codexDriver, { access: "edit", outputSchema: {} })).toBe("structured output");
    expect(missingCapability(copilotDriver, { access: "read-only", untrusted: true })).toBe(
      "the lockdown for untrusted input",
    );
    expect(missingCapability(codexDriver, { access: "none" })).toBe("a run with no tools");
    expect(missingCapability(copilotDriver, { access: "read-only", tools: ["Bash(gh pr review *)"] })).toBe(
      "its own tool rules",
    );
    expect(missingCapability(claudeDriver, { access: "none", outputSchema: {}, untrusted: true })).toBeNull();
    // With no worktree there is no push guard: only Claude Code's deny rules hold an editing agent back.
    expect(missingCapability(codexDriver, { access: "edit", unguarded: true })).toBe(
      "push rules of its own, as a run with no worktree has no push guard",
    );
    expect(missingCapability(copilotDriver, { access: "read-only", unguarded: true })).toBeNull();
    expect(missingCapability(claudeDriver, { access: "edit", unguarded: true })).toBeNull();
  });

  it("falls back to Claude Code, saying why, when the harness can't do what the run needs", () => {
    expect(headlessDriverFor("codex", { access: "edit" })).toEqual({ driver: codexDriver, fallback: null });
    const fallback = headlessDriverFor("copilot-cli", { access: "edit", outputSchema: {} });
    expect(fallback.driver).toBe(claudeDriver);
    expect(fallback.fallback).toBe(
      "Copilot CLI can't run this action headless (it needs structured output), so Claude Code ran it on its default model.",
    );
    expect(headlessDriverFor("claude-code", { access: "none" })).toEqual({ driver: claudeDriver, fallback: null });
  });
});
