import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";

// The tokens this board holds for the runners it is paired with (docs/features/remote-machines.md#pairing). They
// live in a file of their own in the data dir, readable by the user only: not in the `settings` table, so no
// settings response, backup or restore ever carries one, and nothing in the API returns them to the browser.

const SECRETS_FILE = "machine-tokens.json";

const StoredToken = z.object({
  token: z.string().min(1),
  tokenId: z.string().min(1),
  pairedAt: z.string(),
});
export type StoredMachineToken = z.infer<typeof StoredToken>;

const SecretsFile = z.object({ machines: z.record(z.string(), StoredToken) });

export interface MachineSecrets {
  /** The token for the runner with this instance id, or null when the board isn't paired with it. */
  get(instanceId: string): StoredMachineToken | null;
  set(instanceId: string, token: StoredMachineToken): void;
  /** Forgets a runner's token; false when there was none. */
  remove(instanceId: string): boolean;
}

export const machineSecretsPath = (homeDir: string): string => join(homeDir, SECRETS_FILE);

export function createMachineSecrets(path: string): MachineSecrets {
  const read = (): Record<string, StoredMachineToken> => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    // Something else (a copy, a restore of the folder) may have widened it; Windows has no such bits to check.
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
    // A file we can't read is an error, not "no tokens": writing over it would unpair every machine.
    return SecretsFile.parse(JSON.parse(text)).machines;
  };
  const write = (machines: Record<string, StoredMachineToken>): void => {
    mkdirSync(dirname(path), { recursive: true });
    // Made private before it holds anything, then moved into place, so the tokens are never readable by others
    // and a crash can't leave half a file.
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ machines }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  };
  return {
    get: (instanceId) => read()[instanceId] ?? null,
    set(instanceId, token) {
      write({ ...read(), [instanceId]: token });
    },
    remove(instanceId) {
      const { [instanceId]: removed, ...rest } = read();
      if (!removed) return false;
      write(rest);
      return true;
    },
  };
}

/** Tokens held in memory only: an in-memory board (tests) has no data dir to keep the file in. */
export function createMemoryMachineSecrets(): MachineSecrets {
  const machines = new Map<string, StoredMachineToken>();
  return {
    get: (instanceId) => machines.get(instanceId) ?? null,
    set: (instanceId, token) => void machines.set(instanceId, token),
    remove: (instanceId) => machines.delete(instanceId),
  };
}
