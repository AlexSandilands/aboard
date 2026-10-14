import type { SkillInfo } from "@repo/contracts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Folders that hold Agent Skills (`<name>/SKILL.md`), as the harnesses that read them define them: Claude
 * Code, Copilot, Codex and the cross-harness `.agents` convention.
 */
const GLOBAL_ROOTS = [".claude/skills", ".copilot/skills", ".codex/skills", ".agents/skills"];
const PROJECT_ROOTS = [".claude/skills", ".github/skills", ".agents/skills"];

/** `name` and `description` from YAML frontmatter; enough for the one-line values skills use. */
export function parseSkillFrontmatter(text: string): { name: string | null; description: string | null } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const field = (key: string) => {
    const raw = new RegExp(`^${key}:[ \t]*(.*)$`, "m").exec(block)?.[1]?.trim();
    if (!raw) return null;
    return raw.replace(/^(["'])(.*)\1$/, "$2") || null;
  };
  return { name: field("name"), description: field("description") };
}

function skillsIn(dir: string, source: SkillInfo["source"], root: string): SkillInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found: SkillInfo[] = [];
  for (const entry of entries) {
    const path = join(dir, entry, "SKILL.md");
    try {
      if (!statSync(path).isFile()) continue;
      const meta = parseSkillFrontmatter(readFileSync(path, "utf8").slice(0, 4096));
      found.push({ source, name: meta.name ?? entry, description: meta.description, path, root });
    } catch {
      // Not a skill folder.
    }
  }
  return found;
}

/** Skills installed for the user (under `homeDir`) and in the project's workspace, by source then name. */
export function discoverSkills(opts: { homeDir: string; workspaceRoot?: string | null }): SkillInfo[] {
  const global = GLOBAL_ROOTS.flatMap((root) => skillsIn(join(opts.homeDir, root), "global", `~/${root}`));
  const project = opts.workspaceRoot
    ? PROJECT_ROOTS.flatMap((root) => skillsIn(join(opts.workspaceRoot!, root), "project", root))
    : [];
  const byName = (a: SkillInfo, b: SkillInfo) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root);
  return [...project.sort(byName), ...global.sort(byName)];
}
