import type { Automation } from "../types.ts";
import { autoArchive } from "./autoArchive.ts";
import { digest } from "./digest.ts";
import { recurring } from "./recurring.ts";
import { unblockDependents } from "./unblockDependents.ts";
import { unstick } from "./unstick.ts";

// One file per automation in this folder, each added here. The key is stored in settings and runs, so never
// rename one. AUTOPILOT_START_PLANNED (in contracts) is the key the Start planned tasks automation must use.

/** The automations the engine runs, in the order the UI lists them. */
export const AUTOMATIONS: readonly Automation[] = [autoArchive, unblockDependents, recurring, unstick, digest];
