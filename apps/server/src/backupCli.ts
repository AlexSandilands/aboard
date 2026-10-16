/**
 * `pnpm backup`: export the board to JSON and restore it.
 *
 *   pnpm backup export [--dir <folder> | --file <file>]       default: <data dir>/backup
 *   pnpm backup import <folder|file> [--force]                 replaces the whole board; the server must be stopped
 *   pnpm backup restore-task <folder|file> <number> [--force]  puts one task back; works while the server runs
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ACTOR_HEADER, BRAND, type BoardDump } from "@repo/contracts";
import { loadConfig, type Config } from "./config.ts";
import { createContext } from "./context.ts";
import { openDatabase } from "./db/database.ts";
import { AppError } from "./errors.ts";
import { dumpBoard } from "./services/backup/dump.ts";
import { dumpFileJson, readDump, writeDumpDir } from "./services/backup/files.ts";
import { restoreBoard } from "./services/backup/restore.ts";
import { runningServerUrl } from "./serverFile.ts";

const USAGE = `Usage:
  pnpm backup export [--dir <folder> | --file <file>]
  pnpm backup import <folder|file> [--force]
  pnpm backup restore-task <folder|file> <number> [--force]`;

// pnpm runs package scripts from the package's folder; INIT_CWD is where the user typed the command.
const fromCwd = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);

function exportBoard(config: Config, options: { dir?: string; file?: string }): void {
  const db = openDatabase(config.dbPath);
  let dump: BoardDump;
  try {
    dump = dumpBoard(db);
  } finally {
    db.close();
  }
  const tasks = `${dump.tasks.length} task(s)`;
  if (options.file) {
    const file = fromCwd(options.file);
    writeFileSync(file, dumpFileJson(dump));
    console.log(`Exported ${tasks} to ${file}`);
    return;
  }
  const dir = options.dir ? fromCwd(options.dir) : join(config.homeDir, "backup");
  const { written, removed } = writeDumpDir(dir, dump);
  console.log(`Exported ${tasks} to ${dir} (${written.length} file(s) written, ${removed.length} removed)`);
}

async function importBoard(config: Config, path: string, force: boolean): Promise<void> {
  const running = await runningServerUrl(config.homeDir);
  if (running) {
    throw new AppError("CONFLICT", `A server is running on ${config.homeDir} (${running}). Stop it, then import.`);
  }
  const result = restoreBoard(config.dbPath, readDump(fromCwd(path)), { force });
  console.log(
    `Restored ${result.counts.tasks ?? 0} task(s) into ${config.dbPath} (backup schema ${result.schemaVersion})`,
  );
  if (result.previousDb) console.log(`The previous database was kept as ${result.previousDb}`);
}

async function restoreTask(config: Config, path: string, number: number, force: boolean): Promise<void> {
  const dump = readDump(fromCwd(path));
  const running = await runningServerUrl(config.homeDir);
  let result: { taskId: string; number: number };
  if (running) {
    // Through the server, so open boards update and its database connection isn't bypassed.
    const res = await fetch(`${running}/api/backup/restore-task`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [ACTOR_HEADER]: "user",
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({ dump, number, force }),
    });
    const body = (await res.json()) as { error?: { message: string } } & typeof result;
    if (!res.ok) throw new Error(body.error?.message ?? `The server answered ${res.status}`);
    result = body;
  } else {
    const ctx = createContext({ ...config, pollers: false });
    try {
      result = ctx.services.backup.restoreTask(dump, number, { force, actor: "user" });
    } finally {
      ctx.db.close();
    }
  }
  console.log(
    result.number === number
      ? `Restored task #${number}`
      : `Restored task #${number} as #${result.number} (another task holds #${number})`,
  );
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      file: { type: "string" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  const config = loadConfig();
  switch (command) {
    case "export":
      if (values.dir && values.file) throw new Error("Pass --dir or --file, not both");
      return exportBoard(config, values);
    case "import":
      if (!args[0]) throw new Error(USAGE);
      return importBoard(config, args[0], values.force);
    case "restore-task": {
      const number = Number(args[1]?.replace(/^#/, ""));
      if (!args[0] || !Number.isInteger(number) || number < 1) throw new Error(USAGE);
      return restoreTask(config, args[0], number, values.force);
    }
    default:
      throw new Error(`Unknown command ${command}\n${USAGE}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`[${BRAND.id} backup] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
