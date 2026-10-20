import { tmpdir } from "node:os";
import {
  AGENT_HARNESSES,
  type AgentHarness,
  type AgentModel,
  type AgentModels,
  type AgentModelsStatus,
  type AppSettings,
  CliEffort,
} from "@repo/contracts";
import type { Services } from "../services/types.ts";
import { claudeOutput, executableVersion, resolveExecutable, runClaude } from "./claudeCli.ts";
import { messageOf } from "./github.ts";
import type { TerminalHost } from "./terminal.ts";

// The models each CLI says it can run, for the pickers in Settings → Model tiers. Each CLI is asked only when the page
// is opened or a rescan is requested, and the answer is kept for a while. A scan that fails leaves the list empty with
// the reason, and the pickers still take a typed model. See docs/features/agent-sessions.md.

/** How long an answer is reused. A CLI's model list changes with its releases, not by the minute. */
const CACHE_MS = 10 * 60_000;
/** Claude Code runs its SessionStart hooks before it answers, which can take a few seconds. */
const CLAUDE_SCAN_TIMEOUT_MS = 45_000;
const COPILOT_SCAN_TIMEOUT_MS = 15_000;

const REQUEST_ID = "models";

/**
 * Claude Code's reply to one `initialize` control request, with no prompt sent, so nothing is billed. Over stream-json
 * the CLI answers it and ends when stdin does.
 */
export const CLAUDE_INITIALIZE_REQUEST = `${JSON.stringify({
  type: "control_request",
  request_id: REQUEST_ID,
  request: { subtype: "initialize" },
})}\n`;

/** The `--effort` levels a scanned model lists, without any this board doesn't know. */
const effortLevelsOf = (value: unknown): CliEffort[] | null => {
  if (!Array.isArray(value)) return null;
  const levels = value.flatMap((level) => {
    const parsed = CliEffort.safeParse(level);
    return parsed.success ? [parsed.data] : [];
  });
  return levels.length ? levels : null;
};

const textOf = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * The models in the `initialize` reply of `claude -p --input-format stream-json --output-format stream-json`: its
 * `control_response` line holds `response.models`. "default" is dropped, since a tier with no model already runs it.
 * Throws when there is no reply or it holds no models, so the scan reads as failed rather than empty.
 */
export function parseClaudeModels(stdout: string): { models: AgentModel[]; cliVersion: string | null } {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('"control_response"')) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const reply = json as {
      response?: { subtype?: unknown; request_id?: unknown; response?: unknown; error?: unknown };
    };
    if (reply.response?.request_id !== REQUEST_ID) continue;
    if (reply.response.subtype !== "success") {
      throw new Error(`Claude Code refused the model list: ${textOf(reply.response.error) ?? "no reason given"}`);
    }
    const body = (reply.response.response ?? {}) as { models?: unknown; claude_code_version?: unknown };
    const models = (Array.isArray(body.models) ? body.models : []).flatMap((entry): AgentModel[] => {
      const model = entry as Record<string, unknown>;
      const value = textOf(model.value);
      if (!value || value === "default") return [];
      return [
        {
          value,
          label: textOf(model.displayName),
          description: textOf(model.description),
          effortLevels: model.supportsEffort === false ? [] : effortLevelsOf(model.supportedEffortLevels),
        },
      ];
    });
    if (!models.length) throw new Error("Claude Code listed no models");
    return { models, cliVersion: textOf(body.claude_code_version) };
  }
  throw new Error("Claude Code didn't answer the model request");
}

/**
 * The models `copilot help config` lists under its `model` setting: a line "`model`: …" and then one `- "id"` line per
 * model. Copilot lists no names or effort levels here. Throws when the list isn't found, e.g. after a change to the
 * help text, so that reads as a failed scan.
 */
export function parseCopilotModels(helpText: string): AgentModel[] {
  const lines = helpText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*`model`:/.test(line));
  const models: AgentModel[] = [];
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      const value = /^\s+-\s+"([^"]+)"\s*$/.exec(line)?.[1];
      if (!value) break;
      models.push({ value, label: null, description: null, effortLevels: null });
    }
  }
  if (!models.length) throw new Error("Copilot CLI's help doesn't list its models");
  return models;
}

/** What a scan runs: replaced in tests so no CLI is started. */
export interface AgentModelProbes {
  /** The CLI's executable on this machine, or null. */
  resolve: (command: string) => string | null;
  version: (exe: string, label: string) => Promise<string>;
  /** Claude Code's stdout for the `initialize` request; throws when it can't run. */
  claudeInit: (exe: string, cwd: string) => Promise<string>;
  /** `copilot help config`'s stdout. */
  copilotHelp: (exe: string, cwd: string) => Promise<string>;
}

export interface AgentModelsService {
  /** Each harness's models, reused for ten minutes unless `refresh` is set; a refresh joins a scan still running. */
  status(refresh?: boolean): Promise<AgentModels>;
}

export function createAgentModels(deps: {
  services: () => Pick<Services, "settings">;
  host: () => TerminalHost;
  probes?: Partial<AgentModelProbes>;
  now?: () => number;
}): AgentModelsService {
  const now = deps.now ?? Date.now;
  const probes: AgentModelProbes = {
    resolve: (command) => {
      const h = deps.host();
      return resolveExecutable(command, h.env, h.platform);
    },
    version: executableVersion,
    claudeInit: (exe, cwd) =>
      runClaude({
        cli: exe,
        cwd,
        prompt: CLAUDE_INITIALIZE_REQUEST,
        args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
        timeoutMs: CLAUDE_SCAN_TIMEOUT_MS,
      }),
    copilotHelp: (exe, cwd) =>
      claudeOutput(exe, ["help", "config"], { timeoutMs: COPILOT_SCAN_TIMEOUT_MS, cwd, label: "Copilot CLI" }),
    ...deps.probes,
  };

  const scan = async (harness: AgentHarness, configured: string | null): Promise<AgentModelsStatus> => {
    const label = AGENT_HARNESSES[harness].label;
    const command = configured ?? AGENT_HARNESSES[harness].cli;
    const none = { harness, models: [], cliVersion: null, scannedAt: null };
    const exe = probes.resolve(command);
    if (!exe) return { ...none, error: configured ? `Not found at ${configured}` : `${command} isn't on PATH` };
    const cliVersion = await probes.version(exe, label).catch(() => null);
    try {
      if (harness === "claude-code") {
        const found = parseClaudeModels(await probes.claudeInit(exe, tmpdir()));
        return {
          harness,
          models: found.models,
          cliVersion: found.cliVersion ?? cliVersion,
          scannedAt: new Date(now()).toISOString(),
          error: null,
        };
      }
      const models = parseCopilotModels(await probes.copilotHelp(exe, tmpdir()));
      return { harness, models, cliVersion, scannedAt: new Date(now()).toISOString(), error: null };
    } catch (error) {
      return { ...none, cliVersion, error: messageOf(error).slice(0, 200) };
    }
  };

  /** One harness's answer, kept by the CLI it came from so a changed path rescans. */
  interface Entry {
    key: string;
    at: number;
    result: Promise<AgentModelsStatus>;
    /** Still running: a refresh joins it rather than starting another scan. */
    pending: boolean;
    ok: boolean;
  }
  const cache = new Map<AgentHarness, Entry>();

  const statusOf = (harness: AgentHarness, settings: AppSettings, refresh: boolean): Promise<AgentModelsStatus> => {
    const configured = harness === "claude-code" ? settings.headlessReviewCli : settings.copilotCli;
    const key = JSON.stringify([harness, probes.resolve(configured ?? AGENT_HARNESSES[harness].cli)]);
    const hit = cache.get(harness);
    if (hit?.key === key && (hit.pending || (!refresh && hit.ok && now() - hit.at < CACHE_MS))) return hit.result;
    const entry: Entry = { key, at: now(), result: scan(harness, configured), pending: true, ok: false };
    cache.set(harness, entry);
    const settle = (status: AgentModelsStatus | null) => {
      entry.pending = false;
      entry.ok = status?.error === null;
      // A scan that failed isn't worth keeping: the next ask tries again.
      if (!entry.ok && cache.get(harness) === entry) cache.delete(harness);
    };
    entry.result.then(settle, () => settle(null));
    return entry.result;
  };

  return {
    async status(refresh = false) {
      const settings = deps.services().settings.get();
      const harnesses = await Promise.all(
        (["claude-code", "copilot-cli"] as const).map((harness) => statusOf(harness, settings, refresh)),
      );
      return { harnesses };
    },
  };
}
