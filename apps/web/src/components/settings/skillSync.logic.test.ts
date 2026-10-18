import { BRAND, type SkillSyncHarnessStatus, type SkillSyncState } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { skillSyncBadge, skillSyncDescription, skillSyncDisablePrompt, snippetHint } from "./skillSync.logic";

const status = (state: SkillSyncState, enabled = true): SkillSyncHarnessStatus => ({
  harness: "claude",
  enabled,
  state,
  path: "/home/me/.claude/skills/x/SKILL.md",
});

describe("skill sync logic", () => {
  it("labels each state, and shows nothing while off with nothing installed", () => {
    expect(skillSyncBadge(status("up_to_date"))).toEqual({ label: "Up to date", variant: "success" });
    expect(skillSyncBadge(status("edited"))?.label).toBe("Edited by you");
    expect(skillSyncBadge(status("out_of_date"))?.variant).toBe("info");
    expect(skillSyncBadge(status("out_of_date", false))?.variant).toBe("warning");
    expect(skillSyncBadge(status("not_installed"))?.label).toBe("Not installed");
    expect(skillSyncBadge(status("not_installed", false))).toBeNull();
  });

  it("names the folder and asks for a choice when the copy was edited", () => {
    expect(skillSyncDescription(status("up_to_date"))).toContain(`~/.claude/skills/${BRAND.id}`);
    expect(skillSyncDescription(status("edited"))).toMatch(/Overwrite it, or keep yours/);
    expect(skillSyncDescription(status("edited", false))).toMatch(/^Install it/);
  });

  it("asks before turning off only when there is a copy, warning about edits", () => {
    expect(skillSyncDisablePrompt(status("not_installed"))).toBeNull();
    expect(skillSyncDisablePrompt(status("up_to_date"))?.edited).toBe(false);
    const edited = skillSyncDisablePrompt(status("edited"));
    expect(edited?.edited).toBe(true);
    expect(edited?.description).toMatch(/loses them/);
  });

  it("hints at the snippet only once copied", () => {
    expect(snippetHint(undefined)).toBeNull();
    expect(snippetHint({ copied: false, changedSinceCopied: false })).toBeNull();
    expect(snippetHint({ copied: true, changedSinceCopied: false })).toMatch(/Unchanged/);
    expect(snippetHint({ copied: true, changedSinceCopied: true })).toMatch(/Changed since/);
  });
});
