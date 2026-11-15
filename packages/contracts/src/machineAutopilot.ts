import { z } from "zod";
import { AutopilotEngineSettings, AutopilotRun, AutopilotSetting } from "./autopilot.ts";
import { AutomationVariables } from "./automationVariables.ts";
import { MachineConnection } from "./machines.ts";
import { CopiedProject } from "./workingCopies.ts";

// Autopilot on a connected machine (docs/features/remote-machines.md#autopilot-on-the-machine): a runner runs the same
// engine over the tasks it holds, by the board's automations and switches, which the board sends it. Its limits are
// its own, set on the board per machine.

/** `PUT`: what the board's Autopilot is, for the machine to run by. */
export const MACHINE_AUTOPILOT_PATH = "/machine/autopilot";

/** The engine settings that are each machine's own: how much runs there, and when. */
export const AutopilotLimits = AutopilotEngineSettings.pick({
  maxConcurrent: true,
  dailyRunCap: true,
  dailySpendCapUsd: true,
  quietHours: true,
});
export type AutopilotLimits = z.infer<typeof AutopilotLimits>;

export const AUTOPILOT_LIMIT_KEYS = ["maxConcurrent", "dailyRunCap", "dailySpendCapUsd", "quietHours"] as const;

/** The limits in a full set of engine settings. */
export const limitsOf = (engine: AutopilotLimits): AutopilotLimits => ({
  maxConcurrent: engine.maxConcurrent,
  dailyRunCap: engine.dailyRunCap,
  dailySpendCapUsd: engine.dailySpendCapUsd,
  quietHours: engine.quietHours,
});

/**
 * `PUT /api/autopilot/machines/:id/limits`: a machine's limits, partially. `reset` drops them, and the machine goes
 * back to the board's own.
 */
export const UpdateAutopilotLimitsInput = AutopilotLimits.extend({
  quietHours: AutopilotLimits.shape.quietHours.partial(),
})
  .partial()
  .extend({ reset: z.literal(true).optional() });
export type UpdateAutopilotLimitsInput = z.infer<typeof UpdateAutopilotLimitsInput>;

/**
 * One of the board's custom automations as a machine gets it. `machineId` is the instance id of the machine a
 * scheduled automation is pinned to, so the runner can tell whether it is its own; null when it isn't pinned.
 */
export const MachineCustomAutomation = z.looseObject({
  id: z.string(),
  machineId: z.string().nullable().optional(),
});
export type MachineCustomAutomation = z.infer<typeof MachineCustomAutomation>;

/**
 * `PUT /machine/autopilot`. The board's switches and config by its own project ids, which the runner maps to its
 * own; the engine settings with this machine's limits laid in; the custom automations; and Pause all. `revision`
 * names what was sent, and the runner answers with it once it has taken it, so the board can tell what has arrived.
 */
export const MachineAutopilotConfig = z.object({
  revision: z.string().min(1),
  paused: z.boolean(),
  engine: AutopilotEngineSettings,
  settings: z.array(AutopilotSetting),
  custom: z.array(MachineCustomAutomation),
  /**
   * Projects a scheduled automation pinned to the machine runs in: the runner clones the ones it doesn't have, as it
   * does for a hand-over.
   */
  projects: z.array(CopiedProject).default([]),
  /**
   * Where an automation paused itself after failing in a row, by the board's project id. The board counts the
   * failures, the machine's replayed runs included, so the pause is lifted in one place.
   */
  autoPaused: z.array(z.object({ automation: z.string(), projectId: z.string() })).default([]),
  /**
   * The values custom automations read (`{{vars.<name>}}`): the board's, and each project's own by the board's id.
   * Without them an automation that names one runs nowhere on the machine.
   */
  variables: z
    .object({ board: AutomationVariables, projects: z.record(z.string(), AutomationVariables) })
    .default({ board: [], projects: {} }),
  /**
   * What the scheduled automations pinned to the machine already did on the board, so a slot or a check item done
   * there isn't done again after the pin. Dedupe keys name the board's project ids; the runner maps them to its own.
   */
  history: z.array(AutopilotRun).default([]),
  /**
   * The machine's own task-less runs (a pinned automation's) the board retried: the runner retires their keys too,
   * so its engine acts on the work again. A held task's runs are retried through its edits instead.
   */
  retried: z.array(z.string()).default([]),
});
export type MachineAutopilotConfig = z.infer<typeof MachineAutopilotConfig>;

export const MachineAutopilotAck = z.object({ revision: z.string() });
export type MachineAutopilotAck = z.infer<typeof MachineAutopilotAck>;

/** A connected machine in the Autopilot settings: its limits and whether it has the board's latest word. */
export const AutopilotMachine = z.object({
  id: z.string(),
  name: z.string(),
  connection: MachineConnection,
  /** Whether it runs Autopilot for the tasks it holds; false for a runner from before that, null until it answers. */
  runsAutopilot: z.boolean().nullable(),
  limits: AutopilotLimits,
  /** False while it goes by the board's own limits. */
  ownLimits: z.boolean(),
  /** It has taken everything the board last changed: switches, automations, limits and Pause all. */
  synced: z.boolean(),
  /** Whether Pause all, as it stands on the board, has reached it; null until it has answered since the board started. */
  pauseDelivered: z.boolean().nullable(),
  /** Its runs going now and started today, as the board has seen them. */
  activeRuns: z.number().int(),
  runsToday: z.number().int(),
});
export type AutopilotMachine = z.infer<typeof AutopilotMachine>;
