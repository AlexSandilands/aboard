import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { isBackupRepo, machineFolders, readRepoIndex, resolveDumpDir, writeRepoIndex } from "./repo.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), `${BRAND.id}-repo-`));
  dirs.push(dir);
  return dir;
};
const manifest = (dir: string, fields: Record<string, unknown> = {}) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ app: BRAND.id, ...fields }));
};

describe("backup repo layout", () => {
  it("lists machine folders by their manifests, skipping other folders and other apps' manifests", () => {
    const dir = tempDir();
    manifest(join(dir, "laptop"), { instanceId: "a", machineName: "laptop" });
    manifest(join(dir, "old"));
    mkdirSync(join(dir, "docs"));
    mkdirSync(join(dir, "web"));
    writeFileSync(join(dir, "web", "manifest.json"), JSON.stringify({ name: "A web app" }));
    expect(machineFolders(dir)).toEqual([
      { folder: "laptop", instanceId: "a", machineName: "laptop" },
      { folder: "old", instanceId: null, machineName: null },
    ]);
    expect(isBackupRepo(dir)).toBe(true);
  });

  it("knows a repo by its backup.json, and refuses another app's or a newer layout", () => {
    const dir = tempDir();
    expect(isBackupRepo(dir)).toBe(false);
    expect(writeRepoIndex(dir)).toBe(true);
    expect(writeRepoIndex(dir)).toBe(false);
    expect(readRepoIndex(dir)).toEqual({ app: BRAND.id, repoFormat: 1 });
    writeFileSync(join(dir, "backup.json"), JSON.stringify({ app: BRAND.id, repoFormat: 99 }));
    expect(() => readRepoIndex(dir)).toThrow(/newer version/);
    writeFileSync(join(dir, "backup.json"), JSON.stringify({ app: "other", repoFormat: 1 }));
    expect(() => isBackupRepo(dir)).toThrow(/backup of other/);
  });

  it("resolves the dump folder to read: a dump as is, a repo's only machine, or the one named", () => {
    const flat = tempDir();
    manifest(flat);
    expect(resolveDumpDir(flat)).toBe(flat);

    const repo = tempDir();
    manifest(join(repo, "laptop"), { machineName: "laptop" });
    expect(resolveDumpDir(repo)).toBe(join(repo, "laptop"));
    manifest(join(repo, "desktop"), { machineName: "Desk top" });
    expect(() => resolveDumpDir(repo)).toThrow(/several machines \(desktop, laptop\); pass --machine/);
    expect(resolveDumpDir(repo, "laptop")).toBe(join(repo, "laptop"));
    expect(resolveDumpDir(repo, "LAPTOP")).toBe(join(repo, "laptop"));
    expect(resolveDumpDir(repo, "Desk top")).toBe(join(repo, "desktop"));
    expect(() => resolveDumpDir(repo, "server")).toThrow(/no machine server \(it has desktop, laptop\)/);
    expect(() => resolveDumpDir(tempDir())).toThrow(/not a backup/);
  });
});
