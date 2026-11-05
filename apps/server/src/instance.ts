import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// This board's identity: a random id kept in a file in the data dir, made on first start. It is not a setting, so
// it is never part of a backup and a restore can't change it: a restored board on a new machine is a new machine.
// The backup repo uses it to tell whose machine folder is whose (docs/features/backup.md).

const INSTANCE_FILE = "instance-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const readId = (path: string): string | null => {
  try {
    const id = readFileSync(path, "utf8").trim();
    return UUID.test(id) ? id : null;
  } catch {
    return null;
  }
};

/** The data dir's instance id, created on first call. Two processes starting at once agree on one id. */
export function instanceIdOf(homeDir: string): string {
  const path = join(homeDir, INSTANCE_FILE);
  const existing = readId(path);
  if (existing) return existing;
  mkdirSync(homeDir, { recursive: true });
  // Written in full to a temp file, then hard-linked into place: the link fails if another process made the file
  // first, so nobody ever reads a half-written id and the first writer wins.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${randomUUID()}\n`);
  try {
    linkSync(tmp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Another process won; an unreadable file (cut short by a disk error) is replaced rather than kept forever.
    if (!readId(path)) renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  const id = readId(path);
  if (!id) throw new Error(`Cannot read ${path}`);
  return id;
}
