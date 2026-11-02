import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { instanceIdOf } from "./instance.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), `${BRAND.id}-instance-`));
  dirs.push(dir);
  return dir;
};

describe("instanceIdOf", () => {
  it("creates the id once and keeps it", () => {
    const dir = tempDir();
    const id = instanceIdOf(dir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(instanceIdOf(dir)).toBe(id);
    expect(readFileSync(join(dir, "instance-id"), "utf8").trim()).toBe(id);
  });

  it("replaces an unreadable file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "instance-id"), "");
    expect(instanceIdOf(dir)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
