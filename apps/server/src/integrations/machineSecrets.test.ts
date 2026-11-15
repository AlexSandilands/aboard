import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BRAND } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createMachineSecrets, machineSecretsPath } from "./machineSecrets.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function secretsFile() {
  const dir = mkdtempSync(join(tmpdir(), `${BRAND.id}-secrets-`));
  dirs.push(dir);
  const path = machineSecretsPath(join(dir, "data"));
  return { path, secrets: createMachineSecrets(path) };
}

const token = (n: number) => ({ token: `id${n}.secret${n}`, tokenId: `id${n}`, pairedAt: "2026-01-01T00:00:00.000Z" });
const posix = process.platform !== "win32";
/** The file's permission bits; Windows has none, so there it counts as private. */
const modeOf = (path: string) => (posix ? statSync(path).mode & 0o777 : 0o600);

describe("machine secrets", () => {
  it("keeps a token per machine in a file only the user can read", () => {
    const { path, secrets } = secretsFile();
    expect(secrets.get("a")).toBeNull();
    secrets.set("a", token(1));
    secrets.set("b", token(2));
    expect(secrets.get("a")).toEqual(token(1));
    expect(secrets.get("b")).toEqual(token(2));
    expect(modeOf(path)).toBe(0o600);
    // No temp file is left holding a token.
    expect(readdirSync(dirname(path))).toEqual(["machine-tokens.json"]);
    // A second reader of the same file (a restart) sees them.
    expect(createMachineSecrets(path).get("b")).toEqual(token(2));
  });

  it("forgets one machine's token and keeps the rest", () => {
    const { secrets } = secretsFile();
    secrets.set("a", token(1));
    secrets.set("b", token(2));
    expect(secrets.remove("a")).toBe(true);
    expect(secrets.remove("a")).toBe(false);
    expect(secrets.get("a")).toBeNull();
    expect(secrets.get("b")).toEqual(token(2));
  });

  it.runIf(posix)("closes a file that was left readable by others", () => {
    const { path, secrets } = secretsFile();
    secrets.set("a", token(1));
    chmodSync(path, 0o644);
    expect(secrets.get("a")).toEqual(token(1));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses to write over a file it can't read, rather than drop every token", () => {
    const { path, secrets } = secretsFile();
    secrets.set("a", token(1));
    writeFileSync(path, "{ not json");
    expect(() => secrets.set("b", token(2))).toThrow(/JSON/);
    expect(() => secrets.get("a")).toThrow(/JSON/);
  });
});
