import {
  AUTOMATION_SDK_SCOPE,
  AUTOMATION_SDK_SNIPPETS,
  automationsSkillFile,
  BOARD_AGENTS_SNIPPET,
  boardSkillFile,
  BRAND,
  checkAutomationDraft,
  BUILTIN_PLAN_SKILL_BODY,
  BUILTIN_REVIEW_SKILL_BODY,
  SHIPPED_SKILLS,
} from "@repo/contracts";
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

  // The server installs and syncs the board's skills from contracts; the repo ships the same files. After editing
  // skills/aboard or skills/aboard-automations, `pnpm skill:embed` regenerates contracts' copy.
  const shipped = (folder: string, name: string) =>
    readFileSync(new URL(`../../../skills/${folder}/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

  it("keeps skills/aboard/SKILL.md and AGENTS-snippet.md identical to the embedded text", () => {
    expect(shipped("aboard", "SKILL.md")).toBe(boardSkillFile());
    expect(shipped("aboard", "AGENTS-snippet.md")).toBe(BOARD_AGENTS_SNIPPET);
  });

  it("keeps skills/aboard-automations/SKILL.md identical to the embedded text", () => {
    expect(shipped("aboard-automations", "SKILL.md")).toBe(automationsSkillFile());
  });

  it("ships a folder for each skill the board installs, named after its id", () => {
    expect(SHIPPED_SKILLS.map((s) => s.id)).toEqual([BRAND.id, `${BRAND.id}-automations`]);
    for (const shippedSkill of SHIPPED_SKILLS) {
      expect(shippedSkill.file()).toContain(`name: ${shippedSkill.id}\n`);
    }
  });

  // The editor's reference sheet and the authoring skill teach the same snippets; one source keeps them from drifting.
  it("lists every value an action is given in skills/aboard-automations/SKILL.md", () => {
    const text = shipped("aboard-automations", "SKILL.md");
    const names = AUTOMATION_SDK_SCOPE.flatMap((v) => [v.prompt, v.env, v.stdin]).filter((n): n is string => !!n);
    expect(names.filter((name) => !text.includes(name))).toEqual([]);
  });

  // The worked examples are drafts: each must be one the board accepts, with the script above it as its body.
  it("only shows drafts in skills/aboard-automations/SKILL.md that the board accepts", () => {
    const text = shipped("aboard-automations", "SKILL.md");
    const blocks = [...text.matchAll(/```(\w+)\n([\s\S]*?)\n```/g)].map((m) => ({ lang: m[1]!, code: m[2]! }));
    const drafts = blocks.flatMap((block, i) => {
      if (block.lang !== "json" || !block.code.includes('"trigger"')) return [];
      const script = blocks
        .slice(0, i)
        .reverse()
        .find((b) => ["python", "js", "powershell", "sh"].includes(b.lang));
      return [JSON.parse(block.code.replace('"<the script above>"', JSON.stringify(script?.code ?? ""))) as object];
    });
    expect(drafts.length).toBeGreaterThanOrEqual(3);
    for (const draft of drafts) {
      expect(checkAutomationDraft(draft as Record<string, unknown>)).toMatchObject({ ok: true });
    }
  });

  it("quotes the editor's script snippets in skills/aboard-automations/SKILL.md", () => {
    const text = shipped("aboard-automations", "SKILL.md");
    for (const [language, snippets] of Object.entries(AUTOMATION_SDK_SNIPPETS)) {
      for (const snippet of snippets) {
        expect(text, `${language}: ${snippet.title}`).toContain(snippet.code);
      }
    }
  });
});
