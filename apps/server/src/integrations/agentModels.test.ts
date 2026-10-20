import type { AgentModels } from "@repo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import {
  CLAUDE_INITIALIZE_REQUEST,
  createAgentModels,
  parseClaudeModels,
  parseCopilotModels,
  type AgentModelProbes,
} from "./agentModels.ts";
import type { TerminalHost } from "./terminal.ts";

// What `claude -p --input-format stream-json --output-format stream-json --verbose` printed for an `initialize`
// request (CLI 2.1.304), trimmed to the fields read.
const effort = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_OUTPUT = [
  JSON.stringify({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" }),
  JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "models",
      response: {
        commands: [],
        claude_code_version: "2.1.304",
        models: [
          {
            value: "default",
            displayName: "Default (recommended)",
            description: "Use the default model",
            supportsEffort: true,
            supportedEffortLevels: effort,
          },
          {
            value: "opus",
            displayName: "Opus",
            description: "Opus 5.5 · Best for everyday, complex tasks",
            supportsEffort: true,
            supportedEffortLevels: effort,
          },
          {
            value: "haiku",
            displayName: "Haiku",
            description: "Haiku 5.5 · Fastest for quick answers",
            supportsEffort: false,
            supportedEffortLevels: ["low", "turbo"],
          },
          { value: "opus[1m]" },
        ],
      },
    },
  }),
].join("\n");

const COPILOT_HELP = [
  '  `logLevel`: log level for CLI; defaults to "default". Set to "all" for debug logging.',
  "",
  "  `model`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.",
  '    - "claude-sonnet-5"',
  '    - "gpt-5.4"',
  '    - "gpt-5.3-codex"',
  "",
  "  `contextTier`: context window tier for tiered-pricing models.",
  '    - "default"',
].join("\r\n");

describe("parseClaudeModels", () => {
  it("reads the models and their effort levels, and leaves out the default", () => {
    const { models, cliVersion } = parseClaudeModels(CLAUDE_OUTPUT);
    expect(cliVersion).toBe("2.1.304");
    expect(models.map((m) => m.value)).toEqual(["opus", "haiku", "opus[1m]"]);
    expect(models[0]).toEqual({
      value: "opus",
      label: "Opus",
      description: "Opus 5.5 · Best for everyday, complex tasks",
      effortLevels: effort,
    });
  });

  it("has no levels for a model that takes no effort, or lists none", () => {
    const { models } = parseClaudeModels(CLAUDE_OUTPUT);
    expect(models[1]?.effortLevels).toBeNull();
    expect(models[2]).toEqual({ value: "opus[1m]", label: null, description: null, effortLevels: null });
  });

  it("throws when there is no reply, a refusal or no models", () => {
    expect(() => parseClaudeModels("")).toThrow(/didn't answer/);
    expect(() => parseClaudeModels("not json\n{broken")).toThrow(/didn't answer/);
    const reply = (response: unknown) => JSON.stringify({ type: "control_response", response });
    expect(() =>
      parseClaudeModels(reply({ subtype: "error", request_id: "models", error: "Unsupported request" })),
    ).toThrow(/refused the model list: Unsupported request/);
    expect(() => parseClaudeModels(reply({ subtype: "success", request_id: "models", response: {} }))).toThrow(
      /listed no models/,
    );
    // Another request's reply isn't ours.
    expect(() => parseClaudeModels(reply({ subtype: "success", request_id: "other", response: {} }))).toThrow(
      /didn't answer/,
    );
  });

  it("asks with one initialize request line", () => {
    expect(JSON.parse(CLAUDE_INITIALIZE_REQUEST)).toEqual({
      type: "control_request",
      request_id: "models",
      request: { subtype: "initialize" },
    });
    expect(CLAUDE_INITIALIZE_REQUEST.endsWith("\n")).toBe(true);
  });
});

describe("parseCopilotModels", () => {
  it("reads the model list under the model setting and stops at the next one", () => {
    expect(parseCopilotModels(COPILOT_HELP).map((m) => m.value)).toEqual([
      "claude-sonnet-5",
      "gpt-5.4",
      "gpt-5.3-codex",
    ]);
    expect(parseCopilotModels(COPILOT_HELP)[0]).toEqual({
      value: "claude-sonnet-5",
      label: null,
      description: null,
      effortLevels: null,
    });
  });

  it("throws when the help has no model list", () => {
    expect(() => parseCopilotModels("nothing here")).toThrow(/doesn't list its models/);
    expect(() => parseCopilotModels("  `model`: AI model\n\n  `other`: x")).toThrow(/doesn't list its models/);
  });
});

const host = (): TerminalHost => ({ platform: "linux", env: {}, readFile: () => null, which: () => null });

function service(probes: Partial<AgentModelProbes>, opts: { now?: () => number } = {}) {
  const settings = { headlessReviewCli: null as string | null, copilotCli: null as string | null };
  const svc = createAgentModels({
    services: () => ({ settings: { get: () => settings } }) as never,
    host,
    probes: {
      resolve: (command) => `/bin/${command}`,
      version: () => Promise.resolve("2.0.0"),
      claudeInit: () => Promise.resolve(CLAUDE_OUTPUT),
      copilotHelp: () => Promise.resolve(COPILOT_HELP),
      ...probes,
    },
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { svc, settings };
}

const of = (r: AgentModels, harness: string) => r.harnesses.find((h) => h.harness === harness)!;

describe("agent models", () => {
  it("scans both CLIs and says when and from which version", async () => {
    const { svc } = service({}, { now: () => Date.UTC(2026, 9, 20, 12) });
    const result = await svc.status();
    expect(result.harnesses.map((h) => h.harness)).toEqual(["claude-code", "copilot-cli"]);
    expect(of(result, "claude-code")).toMatchObject({
      cliVersion: "2.1.304",
      scannedAt: "2026-10-20T12:00:00.000Z",
      error: null,
    });
    expect(of(result, "copilot-cli")).toMatchObject({ cliVersion: "2.0.0", error: null });
    expect(of(result, "copilot-cli").models).toHaveLength(3);
  });

  it("gives an empty list and the reason when a CLI is missing, fails or times out", async () => {
    const { svc, settings } = service({
      resolve: (command) => (command.endsWith("copilot") ? null : `/bin/${command}`),
      claudeInit: () => Promise.reject(new Error("Claude Code didn't finish within 45 seconds")),
    });
    const result = await svc.status();
    expect(of(result, "copilot-cli")).toEqual({
      harness: "copilot-cli",
      models: [],
      cliVersion: null,
      scannedAt: null,
      error: "copilot isn't on PATH",
    });
    expect(of(result, "claude-code")).toMatchObject({
      models: [],
      scannedAt: null,
      cliVersion: "2.0.0",
      error: "Claude Code didn't finish within 45 seconds",
    });
    settings.copilotCli = "/opt/copilot";
    expect(of(await svc.status(), "copilot-cli").error).toBe("Not found at /opt/copilot");
  });

  it("reuses an answer for ten minutes, until refreshed, and rescans for another CLI path", async () => {
    let time = 0;
    const claudeInit = vi.fn<AgentModelProbes["claudeInit"]>(() => Promise.resolve(CLAUDE_OUTPUT));
    const copilotHelp = vi.fn<AgentModelProbes["copilotHelp"]>(() => Promise.resolve(COPILOT_HELP));
    const { svc, settings } = service({ claudeInit, copilotHelp }, { now: () => time });
    await svc.status();
    await svc.status();
    expect(claudeInit).toHaveBeenCalledTimes(1);
    time = 9 * 60_000;
    await svc.status();
    expect(claudeInit).toHaveBeenCalledTimes(1);
    time = 11 * 60_000;
    await svc.status();
    expect(claudeInit).toHaveBeenCalledTimes(2);
    await svc.status(true);
    expect(claudeInit).toHaveBeenCalledTimes(3);
    expect(copilotHelp).toHaveBeenCalledTimes(3);
    settings.headlessReviewCli = "/opt/claude";
    await svc.status();
    expect(claudeInit).toHaveBeenCalledTimes(4);
    expect(copilotHelp).toHaveBeenCalledTimes(3);
  });

  it("lets a refresh join a scan that is still running, rather than starting another", async () => {
    let release!: (stdout: string) => void;
    const claudeInit = vi.fn<AgentModelProbes["claudeInit"]>(
      () => new Promise<string>((resolve) => (release = resolve)),
    );
    const { svc } = service({ claudeInit });
    const first = svc.status();
    const refreshed = svc.status(true);
    await vi.waitFor(() => expect(claudeInit).toHaveBeenCalled());
    release(CLAUDE_OUTPUT);
    expect(of(await first, "claude-code").models.length).toBeGreaterThan(0);
    expect(of(await refreshed, "claude-code").models.length).toBeGreaterThan(0);
    expect(claudeInit).toHaveBeenCalledTimes(1);
  });

  it("doesn't keep a failed scan, so the next ask tries again", async () => {
    const claudeInit = vi
      .fn<AgentModelProbes["claudeInit"]>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(CLAUDE_OUTPUT);
    const { svc } = service({ claudeInit });
    expect(of(await svc.status(), "claude-code").error).toBe("boom");
    expect(of(await svc.status(), "claude-code").error).toBeNull();
    expect(claudeInit).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/agent-models", () => {
  it("serves the models and rescans on request", async () => {
    const claudeInit = vi.fn<AgentModelProbes["claudeInit"]>(() => Promise.resolve(CLAUDE_OUTPUT));
    const h = createTestHarness({
      integrations: {
        agentModelProbes: {
          resolve: (command) => `/bin/${command}`,
          version: () => Promise.resolve("2.0.0"),
          claudeInit,
          copilotHelp: () => Promise.resolve(COPILOT_HELP),
        },
      },
    });
    const body = (await (await h.request("/api/agent-models")).json()) as AgentModels;
    expect(body.harnesses.map((x) => x.harness)).toEqual(["claude-code", "copilot-cli"]);
    expect(body.harnesses[0]?.models.map((m) => m.value)).toEqual(["opus", "haiku", "opus[1m]"]);
    await h.request("/api/agent-models");
    expect(claudeInit).toHaveBeenCalledTimes(1);
    await h.request("/api/agent-models?refresh=1");
    expect(claudeInit).toHaveBeenCalledTimes(2);
  });
});
