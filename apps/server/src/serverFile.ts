import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND, Health } from "@repo/contracts";
import { z } from "zod";

// A running server records where it listens in its data dir, so tools that must not run beside it (a restore,
// which swaps the database file) can find out whether one is using this data dir, whatever port it chose.

const SERVER_FILE = "server.json";
const ServerFile = z.object({ pid: z.number(), url: z.string() });

export function writeServerFile(homeDir: string, url: string): void {
  writeFileSync(join(homeDir, SERVER_FILE), `${JSON.stringify({ pid: process.pid, url })}\n`);
}

/** Removes the file if this process wrote it (another server may have started on the data dir since). */
export function removeServerFile(homeDir: string): void {
  const path = join(homeDir, SERVER_FILE);
  try {
    if (ServerFile.parse(JSON.parse(readFileSync(path, "utf8"))).pid === process.pid) rmSync(path);
  } catch {
    // Missing or unreadable: nothing of ours to remove.
  }
}

/** The URL of a server that is running on `homeDir`, or null. A file left by a crashed server doesn't count. */
export async function runningServerUrl(homeDir: string): Promise<string | null> {
  let url: string;
  try {
    url = ServerFile.parse(JSON.parse(readFileSync(join(homeDir, SERVER_FILE), "utf8"))).url;
  } catch {
    return null;
  }
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
    const health = Health.safeParse(await res.json());
    return health.success && health.data.id === BRAND.id ? url : null;
  } catch {
    return null;
  }
}
