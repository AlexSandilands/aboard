import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { BoardDump, TASK_BUNDLE_TABLES, type BackupRow, type TaskBundle } from "@repo/contracts";
import { AppError } from "../../errors.ts";

// The folder form of a dump, laid out for git: one file per task, sharded by the month it was created so old
// folders stop changing, and events by the month they happened (they only grow at the end). Every file is
// deterministic: the same board gives byte-identical files, so an unchanged board makes no commit.

const ROOT_FILES = {
  manifest: "manifest.json",
  settings: "settings.json",
  projects: "projects.json",
  label_colors: "labels.json",
  task_relations: "relations.json",
  counters: "counters.json",
} as const;
const TASKS_DIR = "tasks";
const EVENTS_DIR = "events";

/** "2026-10" from an ISO timestamp; rows with no usable date share one folder. */
const monthOf = (iso: unknown): string => {
  const match = typeof iso === "string" ? /^\d{4}-\d{2}/.exec(iso) : null;
  return match ? match[0] : "undated";
};

/** One row per line, so a change to a row is a one-line diff. */
const rowsJson = (rows: readonly BackupRow[], indent = ""): string =>
  rows.length === 0 ? "[]" : `[\n${rows.map((r) => `${indent}  ${JSON.stringify(r)}`).join(",\n")}\n${indent}]`;

const taskJson = (bundle: TaskBundle): string =>
  [
    "{",
    `  "task": ${JSON.stringify(bundle.task)},`,
    TASK_BUNDLE_TABLES.map((table) => `  "${table}": ${rowsJson(bundle[table], "  ")}`).join(",\n"),
    "}",
  ].join("\n");

export const taskFilePath = (task: BackupRow): string =>
  `${TASKS_DIR}/${monthOf(task.created_at)}/task-${String(task.number)}.json`;

/** The dump as folder files: relative path (with "/") to contents. */
export function dumpFiles(dump: BoardDump): Map<string, string> {
  const files = new Map<string, string>();
  const add = (path: string, body: string) => files.set(path, `${body}\n`);
  add(ROOT_FILES.manifest, JSON.stringify(dump.manifest, null, 2));
  add(ROOT_FILES.settings, rowsJson(dump.settings));
  add(ROOT_FILES.projects, rowsJson(dump.projects));
  add(ROOT_FILES.label_colors, rowsJson(dump.label_colors));
  add(ROOT_FILES.task_relations, rowsJson(dump.task_relations));
  add(ROOT_FILES.counters, rowsJson(dump.counters));
  for (const bundle of dump.tasks) add(taskFilePath(bundle.task), taskJson(bundle));
  const months = new Map<string, BackupRow[]>();
  for (const event of dump.task_events) {
    const month = monthOf(event.at);
    months.set(month, [...(months.get(month) ?? []), event]);
  }
  for (const [month, events] of [...months].sort(([a], [b]) => a.localeCompare(b))) {
    add(`${EVENTS_DIR}/${month}.json`, rowsJson(events));
  }
  return files;
}

/** Writes `contents` to `path` through a temp file, so a crash never leaves a half-written file. */
function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

/** Every file ending in `suffix` under `dir`, as paths relative to `root` with "/" separators. */
function filesUnder(root: string, dir: string, suffix = ".json"): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(suffix) && statSync(join(full, name)).isFile())
    .map((name) => relative(root, join(full, name)).split(sep).join("/"));
}

function removeEmptyDirs(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const child = join(dir, name);
    if (statSync(child).isDirectory()) removeEmptyDirs(child);
  }
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

export interface WriteResult {
  written: string[];
  removed: string[];
}

/**
 * Writes the dump into `dir`, touching only files whose contents changed, and removes task and event files the
 * dump no longer has (a deleted task's file goes, so git history shows when). Anything else in `dir` (.git, a
 * README) is left alone.
 */
export function writeDumpDir(dir: string, dump: BoardDump): WriteResult {
  const files = dumpFiles(dump);
  // Temp files a crash left behind would otherwise be committed with the next backup.
  const leftovers = [
    ...(existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json.tmp")) : []),
    ...filesUnder(dir, TASKS_DIR, ".json.tmp"),
    ...filesUnder(dir, EVENTS_DIR, ".json.tmp"),
  ];
  for (const path of leftovers) rmSync(join(dir, path));
  const written: string[] = [];
  for (const [path, contents] of files) {
    const full = join(dir, path);
    if (existsSync(full) && readFileSync(full, "utf8") === contents) continue;
    writeAtomic(full, contents);
    written.push(path);
  }
  const removed = [...filesUnder(dir, TASKS_DIR), ...filesUnder(dir, EVENTS_DIR)].filter((path) => !files.has(path));
  for (const path of removed) rmSync(join(dir, path));
  removeEmptyDirs(join(dir, TASKS_DIR));
  return { written, removed };
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new AppError("VALIDATION", `Cannot read ${path}: ${(error as Error).message}`);
  }
};

/** Whether `dir` holds a folder dump (has a manifest). */
export const isDumpDir = (dir: string): boolean => existsSync(join(dir, ROOT_FILES.manifest));

/** Reads a folder dump back into one BoardDump. */
export function readDumpDir(dir: string): BoardDump {
  if (!isDumpDir(dir)) throw new AppError("VALIDATION", `${dir} is not a backup: it has no ${ROOT_FILES.manifest}`);
  const root = (file: string) => readJson(join(dir, file));
  const tasks = filesUnder(dir, TASKS_DIR).map((path) => readJson(join(dir, path)) as TaskBundle);
  const events = filesUnder(dir, EVENTS_DIR).flatMap((path) => readJson(join(dir, path)) as BackupRow[]);
  return parseDump({
    manifest: root(ROOT_FILES.manifest),
    settings: root(ROOT_FILES.settings),
    projects: root(ROOT_FILES.projects),
    label_colors: root(ROOT_FILES.label_colors),
    // Absent in backups taken before relations existed.
    task_relations: existsSync(join(dir, ROOT_FILES.task_relations)) ? root(ROOT_FILES.task_relations) : [],
    counters: root(ROOT_FILES.counters),
    tasks: tasks.sort((a, b) => Number(a.task?.number) - Number(b.task?.number)),
    task_events: events.sort((a, b) => Number(a.id) - Number(b.id)),
  });
}

/** The single-file form: the whole BoardDump as one JSON document, for moving a board by hand. */
export const dumpFileJson = (dump: BoardDump): string => `${JSON.stringify(dump, null, 2)}\n`;

/** Reads a backup from a folder or a single file. */
export function readDump(path: string): BoardDump {
  if (!existsSync(path)) throw new AppError("NOT_FOUND", `${path} does not exist`);
  return statSync(path).isDirectory() ? readDumpDir(path) : parseDump(readJson(path));
}

function parseDump(value: unknown): BoardDump {
  const result = BoardDump.safeParse(value);
  if (!result.success) {
    throw new AppError("VALIDATION", `Not a valid backup: ${result.error.issues[0]?.message ?? "unknown error"}`, {
      issues: result.error.issues.slice(0, 5),
    });
  }
  return result.data;
}
