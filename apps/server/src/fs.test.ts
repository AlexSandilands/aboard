import type { ApiErrorBody, FsBrowseResult } from "@taskboard/contracts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { browseDirectory } from "./fs.ts";
import { createTestHarness } from "./test/harness.ts";

const root = mkdtempSync(join(tmpdir(), "taskboard-fs-"));
for (const name of ["beta", "Alpha", ".hidden", "gamma"]) mkdirSync(join(root, name));
writeFileSync(join(root, "file.txt"), "x");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("fs browse", () => {
  it("lists visible directories sorted case-insensitively", () => {
    const result = browseDirectory(root);
    expect(result.entries.map((e) => e.name)).toEqual(["Alpha", "beta", "gamma"]);
    expect(result.entries[0]!.fullPath).toBe(join(root, "Alpha"));
    expect(result.parentPath).toBe(dirname(root));
  });

  it("expands ~ and defaults to the home directory", () => {
    expect(browseDirectory("").path).toBe(homedir());
    expect(browseDirectory("~").path).toBe(homedir());
  });

  it("lists drive roots for / on Windows", () => {
    const drives = browseDirectory("/", "win32");
    expect(drives.parentPath).toBeNull();
    if (process.platform === "win32") expect(drives.entries.length).toBeGreaterThan(0);
  });

  it("maps missing folders and files to API errors", async () => {
    const h = createTestHarness();
    const missing = await h.request(`/api/fs/browse?path=${encodeURIComponent(join(root, "nope"))}`);
    expect(missing.status).toBe(404);
    const file = await h.request(`/api/fs/browse?path=${encodeURIComponent(join(root, "file.txt"))}`);
    expect(file.status).toBe(400);
    expect(((await file.json()) as ApiErrorBody).error.code).toBe("VALIDATION");
    const ok = await h.request(`/api/fs/browse?path=${encodeURIComponent(root)}`);
    expect(((await ok.json()) as FsBrowseResult).entries).toHaveLength(3);
  });
});
