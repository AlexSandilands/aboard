import type { Automation } from "../types.ts";

// One file per automation in this folder, each added here. The key is stored in settings and runs, so never
// rename one. AUTOPILOT_START_PLANNED (in contracts) is the key the Start planned tasks automation must use.

/** The automations the engine runs, in the order the UI lists them. */
export const AUTOMATIONS: readonly Automation[] = [];
