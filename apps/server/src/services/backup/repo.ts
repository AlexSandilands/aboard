import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKUP_REPO_FORMAT_VERSION, BackupRepoIndex, BRAND } from "@repo/contracts";
import { AppError } from "../../errors.ts";
import { isDumpDir } from "./files.ts";

// The git backup repo: `backup.json` at the root, then one folder per machine, each holding a dump in the folder
// layout (files.ts). The layout and why backup.json holds nothing per machine: packages/contracts/src/backup.ts.

export const REPO_INDEX_FILE = "backup.json";
const MANIFEST_FILE = "manifest.json";

/** A machine's folder in the repo, and whose it is by its manifest. */
export interface MachineFolder {
  folder: string;
  /** Null for a dump written before machine folders, which no board owns yet. */
  instanceId: string | null;
  machineName: string | null;
}

const readJsonFile = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new AppError("VALIDATION", `Cannot read ${path}: ${(error as Error).message}`);
  }
};

type Owner = Omit<MachineFolder, "folder">;

/** The manifest fields that say whose dump `dir` is; null when it has no manifest; "other" for another app's. */
function dumpOwner(dir: string): Owner | "other" | null {
  const path = join(dir, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  let manifest: { app?: unknown; instanceId?: unknown; machineName?: unknown };
  try {
    manifest = JSON.parse(readFileSync(path, "utf8")) as typeof manifest;
  } catch {
    return "other";
  }
  if (manifest?.app !== BRAND.id) return "other";
  return {
    instanceId: typeof manifest.instanceId === "string" ? manifest.instanceId : null,
    machineName: typeof manifest.machineName === "string" ? manifest.machineName : null,
  };
}

/**
 * Whether `dir` holds a dump of ours at its root: a flat backup, from before machine folders. Throws when it holds
 * another app's manifest, so the board never writes into it.
 */
export function isFlatDump(dir: string): boolean {
  const owner = dumpOwner(dir);
  if (owner === "other") throw new AppError("VALIDATION", `${dir} holds a manifest.json that isn't a backup of ours`);
  return owner !== null;
}

/** The machine folders in the repo at `dir`, sorted by name: top-level folders that hold a dump of ours. */
export function machineFolders(dir: string): MachineFolder[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith(".") && statSync(join(dir, name)).isDirectory())
    .sort((a, b) => a.localeCompare(b))
    .flatMap((folder) => {
      // A folder with someone else's manifest.json (a web app's) is just not a machine folder.
      const owner = dumpOwner(join(dir, folder));
      return owner && owner !== "other" ? [{ folder, ...owner }] : [];
    });
}

/** The repo's backup.json, or null when it has none. Throws on another app's or one from a newer version. */
export function readRepoIndex(dir: string): BackupRepoIndex | null {
  const path = join(dir, REPO_INDEX_FILE);
  if (!existsSync(path)) return null;
  const parsed = BackupRepoIndex.safeParse(readJsonFile(path));
  if (!parsed.success) throw new AppError("VALIDATION", `${path} is not a backup index`);
  if (parsed.data.app !== BRAND.id) {
    throw new AppError("VALIDATION", `${dir} holds a backup of ${parsed.data.app}`);
  }
  if (parsed.data.repoFormat > BACKUP_REPO_FORMAT_VERSION) {
    throw new AppError(
      "VALIDATION",
      `${dir} was laid out by a newer version (repo format ${parsed.data.repoFormat}); update to back up to it`,
    );
  }
  return parsed.data;
}

/** Whether `dir` holds a backup of ours in either layout. Throws if it holds another app's. */
export const isBackupRepo = (dir: string): boolean =>
  readRepoIndex(dir) !== null || isFlatDump(dir) || machineFolders(dir).length > 0;

/**
 * Writes backup.json unless it already has these bytes. Every machine writes the same bytes, so two machines adding
 * it at once don't conflict.
 */
export function writeRepoIndex(dir: string): boolean {
  const index: BackupRepoIndex = { app: BRAND.id, repoFormat: BACKUP_REPO_FORMAT_VERSION };
  const contents = `${JSON.stringify(index, null, 2)}\n`;
  const path = join(dir, REPO_INDEX_FILE);
  if (existsSync(path) && readFileSync(path, "utf8") === contents) return false;
  writeFileSync(`${path}.tmp`, contents);
  renameSync(`${path}.tmp`, path);
  return true;
}

/**
 * The dump folder to read at `path`: a flat dump or a machine folder as is, or one machine's folder of a repo, picked
 * by `machine` (a folder or a machine name), or the only one there is.
 */
export function resolveDumpDir(path: string, machine?: string): string {
  if (!machine && isDumpDir(path)) return path;
  const folders = machineFolders(path);
  const names = folders.map((f) => f.folder).join(", ");
  if (machine) {
    const found =
      folders.find((f) => f.folder === machine) ??
      folders.find((f) => f.folder.toLowerCase() === machine.toLowerCase() || f.machineName === machine);
    if (!found) {
      throw new AppError(
        "NOT_FOUND",
        folders.length ? `${path} has no machine ${machine} (it has ${names})` : `${path} holds no machine folders`,
      );
    }
    return join(path, found.folder);
  }
  if (folders.length === 1) return join(path, folders[0]!.folder);
  if (folders.length > 1) {
    throw new AppError("VALIDATION", `${path} holds backups of several machines (${names}); pass --machine <name>`);
  }
  throw new AppError("VALIDATION", `${path} is not a backup: it has no ${MANIFEST_FILE}`);
}
