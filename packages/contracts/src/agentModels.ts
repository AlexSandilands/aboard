import { z } from "zod";
import { AgentHarness } from "./agentSessions.ts";
import { CLI_EFFORTS, CliEffort } from "./modelTiers.ts";

// The models a harness's CLI says it can run, scanned when Settings → Model tiers asks, so a tier's CLI model is picked
// from a list instead of typed. See docs/features/agent-sessions.md.

export const AgentModel = z.object({
  /** What `--model` takes ("sonnet", "claude-opus-5-5[1m]"). */
  value: z.string(),
  /** The name the CLI shows for it, when it has one. */
  label: z.string().nullable(),
  description: z.string().nullable(),
  /**
   * The effort levels this model supports. Null when the CLI doesn't say per model (Copilot CLI): then the CLI's own
   * list applies (`CLI_EFFORTS`).
   */
  effortLevels: z.array(CliEffort).nullable(),
});
export type AgentModel = z.infer<typeof AgentModel>;

export const AgentModelsStatus = z.object({
  harness: AgentHarness,
  models: z.array(AgentModel),
  /** The CLI's version the list came from; null when it isn't known. */
  cliVersion: z.string().nullable(),
  /** When the list was scanned (ISO), null when no scan ran or got anywhere. */
  scannedAt: z.string().nullable(),
  /** Why the list is empty or short: no CLI, a scan that failed or timed out. The UI then works as free text. */
  error: z.string().nullable(),
});
export type AgentModelsStatus = z.infer<typeof AgentModelsStatus>;

/** `GET /api/agent-models`: one entry per harness. */
export const AgentModels = z.object({ harnesses: z.array(AgentModelsStatus) });
export type AgentModels = z.infer<typeof AgentModels>;

/** The levels to offer for a model: its own when the scan listed them, else the harness's. */
export const modelEffortLevels = (harness: AgentHarness, model: AgentModel | undefined): readonly CliEffort[] =>
  model?.effortLevels?.length ? model.effortLevels : CLI_EFFORTS[harness];
