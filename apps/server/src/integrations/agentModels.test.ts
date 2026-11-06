import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliEffortFor, type AgentModels, type ProviderSetting } from "@repo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import { PROCESS_TEST_TIMEOUT } from "../test/timeouts.ts";
import { liveGroups } from "./processTree.ts";
import {
  CLAUDE_INITIALIZE_REQUEST,
  createAgentModels,
  parseClaudeModels,
  parseCodexModels,
  parseCopilotModels,
  type AgentModelProbes,
} from "./agentModels.ts";
import { codexModelPages } from "./codexAppServer.ts";
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

  it("lists no levels for a model that takes no effort, and says nothing for one that lists none", () => {
    const { models } = parseClaudeModels(CLAUDE_OUTPUT);
    expect(models[1]?.effortLevels).toEqual([]);
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

// A `model/list` reply from `codex app-server` (codex-cli 0.166.0), trimmed to three models and the fields that matter.
const CODEX_MODEL_LIST = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/codex/model-list.json", import.meta.url)), "utf8"),
) as { id: number; result: { data: Record<string, unknown>[]; nextCursor: string | null } };
const CODEX_PAGES = [CODEX_MODEL_LIST.result];

describe("parseCodexModels", () => {
  it("reads the recorded list: names, descriptions, efforts, the default model and each one's default effort", () => {
    const models = parseCodexModels(CODEX_PAGES);
    expect(models.map((m) => m.value)).toEqual(["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]);
    expect(models[0]).toEqual({
      value: "gpt-6.1-sol",
      label: "GPT-6.1-Sol",
      description: "Latest workhorse model for coding and everyday work.",
      effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      isDefault: true,
      defaultEffort: "low",
    });
    // Luna takes no ultra; only the default model says it is the default.
    expect(models[2]).toMatchObject({
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
    });
    expect(models.filter((m) => m.isDefault)).toHaveLength(1);
  });

  it("leaves out hidden models, repeats and levels it doesn't know, across pages", () => {
    const [sol] = CODEX_MODEL_LIST.result.data;
    const models = parseCodexModels([
      { data: [sol, { ...sol, model: "gpt-secret", hidden: true }], nextCursor: "2" },
      {
        data: [
          sol,
          {
            model: "gpt-odd",
            supportedReasoningEfforts: [{ reasoningEffort: "turbo" }, { reasoningEffort: "high" }],
            defaultReasoningEffort: "turbo",
          },
        ],
      },
    ]);
    expect(models.map((m) => m.value)).toEqual(["gpt-6.1-sol", "gpt-odd"]);
    expect(models[1]).toEqual({ value: "gpt-odd", label: null, description: null, effortLevels: ["high"] });
  });

  it("keeps the none and minimal levels older models list, which the CLI list accepts", () => {
    const [model] = parseCodexModels([
      {
        data: [
          {
            model: "gpt-old",
            supportedReasoningEfforts: [{ reasoningEffort: "none" }, { reasoningEffort: "minimal" }],
            defaultReasoningEffort: "none",
          },
        ],
      },
    ]);
    expect(model).toMatchObject({ effortLevels: ["none", "minimal"], defaultEffort: "none" });
    for (const level of model!.effortLevels ?? []) expect(cliEffortFor("codex", level)).toBe(level);
  });

  it("throws when no page lists a model", () => {
    expect(() => parseCodexModels([])).toThrow(/listed no models/);
    expect(() => parseCodexModels([{ data: [] }, null, { data: "x" }])).toThrow(/listed no models/);
  });
});

describe("codexModelPages", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A stand-in for `codex app-server`: a node script that answers the requests it reads as the real one does (the
   * recorded list, split over two pages), logs what it was sent, and never exits by itself, so the client must end it.
   */
  const fakeServer = (behaviour: "answer" | "refuse" | "silent" | "exit") => {
    const dir = mkdtempSync(join(tmpdir(), "codex-app-server-"));
    dirs.push(dir);
    const script = join(dir, "codex.mjs");
    const log = join(dir, "log.jsonl");
    writeFileSync(
      script,
      `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const behaviour = ${JSON.stringify(behaviour)};
const [first, ...rest] = ${JSON.stringify(CODEX_MODEL_LIST.result.data)};
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
if (behaviour === "exit") { process.stderr.write("not logged in"); process.exit(3); }
setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on("line", (line) => {
  appendFileSync(${JSON.stringify(log)}, line + "\\n");
  const m = JSON.parse(line);
  if (behaviour === "silent" || m.id === undefined) return;
  if (m.method === "initialize") {
    send({ method: "remoteControl/status/changed", params: { status: "disabled" } });
    send({ id: m.id, result: { userAgent: "x/0.166.0", codexHome: "/home/x/.codex" } });
  } else if (behaviour === "refuse") send({ id: m.id, error: { code: -32600, message: "Not initialized" } });
  else if (!m.params.cursor) send({ id: m.id, result: { data: [first], nextCursor: "page-2" } });
  else send({ id: m.id, result: { data: rest, nextCursor: null } });
});
`,
    );
    const sent = () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    return { script, sent };
  };

  const run = (script: string, timeoutMs = 10_000) =>
    codexModelPages(process.execPath, { cwd: tmpdir(), timeoutMs, args: [script] });

  it(
    "initializes, lists every page and ends the server",
    async () => {
      const { script, sent } = fakeServer("answer");
      const pages = await run(script);
      expect(parseCodexModels(pages).map((m) => m.value)).toEqual(["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]);
      expect(sent().map((m) => m.method)).toEqual(["initialize", "initialized", "model/list", "model/list"]);
      expect(sent()[3]?.params).toEqual({ cursor: "page-2" });
      // The server's process group (off Windows) is tracked until it has really exited.
      await vi.waitFor(() => expect(liveGroups.size).toBe(0), { timeout: 3000 });
    },
    PROCESS_TEST_TIMEOUT,
  );

  it(
    "fails with the reason when the server refuses, exits early or doesn't answer in time",
    async () => {
      await expect(run(fakeServer("refuse").script)).rejects.toThrow(/refused model\/list: Not initialized/);
      await expect(run(fakeServer("exit").script)).rejects.toThrow(/exited with code 3: not logged in/);
      await expect(run(fakeServer("silent").script, 500)).rejects.toThrow(/didn't list its models within 1 seconds/);
    },
    PROCESS_TEST_TIMEOUT,
  );
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
  const settings = { providers: [] as ProviderSetting[] };
  const svc = createAgentModels({
    services: () => ({ settings: { get: () => settings } }) as never,
    host,
    probes: {
      resolve: (command) => `/bin/${command}`,
      version: () => Promise.resolve("2.0.0"),
      claudeInit: () => Promise.resolve(CLAUDE_OUTPUT),
      copilotHelp: () => Promise.resolve(COPILOT_HELP),
      codexModels: () => Promise.resolve(CODEX_PAGES),
      ...probes,
    },
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { svc, settings };
}

const of = (r: AgentModels, harness: string) => r.harnesses.find((h) => h.harness === harness)!;

describe("agent models", () => {
  it("scans every CLI and says when and from which version", async () => {
    const { svc } = service({}, { now: () => Date.UTC(2026, 9, 20, 12) });
    const result = await svc.status();
    expect(result.harnesses.map((h) => h.harness)).toEqual(["claude-code", "codex", "copilot-cli"]);
    expect(of(result, "codex")).toMatchObject({ cliVersion: "2.0.0", error: null });
    expect(of(result, "codex").models.find((m) => m.isDefault)?.value).toBe("gpt-6.1-sol");
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
    settings.providers = [{ id: "copilot-cli", enabled: true, cliPath: "/opt/copilot" }];
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
    settings.providers = [{ id: "claude-code", enabled: true, cliPath: "/opt/claude" }];
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
          codexModels: () => Promise.resolve(CODEX_PAGES),
        },
      },
    });
    const body = (await (await h.request("/api/agent-models")).json()) as AgentModels;
    expect(body.harnesses.map((x) => x.harness)).toEqual(["claude-code", "codex", "copilot-cli"]);
    expect(body.harnesses[0]?.models.map((m) => m.value)).toEqual(["opus", "haiku", "opus[1m]"]);
    await h.request("/api/agent-models");
    expect(claudeInit).toHaveBeenCalledTimes(1);
    await h.request("/api/agent-models?refresh=1");
    expect(claudeInit).toHaveBeenCalledTimes(2);
  });
});
