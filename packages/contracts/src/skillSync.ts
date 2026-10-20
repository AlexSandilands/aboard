import { z } from "zod";

/** The harnesses the board can install its skills for, each reading global skills from its own folder. */
export const SkillSyncHarness = z.enum(["claude", "copilot", "codex"]);
export type SkillSyncHarness = z.infer<typeof SkillSyncHarness>;

/**
 * The installed copy against the app's: `edited` when it is neither the app's text nor the text the board last wrote,
 * so the board leaves it alone until the user chooses to overwrite it.
 */
export type SkillSyncState = "not_installed" | "up_to_date" | "out_of_date" | "edited";

/** One shipped skill's installed copy in a harness. */
export interface SkillSyncSkillStatus {
  /** The skill's folder name under the harness's `skills/`. */
  id: string;
  state: SkillSyncState;
  /**
   * The board wrote (or adopted) a copy here. An `edited` copy it never wrote is one put there by hand, often an older
   * version from before sync existed, rather than one the user changed.
   */
  installedByBoard: boolean;
  /** The installed `SKILL.md`'s absolute path. */
  path: string;
}

export interface SkillSyncHarnessStatus {
  harness: SkillSyncHarness;
  /** The user turned sync on for this harness: the board installs its skills and rewrites them when the app changes. */
  enabled: boolean;
  /**
   * All the skills together: `edited` while any is, else `out_of_date` while any differs or is missing from an
   * otherwise installed set (sync installs it on the next start), else `not_installed` when none is.
   */
  state: SkillSyncState;
  /** For `edited`: every edited skill was written by the board. Otherwise: the board wrote any of them. */
  installedByBoard: boolean;
  /** The harness's `skills/` folder, which holds each skill's own folder. */
  path: string;
  skills: SkillSyncSkillStatus[];
}

export interface SkillSyncStatus {
  harnesses: SkillSyncHarnessStatus[];
  /** The AGENTS.md snippet: whether the user copied it, and whether it changed since. */
  snippet: { copied: boolean; changedSinceCopied: boolean };
}

export const SkillSyncDisableBody = z.object({
  /** Delete the installed copy too. */
  remove: z.boolean(),
  /** Delete it even when the user edited it. */
  force: z.boolean().optional(),
});
export type SkillSyncDisableBody = z.infer<typeof SkillSyncDisableBody>;
