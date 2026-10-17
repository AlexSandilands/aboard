import { BUILTIN_PLAN_SKILL_BODY, BUILTIN_REVIEW_SKILL_BODY } from "@repo/contracts";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills, parseSkillFrontmatter } from "./skills.ts";

function skill(dir: string, folder: string, frontmatter: string) {
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, folder, "SKILL.md"), `---\n${frontmatter}\n---\n\n# Body\n`);
}

describe("skills", () => {
  it("parses name and description, quoted or not", () => {
    expect(parseSkillFrontmatter('---\nname: "review-loop"\ndescription: Review it.\n---\nbody')).toEqual({
      name: "review-loop",
      description: "Review it.",
    });
    expect(parseSkillFrontmatter("no frontmatter")).toEqual({ name: null, description: null });
  });

  it("finds global and project skills, project first", () => {
    const home = mkdtempSync(join(tmpdir(), "skills-home-"));
    const work = mkdtempSync(join(tmpdir(), "skills-work-"));
    skill(join(home, ".claude/skills"), "review-loop", "name: review-loop\ndescription: Loop it");
    skill(join(home, ".copilot/skills"), "copilot-review", "description: From Copilot");
    skill(join(work, ".github/skills"), "pr-review", "name: pr-review");
    mkdirSync(join(home, ".claude/skills", "not-a-skill"), { recursive: true });

    const found = discoverSkills({ homeDir: home, workspaceRoot: work });
    expect(found.map((s) => [s.source, s.name, s.root])).toEqual([
      ["project", "pr-review", ".github/skills"],
      ["global", "copilot-review", "~/.copilot/skills"],
      ["global", "review-loop", "~/.claude/skills"],
    ]);
    expect(found[2]?.path).toBe(join(home, ".claude/skills", "review-loop", "SKILL.md"));
    expect(discoverSkills({ homeDir: join(home, "missing") })).toEqual([]);
  });

  // The server hands the built-in skill to agents from contracts; the repo ships it as a file too.
  it("keeps skills/aboard-review/SKILL.md identical to the built-in body", () => {
    const file = readFileSync(new URL("../../../skills/aboard-review/SKILL.md", import.meta.url), "utf8");
    const body = file.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n\n/, "");
    expect(body).toBe(BUILTIN_REVIEW_SKILL_BODY);
  });

  it("keeps skills/aboard-plan/SKILL.md identical to the built-in body", () => {
    const file = readFileSync(new URL("../../../skills/aboard-plan/SKILL.md", import.meta.url), "utf8");
    const body = file.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n\n/, "");
    expect(body).toBe(BUILTIN_PLAN_SKILL_BODY);
  });
});
