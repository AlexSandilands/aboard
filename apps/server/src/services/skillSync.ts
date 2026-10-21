import {
  BOARD_AGENTS_SNIPPET,
  brandEnv,
  SHIPPED_SKILLS,
  SkillSyncHarness,
  type ShippedSkill,
  type SkillSyncHarnessStatus,
  type SkillSyncSkillStatus,
  type SkillSyncState,
  type SkillSyncStatus,
} from "@repo/contracts";
import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../errors.ts";
import type { Core } from "./core.ts";
import { promptHash } from "./suggestions.ts";

/**
 * The settings key. Not in EXPORTED_SETTINGS: what is installed where belongs to this machine, so a backup restored
 * elsewhere can't claim a file there as the board's to rewrite.
 */
export const SKILL_SYNC_KEY = "skillSync";

type SkillKey = ShippedSkill["key"];

interface HarnessRecord {
  enabled: boolean;
  /**
   * Per skill, the hash of the text the board last wrote (or adopted); a file that still matches it is the board's to
   * rewrite. A skill missing here was never installed by the board.
   */
  installedHashes: Partial<Record<SkillKey, string>>;
}

interface StoredSkillSync {
  harnesses: Partial<Record<SkillSyncHarness, HarnessRecord>>;
  /** Hash of the AGENTS.md snippet when the user last copied it. */
  snippetCopiedHash: string | null;
}

/** What is saved: records from when the board shipped one skill kept its hash in `installedHash`. */
interface SavedHarnessRecord {
  enabled?: boolean;
  installedHash?: string | null;
  installedHashes?: Partial<Record<SkillKey, string>>;
}

const OFF: HarnessRecord = { enabled: false, installedHashes: {} };

const readRecord = (saved: SavedHarnessRecord): HarnessRecord => ({
  enabled: saved.enabled ?? false,
  installedHashes: { ...(saved.installedHash ? { board: saved.installedHash } : {}), ...saved.installedHashes },
});

/** Each harness's own folder, which holds its global `skills/`. */
export type HarnessHomes = Record<SkillSyncHarness, string>;

const defaultHarnessHomes = (userHome: string): HarnessHomes => ({
  claude: join(userHome, ".claude"),
  copilot: join(userHome, ".copilot"),
  codex: join(userHome, ".codex"),
});

/**
 * Where each harness reads global skills from: the folder its own env var names (CLAUDE_CONFIG_DIR, COPILOT_HOME,
 * CODEX_HOME), else the default under the user's home. With brandEnv("USER_HOME") set (the sandbox), those env vars
 * still point into the real home, so only the overridden home is used.
 */
export function harnessHomesFrom(env: NodeJS.ProcessEnv, userHome: string): HarnessHomes {
  const defaults = defaultHarnessHomes(userHome);
  if (env[brandEnv("USER_HOME")]) return defaults;
  return {
    claude: env.CLAUDE_CONFIG_DIR || defaults.claude,
    copilot: env.COPILOT_HOME || defaults.copilot,
    codex: env.CODEX_HOME || defaults.codex,
  };
}

/** A copy saved with CRLF line endings (an editor, git's autocrlf) is still the same text. */
const hashOf = (text: string) => promptHash(text.replace(/\r\n/g, "\n"));

export interface SkillSyncService {
  status(): SkillSyncStatus;
  /** Turns sync on and installs the skills, unless an edited copy is there: that one waits for overwrite. */
  enable(harness: SkillSyncHarness): SkillSyncStatus;
  /** Replaces whatever is installed, the user's edits included, and turns sync on. */
  overwrite(harness: SkillSyncHarness): SkillSyncStatus;
  /** Turns sync off; with `remove`, deletes the installed copies, refusing an edited one unless `force`. */
  disable(harness: SkillSyncHarness, opts: { remove: boolean; force?: boolean }): SkillSyncStatus;
  /** Brings every enabled harness's copies up to date. Run on start; never throws. */
  syncAll(): void;
  snippetCopied(): SkillSyncStatus;
}

/**
 * Installs the board's skills (SHIPPED_SKILLS) into harnesses' global skill folders (`<home>/skills/<id>/SKILL.md`) and
 * keeps them in step with the app. Only a file that still matches what the board last wrote is ever rewritten, so a
 * copy the user edited stays theirs until they choose to overwrite it, while a harness's other skills carry on. Nothing
 * outside the board's own folders is touched.
 */
export function createSkillSyncService(
  core: Core,
  opts: { userHome: string; harnessHomes?: Partial<HarnessHomes> },
): SkillSyncService {
  const { repos } = core;

  const load = (): StoredSkillSync => {
    const stored = repos.settings.all().get(SKILL_SYNC_KEY) as
      | { harnesses?: Partial<Record<SkillSyncHarness, SavedHarnessRecord>>; snippetCopiedHash?: string | null }
      | undefined;
    const harnesses: StoredSkillSync["harnesses"] = {};
    for (const harness of SkillSyncHarness.options) {
      const saved = stored?.harnesses?.[harness];
      if (saved) harnesses[harness] = readRecord(saved);
    }
    return { harnesses, snippetCopiedHash: stored?.snippetCopiedHash ?? null };
  };
  const save = (next: StoredSkillSync) => core.write(() => repos.settings.set(SKILL_SYNC_KEY, next));
  const record = (harness: SkillSyncHarness) => load().harnesses[harness] ?? OFF;
  const setRecord = (harness: SkillSyncHarness, rec: HarnessRecord) => {
    const current = load();
    save({ ...current, harnesses: { ...current.harnesses, [harness]: rec } });
  };

  const homes = { ...defaultHarnessHomes(opts.userHome), ...opts.harnessHomes };
  const skillsDir = (harness: SkillSyncHarness) => join(homes[harness], "skills");
  const pathOf = (harness: SkillSyncHarness, skill: ShippedSkill) => join(skillsDir(harness), skill.id, "SKILL.md");
  const readDisk = (harness: SkillSyncHarness, skill: ShippedSkill): string | null => {
    try {
      return readFileSync(pathOf(harness, skill), "utf8");
    } catch {
      return null;
    }
  };

  const stateOf = (harness: SkillSyncHarness, skill: ShippedSkill, rec: HarnessRecord): SkillSyncState => {
    const disk = readDisk(harness, skill);
    if (disk === null) return "not_installed";
    const diskHash = hashOf(disk);
    if (diskHash === hashOf(skill.file())) return "up_to_date";
    return diskHash === rec.installedHashes[skill.key] ? "out_of_date" : "edited";
  };

  const write = (harness: SkillSyncHarness, skill: ShippedSkill): string => {
    const text = skill.file();
    mkdirSync(dirname(pathOf(harness, skill)), { recursive: true });
    writeFileSync(pathOf(harness, skill), text);
    return hashOf(text);
  };

  /** Installs or updates each of a harness's skills unless the user edited it; the record says what the board owns. */
  const sync = (harness: SkillSyncHarness, rec: HarnessRecord): HarnessRecord => {
    const installedHashes = { ...rec.installedHashes };
    for (const skill of SHIPPED_SKILLS) {
      const state = stateOf(harness, skill, rec);
      // An identical copy (one the user put there, say) is adopted, so it is kept up to date from now on.
      if (state === "up_to_date") installedHashes[skill.key] = hashOf(skill.file());
      else if (state !== "edited") installedHashes[skill.key] = write(harness, skill);
    }
    return { ...rec, installedHashes };
  };

  /** The skills as one: the state that needs the user (or the next sync) most. */
  const combine = (skills: SkillSyncSkillStatus[]): Pick<SkillSyncHarnessStatus, "state" | "installedByBoard"> => {
    const edited = skills.filter((s) => s.state === "edited");
    if (edited.length > 0) return { state: "edited", installedByBoard: edited.every((s) => s.installedByBoard) };
    const installedByBoard = skills.some((s) => s.installedByBoard);
    if (skills.every((s) => s.state === "not_installed")) return { state: "not_installed", installedByBoard };
    // A skill the app gained since the others were installed is missing: the next sync adds it.
    return { state: skills.every((s) => s.state === "up_to_date") ? "up_to_date" : "out_of_date", installedByBoard };
  };

  const status = (): SkillSyncStatus => {
    const stored = load();
    const harnesses = SkillSyncHarness.options.map((harness): SkillSyncHarnessStatus => {
      const rec = stored.harnesses[harness] ?? OFF;
      const skills = SHIPPED_SKILLS.map((skill): SkillSyncSkillStatus => ({
        id: skill.id,
        state: stateOf(harness, skill, rec),
        installedByBoard: rec.installedHashes[skill.key] !== undefined,
        path: pathOf(harness, skill),
      }));
      return { harness, enabled: rec.enabled, ...combine(skills), path: skillsDir(harness), skills };
    });
    return {
      harnesses,
      snippet: {
        copied: stored.snippetCopiedHash !== null,
        changedSinceCopied:
          stored.snippetCopiedHash !== null && stored.snippetCopiedHash !== hashOf(BOARD_AGENTS_SNIPPET),
      },
    };
  };

  return {
    status,
    enable(harness) {
      setRecord(harness, sync(harness, { ...record(harness), enabled: true }));
      return status();
    },
    overwrite(harness) {
      const installedHashes: HarnessRecord["installedHashes"] = {};
      for (const skill of SHIPPED_SKILLS) installedHashes[skill.key] = write(harness, skill);
      setRecord(harness, { enabled: true, installedHashes });
      return status();
    },
    disable(harness, { remove, force }) {
      const rec = record(harness);
      if (!remove) {
        setRecord(harness, { ...rec, enabled: false });
        return status();
      }
      if (!force && SHIPPED_SKILLS.some((skill) => stateOf(harness, skill, rec) === "edited")) {
        throw new AppError("CONFLICT", "An installed skill was edited; pass force to delete it anyway");
      }
      for (const skill of SHIPPED_SKILLS) {
        const path = pathOf(harness, skill);
        rmSync(path, { force: true });
        // The folder goes too when it held only the skill; anything else the user put there stays.
        try {
          rmdirSync(dirname(path));
        } catch {
          // Not empty, or already gone.
        }
      }
      setRecord(harness, OFF);
      return status();
    },
    syncAll() {
      for (const harness of SkillSyncHarness.options) {
        const rec = record(harness);
        if (!rec.enabled) continue;
        try {
          setRecord(harness, sync(harness, rec));
        } catch (error) {
          console.warn(`[skill-sync] couldn't update the ${harness} skills: ${(error as Error).message}`);
        }
      }
    },
    snippetCopied() {
      save({ ...load(), snippetCopiedHash: hashOf(BOARD_AGENTS_SNIPPET) });
      return status();
    },
  };
}
