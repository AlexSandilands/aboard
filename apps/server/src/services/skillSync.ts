import {
  BOARD_AGENTS_SNIPPET,
  boardSkillFile,
  BRAND,
  brandEnv,
  SkillSyncHarness,
  type SkillSyncHarnessStatus,
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

interface HarnessRecord {
  enabled: boolean;
  /** Hash of the text the board last wrote (or adopted); a file that still matches it is the board's to rewrite. */
  installedHash: string | null;
}

interface StoredSkillSync {
  harnesses: Partial<Record<SkillSyncHarness, HarnessRecord>>;
  /** Hash of the AGENTS.md snippet when the user last copied it. */
  snippetCopiedHash: string | null;
}

const OFF: HarnessRecord = { enabled: false, installedHash: null };

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
  /** Turns sync on and installs the skill, unless an edited copy is there: that waits for overwrite. */
  enable(harness: SkillSyncHarness): SkillSyncStatus;
  /** Replaces whatever is installed, the user's edits included, and turns sync on. */
  overwrite(harness: SkillSyncHarness): SkillSyncStatus;
  /** Turns sync off; with `remove`, deletes the installed copy, refusing an edited one unless `force`. */
  disable(harness: SkillSyncHarness, opts: { remove: boolean; force?: boolean }): SkillSyncStatus;
  /** Brings every enabled harness's copy up to date. Run on start; never throws. */
  syncAll(): void;
  snippetCopied(): SkillSyncStatus;
}

/**
 * Installs the board skill into harnesses' global skill folders (`<home>/<root>/<BRAND.id>/SKILL.md`) and keeps it in
 * step with the app. Only a file that still matches what the board last wrote is ever rewritten, so a copy the user
 * edited stays theirs until they choose to overwrite it. Nothing outside the board's own folder is touched.
 */
export function createSkillSyncService(
  core: Core,
  opts: { userHome: string; harnessHomes?: Partial<HarnessHomes> },
): SkillSyncService {
  const { repos } = core;

  const load = (): StoredSkillSync => {
    const stored = repos.settings.all().get(SKILL_SYNC_KEY) as Partial<StoredSkillSync> | undefined;
    return { harnesses: stored?.harnesses ?? {}, snippetCopiedHash: stored?.snippetCopiedHash ?? null };
  };
  const save = (next: StoredSkillSync) => core.write(() => repos.settings.set(SKILL_SYNC_KEY, next));
  const record = (harness: SkillSyncHarness) => load().harnesses[harness] ?? OFF;
  const setRecord = (harness: SkillSyncHarness, rec: HarnessRecord) => {
    const current = load();
    save({ ...current, harnesses: { ...current.harnesses, [harness]: rec } });
  };

  const homes = { ...defaultHarnessHomes(opts.userHome), ...opts.harnessHomes };
  const pathOf = (harness: SkillSyncHarness) => join(homes[harness], "skills", BRAND.id, "SKILL.md");
  const readDisk = (harness: SkillSyncHarness): string | null => {
    try {
      return readFileSync(pathOf(harness), "utf8");
    } catch {
      return null;
    }
  };

  const stateOf = (harness: SkillSyncHarness, rec: HarnessRecord): SkillSyncState => {
    const disk = readDisk(harness);
    if (disk === null) return "not_installed";
    const diskHash = hashOf(disk);
    if (diskHash === hashOf(boardSkillFile())) return "up_to_date";
    return diskHash === rec.installedHash ? "out_of_date" : "edited";
  };

  const write = (harness: SkillSyncHarness): string => {
    const text = boardSkillFile();
    mkdirSync(dirname(pathOf(harness)), { recursive: true });
    writeFileSync(pathOf(harness), text);
    return hashOf(text);
  };

  /** Installs or updates one harness's copy unless the user edited it; the record says what the board now owns. */
  const sync = (harness: SkillSyncHarness, rec: HarnessRecord): HarnessRecord => {
    const state = stateOf(harness, rec);
    // An identical copy (one the user put there, say) is adopted, so it is kept up to date from now on.
    if (state === "up_to_date") return { ...rec, installedHash: hashOf(boardSkillFile()) };
    if (state === "edited") return rec;
    return { ...rec, installedHash: write(harness) };
  };

  const status = (): SkillSyncStatus => {
    const stored = load();
    const harnesses = SkillSyncHarness.options.map((harness): SkillSyncHarnessStatus => {
      const rec = stored.harnesses[harness] ?? OFF;
      return {
        harness,
        enabled: rec.enabled,
        state: stateOf(harness, rec),
        installedByBoard: rec.installedHash !== null,
        path: pathOf(harness),
      };
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
      setRecord(harness, { enabled: true, installedHash: write(harness) });
      return status();
    },
    disable(harness, { remove, force }) {
      const rec = record(harness);
      if (!remove) {
        setRecord(harness, { ...rec, enabled: false });
        return status();
      }
      const state = stateOf(harness, rec);
      if (state === "edited" && !force) {
        throw new AppError("CONFLICT", "The installed skill was edited; pass force to delete it anyway");
      }
      const path = pathOf(harness);
      rmSync(path, { force: true });
      // The folder goes too when it held only the skill; anything else the user put there stays.
      try {
        rmdirSync(dirname(path));
      } catch {
        // Not empty, or already gone.
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
          console.warn(`[skill-sync] couldn't update the ${harness} skill: ${(error as Error).message}`);
        }
      }
    },
    snippetCopied() {
      save({ ...load(), snippetCopiedHash: hashOf(BOARD_AGENTS_SNIPPET) });
      return status();
    },
  };
}
