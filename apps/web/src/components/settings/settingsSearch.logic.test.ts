import { describe, expect, it } from "vitest";
import { settingsIndex } from "./settingsIndex.logic";
import {
  askEntries,
  initialActive,
  isSearchShortcut,
  looksLikeQuestion,
  moveResult,
  searchSettings,
} from "./settingsSearch.logic";

const entries = settingsIndex();
const ids = (query: string, limit?: number) => searchSettings(entries, query, limit).map((entry) => entry.id);

describe("searchSettings", () => {
  it("finds nothing for an empty or blank query", () => {
    expect(ids("")).toEqual([]);
    expect(ids("   ")).toEqual([]);
  });

  it("ignores case and extra spaces", () => {
    expect(ids("  QUIET   Hours ")[0]).toBe("autopilot.engine.quiet-hours");
  });

  it("puts a title match before a keyword match, and that before a description match", () => {
    // "Backup" the card is the exact title, ahead of the rows whose titles merely start with it.
    const found = ids("backup");
    expect(found[0]).toBe("board.data.backup");
    expect(found.indexOf("board.data.backup-folder")).toBeGreaterThan(0);
    // "Last backup" has it as a later word; "Back up to git" only has "backup" as a keyword, so it comes after.
    expect(found.indexOf("board.data.backup-last")).toBeLessThan(found.indexOf("board.data.backup-enabled"));
    // "git" is in no title but is a keyword of the backup rows and the description of one.
    const git = ids("git");
    expect(git).toContain("board.data.backup-enabled");
  });

  it("ranks a title that starts with the word above one that only contains it", () => {
    const found = ids("budget");
    expect(found.indexOf("tasks.review.budget")).toBeGreaterThanOrEqual(0);
    expect(found.indexOf("tasks.new-tasks.import-budget")).toBeGreaterThanOrEqual(0);
    // "Daily spend cap" mentions no budget in its title: it is found by keyword, after the titled ones.
    expect(found.indexOf("autopilot.engine.daily-spend-cap")).toBeGreaterThan(found.indexOf("tasks.review.budget"));
  });

  it("finds a setting by an alternative name", () => {
    expect(ids("copilot")).toContain("integrations.copilot");
    expect(ids("dark mode")).toContain("board.appearance.theme");
    expect(ids("do not disturb")).toContain("board.notifications.mute-quiet-hours");
  });

  it("needs every word to match something", () => {
    expect(ids("quiet hours")).toContain("autopilot.engine.quiet-hours");
    expect(ids("quiet hours zzz")).toEqual([]);
    // Words may match different fields: the setting's title and where it lives.
    expect(ids("autopilot worktree")[0]).toBe("autopilot.engine.worktree-retention");
  });

  it("finds a setting folded inside a section by name, with the fold to open", () => {
    const [match] = searchSettings(entries, "stuck tasks");
    expect(match?.id).toBe("autopilot.engine.automation-unstick");
    expect(match?.foldedIn).toBe(match?.id);
  });

  it("finds generated rows: notification kinds and model tiers", () => {
    expect(ids("checks failing")).toContain("board.notifications.kind-pr_checks_failing");
    expect(ids("deep")).toContain("models.tiers.deep");
  });

  it("returns a sub-section after a row of the same rank", () => {
    // Both "Review skill" (a row) and the sub-section "Review" match; the exact title wins first.
    expect(ids("review")[0]).toBe("tasks.review");
    const found = ids("review skill");
    expect(found.indexOf("tasks.review.skill")).toBeLessThan(found.indexOf("tasks.review"));
  });

  it("finds nothing for a word that is nowhere", () => {
    expect(ids("xyzzy")).toEqual([]);
  });

  it("caps the results", () => {
    expect(searchSettings(entries, "a", 5)).toHaveLength(5);
  });
});

const keyEvent = (
  key: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("isSearchShortcut", () => {
  it("takes / and Ctrl/Cmd+F", () => {
    expect(isSearchShortcut(keyEvent("/"))).toBe(true);
    expect(isSearchShortcut(keyEvent("f", { ctrlKey: true }))).toBe(true);
    expect(isSearchShortcut(keyEvent("F", { metaKey: true }))).toBe(true);
  });

  it("leaves other keys and combinations alone", () => {
    expect(isSearchShortcut(keyEvent("f"))).toBe(false);
    expect(isSearchShortcut(keyEvent("/", { ctrlKey: true }))).toBe(false);
    expect(isSearchShortcut(keyEvent("f", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSearchShortcut(keyEvent("f", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isSearchShortcut(keyEvent("k", { ctrlKey: true }))).toBe(false);
  });
});

describe("moveResult", () => {
  it("steps and wraps", () => {
    expect(moveResult(0, 1, 3)).toBe(1);
    expect(moveResult(2, 1, 3)).toBe(0);
    expect(moveResult(0, -1, 3)).toBe(2);
  });

  it("starts from either end when nothing is highlighted", () => {
    expect(moveResult(-1, 1, 3)).toBe(0);
    expect(moveResult(-1, -1, 3)).toBe(2);
  });

  it("has nothing to move to without results", () => {
    expect(moveResult(0, 1, 0)).toBe(-1);
  });
});

describe("looksLikeQuestion", () => {
  it("takes a question mark or a question word with a few more words", () => {
    expect(looksLikeQuestion("quiet hours?")).toBe(true);
    expect(looksLikeQuestion("How do I enable Copilot")).toBe(true);
    expect(looksLikeQuestion("where can I stop autopilot at night")).toBe(true);
  });

  it("leaves search words alone, even ones that start like a question", () => {
    expect(looksLikeQuestion("quiet hours")).toBe(false);
    expect(looksLikeQuestion("how")).toBe(false);
    expect(looksLikeQuestion("do not disturb")).toBe(false);
    expect(looksLikeQuestion("whenever")).toBe(false);
    expect(looksLikeQuestion("")).toBe(false);
  });
});

describe("initialActive", () => {
  it("starts on the best result for search words, and on the Ask row for a question or no result", () => {
    expect(initialActive("backup", 5)).toBe(1);
    expect(initialActive("how do I back up the board", 5)).toBe(0);
    expect(initialActive("zzzz", 0)).toBe(0);
  });
});

describe("askEntries", () => {
  it("sends every entry with its location, so the model can name any id", () => {
    const sent = askEntries(entries);
    expect(sent).toHaveLength(entries.length);
    const quiet = sent.find((entry) => entry.id === "autopilot.engine.quiet-hours");
    expect(quiet).toMatchObject({ title: "Quiet hours", location: "Autopilot" });
    expect(quiet?.keywords).toContain("night");
  });
});
