import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BRAND } from "@repo/contracts";
import { RUN_SERVER_NAME, RUN_TOKEN_ENV } from "../mcp/runTokens.ts";
import { describe, expect, it } from "vitest";
import { agentArgs, claudeDriver, type AgentArgsInput } from "./headlessAgent.ts";
import {
  codexArgs,
  codexDriver,
  codexSessionId,
  copilotArgs,
  copilotDriver,
  driverNeeds,
  parseCodexOutput,
  parseCopilotOutput,
} from "./headlessDrivers.ts";

const ID = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const FIRST_ID = "01a1a0ab-0000-7000-8000-000000000001";
const SECOND_ID = "01a1a0ab-0000-7000-8000-000000000002";
const THIRD_ID = "01a1a0ab-0000-7000-8000-000000000003";
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/codex/${name}.jsonl`, import.meta.url)), "utf8").trimEnd();
const jsonl = (...events: object[]) => events.map((e) => JSON.stringify(e)).join("\n");
const input = (extra: Partial<AgentArgsInput> = {}): AgentArgsInput => ({
  access: "edit",
  budgetUsd: 5,
  sessionId: "11111111-2222-4333-8444-555555555555",
  model: null,
  defaultBranch: "main",
  ...extra,
});

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

  it("passes the effort as the model_reasoning_effort config key, and none when there isn't one", () => {
    const args = codexArgs(input({ model: "gpt-5.5-codex", effort: "high" }));
    expect(args.slice(args.indexOf("-c"), args.indexOf("-c") + 2)).toEqual(["-c", "model_reasoning_effort=high"]);
    expect(args.at(-1)).toBe("-");
    expect(codexArgs(input({ effort: null }))).not.toContain("-c");
    expect(codexArgs(input())).not.toContain("-c");
  });

  it("gives a run with run tools only the board's endpoint, its token read from the environment", () => {
    const args = codexArgs(
      input({
        access: "read-only",
        runTools: { url: "http://127.0.0.1:4317/mcp/run", configPath: "/tmp/run-mcp.json" },
      }),
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--ignore-user-config",
      "-c",
      `mcp_servers.${RUN_SERVER_NAME}.url="http://127.0.0.1:4317/mcp/run"`,
      "-c",
      `mcp_servers.${RUN_SERVER_NAME}.bearer_token_env_var="${RUN_TOKEN_ENV}"`,
      "-",
    ]);
    // The token is never on the command line, nor the config file Claude Code reads.
    expect(args.join(" ")).not.toContain("run-mcp.json");
    expect(codexArgs(input())).not.toContain("--ignore-user-config");
  });

  // The fixtures are `codex exec --json` stdout recorded on codex-cli 0.166.0, scrubbed of paths and ids.
  it("reads the thread id and the answer of a plain run", () => {
    const stdout = fixture("success");
    expect(parseCodexOutput(stdout)).toEqual({
      ok: true,
      error: null,
      result: "pong",
      output: undefined,
      sessionId: FIRST_ID,
      costUsd: null,
    });
  });

  it("takes the last agent message of a run that used tools", () => {
    const outcome = parseCodexOutput(fixture("agent-run"));
    expect(outcome).toMatchObject({ ok: true, error: null, sessionId: SECOND_ID });
    expect(outcome.result).toMatch(/^1\. `printf 'hi' > hello\.txt`/);
    expect(outcome.result).toContain("git push origin autopilot/test");
  });

  it("gets the session id from the first line of the stream, whatever follows", () => {
    const lines = fixture("agent-run").split("\n");
    expect(codexDriver.sessionIdOf?.(lines[0]!)).toBe(SECOND_ID);
    expect(codexSessionId(lines[0]!.replace(SECOND_ID, SECOND_ID.toUpperCase()))).toBe(SECOND_ID);
    // Only thread.started names the thread; the other events, text and a malformed id don't.
    for (const line of lines.slice(1)) expect(codexSessionId(line)).toBeNull();
    expect(codexSessionId(JSON.stringify({ type: "thread.started", thread_id: "not-a-uuid" }))).toBeNull();
    expect(codexSessionId("Reading prompt from stdin...")).toBeNull();
  });

  it("fails a model the account can't use, with Codex's message and not the warning before it", () => {
    expect(parseCodexOutput(fixture("unknown-model"))).toMatchObject({
      ok: false,
      error: "The 'not-a-real-model' model is not supported when using Codex with a ChatGPT account.",
      sessionId: THIRD_ID,
    });
  });

  it("shows the message of an API refusal, not the response body it came in", () => {
    expect(parseCodexOutput(fixture("bad-effort"))).toMatchObject({
      ok: false,
      error:
        "Invalid response.create payload: Invalid value: 'bogus'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.",
    });
  });

  it("fails output that ends before the turn does, keeping the session to resume", () => {
    expect(parseCodexOutput(fixture("cut-off"))).toMatchObject({
      ok: false,
      error: "Codex ended before its turn completed",
      sessionId: SECOND_ID,
    });
    expect(parseCodexOutput("")).toMatchObject({ ok: false, error: "no output" });
  });

  it("reads a run whose commands failed as a success: the turn completed", () => {
    // The pre-push guard refused three pushes; the agent said so and finished.
    expect(parseCodexOutput(fixture("push-refused"))).toMatchObject({ ok: true, error: null });
  });

  it("falls back to a plain message for an error it can't read", () => {
    const failed = (event: object) => parseCodexOutput(JSON.stringify(event));
    expect(failed({ type: "turn.failed", error: {} })).toMatchObject({ ok: false, error: "the turn failed" });
    expect(failed({ type: "error", message: "{not json" })).toMatchObject({ error: "{not json" });
    expect(failed({ type: "error", message: '{"status":500}' })).toMatchObject({ error: '{"status":500}' });
    expect(failed({ type: "error" })).toMatchObject({ error: "Codex reported an error" });
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

  it("passes the model's reasoning effort after its model", () => {
    const args = copilotArgs(input({ model: "gpt-5.4", effort: "none" }));
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 4)).toEqual([
      "--model",
      "gpt-5.4",
      "--reasoning-effort",
      "none",
    ]);
    expect(copilotArgs(input({ model: "gpt-5.4" }))).not.toContain("--reasoning-effort");
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
      runTools: true,
    });
    expect(copilotDriver.capabilities.presetSessionId).toBe(true);
    expect(copilotDriver.capabilities.runTools).toBe(false);
    expect(copilotDriver.capabilities.budget).toBe(false);
  });

  it("turns what a run asks into the needs the resolver checks providers against", () => {
    expect(driverNeeds({ access: "edit" })).toEqual(["edit"]);
    expect(driverNeeds({ access: "read-only" })).toEqual([]);
    expect(driverNeeds({ access: "none", outputSchema: {} })).toEqual(["noTools", "outputSchema"]);
    expect(driverNeeds({ access: "read-only", untrusted: true, tools: ["Bash(gh pr review *)"] })).toEqual([
      "untrusted",
      "toolRules",
    ]);
    // With no worktree there is no push guard: only Claude Code's deny rules hold an editing agent back.
    expect(driverNeeds({ access: "edit", unguarded: true })).toEqual(["edit", "toolRules"]);
    expect(driverNeeds({ access: "read-only", unguarded: true })).toEqual([]);
    expect(driverNeeds({ access: "read-only", untrusted: true, runTools: true, outputSchema: {} })).toEqual([
      "outputSchema",
      "untrusted",
      "runTools",
    ]);
  });
});
