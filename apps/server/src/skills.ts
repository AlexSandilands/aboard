import type { BundleSkill, InstalledSkill, SkillInfo } from "@repo/contracts";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

const SKILL_FILE = "SKILL.md";
/** Where an imported skill is written: the one folder every harness we ship skills for reads. */
const INSTALL_ROOT = ".claude/skills";

/** The text of an installed skill (its folder or its frontmatter name) from the user's own skills, or null. */
export function readInstalledSkill(homeDir: string, name: string): string | null {
  const found = discoverSkills({ homeDir }).find((s) => s.name === name);
  if (!found) return null;
  try {
    return readFileSync(found.path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The skill's text with its frontmatter `name:` set to `name` (added, with a frontmatter block, when there is none).
 * Harnesses go by that name before the folder's, so it has to be the one the board checked and the automation names,
 * whatever the file brought. Only the frontmatter block is edited, never a `name:` line in the body.
 */
function withFrontmatterName(body: string, name: string): string {
  // The empty block (`---` straight after `---`) is tried first, so it isn't read as running on to a later `---`.
  const block = /^---\r?\n(?:---(?=\r?\n|$)|([\s\S]*?)\r?\n---(?=\r?\n|$))/.exec(body);
  if (!block) return `---\nname: ${name}\n---\n${body}`;
  const inside = block[1] ?? "";
  const nameLine = /^name:[ \t]*.*$/m;
  const fields = nameLine.test(inside)
    ? inside.replace(nameLine, `name: ${name}`)
    : `name: ${name}${inside ? `\n${inside}` : ""}`;
  return body.replace(block[0], () => `---\n${fields}\n---`);
}

/**
 * Writes a skill into `~/.claude/skills/<name>/SKILL.md`. A name that is already taken by an installed skill (by its
 * folder or its frontmatter name, in any of the user's skill folders) gets `-2`, `-3` and so on instead, so an import
 * never overwrites a skill of the user's. The file's own frontmatter name is replaced by the installed one, so a file
 * can't install a skill under a name it didn't ask for.
 */
export function installSkill(homeDir: string, skill: BundleSkill): InstalledSkill {
  const taken = new Set(discoverSkills({ homeDir }).map((s) => s.name.toLowerCase()));
  const folders = (() => {
    try {
      return new Set(readdirSync(join(homeDir, INSTALL_ROOT)).map((f) => f.toLowerCase()));
    } catch {
      return new Set<string>();
    }
  })();
  let name = skill.name;
  for (let n = 2; taken.has(name.toLowerCase()) || folders.has(name.toLowerCase()); n++) name = `${skill.name}-${n}`;
  const dir = join(homeDir, INSTALL_ROOT, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, SKILL_FILE);
  writeFileSync(path, withFrontmatterName(skill.body, name), { flag: "wx" });
  return { name, path, renamed: name !== skill.name };
}
