import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSkillBody, SKILL_MAX_CHARS } from "./digest.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const skill = (text: string, name = "SKILL.md") => {
  const dir = mkdtempSync(join(tmpdir(), "digest-skill-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

describe("readSkillBody", () => {
  it("gives the instructions without the front matter", () => {
    expect(readSkillBody(skill("---\nname: x\ndescription: y\n---\nBe brief.\n"))).toBe("Be brief.");
    expect(readSkillBody(skill("No front matter."))).toBe("No front matter.");
  });

  it("cuts a long skill", () => {
    const body = readSkillBody(skill("x".repeat(SKILL_MAX_CHARS + 500)));
    expect(body).toBe(`${"x".repeat(SKILL_MAX_CHARS)}\n[cut]`);
  });

  it("refuses an empty skill, a file that isn't a SKILL.md, a directory and a huge file", () => {
    expect(() => readSkillBody(skill("---\nname: x\n---\n"))).toThrow(/is empty/);
    expect(() => readSkillBody(skill("text", "notes.txt"))).toThrow(/isn't a SKILL.md/);
    const dir = mkdtempSync(join(tmpdir(), "digest-skill-"));
    dirs.push(dir);
    mkdirSync(join(dir, "SKILL.md"));
    expect(() => readSkillBody(join(dir, "SKILL.md"))).toThrow(/isn't a readable skill file/);
    expect(() => readSkillBody(skill("x".repeat(300_000)))).toThrow(/isn't a readable skill file/);
  });
});
