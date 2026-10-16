import type { Automation } from "../types.ts";
import { autoArchive } from "./autoArchive.ts";
import { recurring } from "./recurring.ts";
import { startPlanned } from "./startPlanned.ts";
import { unblockDependents } from "./unblockDependents.ts";

// One file per automation in this folder, each added here. The key is stored in settings and runs, so never
// rename one.

/** The automations the engine runs, in the order the UI lists them. */
export const AUTOMATIONS: readonly Automation[] = [autoArchive, unblockDependents, recurring, startPlanned];
