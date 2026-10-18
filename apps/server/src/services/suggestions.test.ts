import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_REVIEW_SKILL_BODY } from "@repo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import { promptHash } from "./suggestions.ts";

/** A harness whose home folder has one global skill, `review-loop`, chosen as the board's review skill. */
function setup(opts: { crlf?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "suggestions-home-"));
  const dir = join(home, ".claude/skills/review-loop");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  const eol = opts.crlf ? "\r\n" : "\n";
  writeFileSync(path, ["---", "name: review-loop", "---", "", "Review it twice.", ""].join(eol));
  const h = createTestHarness({ userHome: home });
  h.services.settings.update({ reviewSkill: { source: "global", name: "review-loop", path } });
  return { ...h, s: h.services, home, path, key: `skill:${path}` };
}

const suggestFor = (h: ReturnType<typeof setup>, key: string, proposed: string, actor = "improver") => {
  const { hash } = h.s.suggestions.read(key);
  return h.s.suggestions.suggest(
    { target: key, baseHash: hash, proposed, rationale: "Shorter.", evidence: ["#1"] },
    actor,
  );
};

describe("suggestions", () => {
  it("lists the skills Settings use and custom automations' prompts and skills, with where each is used", () => {
    const h = setup();
    const project = h.s.projects.create({ title: "Alpha", workspaceRoot: join(h.home, "alpha") });
    const projectSkill = join(h.home, "alpha/.claude/skills/triage/SKILL.md");
    mkdirSync(join(projectSkill, ".."), { recursive: true });
    writeFileSync(projectSkill, "---\nname: triage\n---\n\nTriage.\n");
    const custom = h.s.customAutomations.create({
      name: "Triage",
      trigger: { kind: "status_change", to: "review" },
      filters: { projectIds: [project.id] },
      action: { kind: "agent", prompt: "Look at {{task.title}}.", skill: "triage" },
    });

    const listed = h.s.suggestions.editable();
    expect(listed.map((p) => [p.key, p.usedBy])).toEqual([
      [h.key, ["Review skill (board)"]],
      ["builtin:plan", ["Planning skill (board)"]],
      [`automation:${custom.id}`, ["Custom automation Triage"]],
      [`skill:${projectSkill}`, ["Skill of custom automation Triage"]],
    ]);
    expect(listed.find((p) => p.key === `skill:${projectSkill}`)?.inRepo).toBe(true);
    expect(h.s.suggestions.read(`automation:${custom.id}`).text).toBe("Look at {{task.title}}.");
  });

  it("refuses targets it doesn't list, so a suggestion can't name any file", () => {
    const h = setup();
    const outside = join(h.home, "notes.md");
    writeFileSync(outside, "mine");
    expect(() => h.s.suggestions.read(`skill:${outside}`)).toThrow(/not found/i);
    expect(() =>
      h.s.suggestions.suggest(
        { target: `skill:${outside}`, baseHash: promptHash("mine"), proposed: "theirs", rationale: "x" },
        "agent",
      ),
    ).toThrow(/not found/i);
  });

  it("records a suggestion and notifies, and refuses a stale hash or an unchanged text", () => {
    const h = setup();
    const before = h.events.length;
    const { suggestion, replaced } = suggestFor(h, h.key, "Review it once.");
    expect(replaced).toBeNull();
    expect(suggestion).toMatchObject({
      status: "open",
      title: "Skill review-loop",
      evidence: ["#1"],
      actor: "improver",
    });
    const published = h.events.slice(before);
    expect(published).toContainEqual({ type: "suggestions.changed", open: 1 });
    expect(published.find((e) => e.type === "notification.created")).toMatchObject({
      notification: { kind: "suggestion", title: "Suggested change to Skill review-loop", body: "improver: Shorter." },
    });

    expect(() =>
      h.s.suggestions.suggest({ target: h.key, baseHash: "0000", proposed: "x", rationale: "x" }, "agent"),
    ).toThrow(/changed since you read it/);
    const { text, hash } = h.s.suggestions.read(h.key);
    expect(() =>
      h.s.suggestions.suggest({ target: h.key, baseHash: hash, proposed: text, rationale: "x" }, "agent"),
    ).toThrow(/same as the current text/);
  });

  it("refuses a change to a CRLF file that only changes its line endings", () => {
    const h = setup({ crlf: true });
    const { text, hash } = h.s.suggestions.read(h.key);
    expect(text).toContain("\r\n");
    expect(() =>
      h.s.suggestions.suggest(
        { target: h.key, baseHash: hash, proposed: text.replace(/\r\n/g, "\n"), rationale: "x" },
        "agent",
      ),
    ).toThrow(/same as the current text/);
  });

  it("keeps each piece of evidence once", () => {
    const h = setup();
    const { hash } = h.s.suggestions.read(h.key);
    const { suggestion } = h.s.suggestions.suggest(
      { target: h.key, baseHash: hash, proposed: "Once.", rationale: "x", evidence: ["#1", "#1 ", "#2"] },
      "agent",
    );
    expect(suggestion.evidence).toEqual(["#1", "#2"]);
  });

  it("keeps one open suggestion per target: a new one supersedes the old", () => {
    const h = setup();
    const first = suggestFor(h, h.key, "One.").suggestion;
    const second = suggestFor(h, h.key, "Two.", "other");
    expect(second.replaced?.id).toBe(first.id);
    expect(h.s.suggestions.get(first.id)).toMatchObject({ status: "superseded", resolvedBy: "other" });
    const list = h.s.suggestions.list();
    expect(list.open).toBe(1);
    expect(list.items.map((s) => [s.id, s.status, s.current])).toEqual([
      [second.suggestion.id, "open", "same"],
      [first.id, "superseded", null],
    ]);
  });

  it("accepts by writing the file, keeping its line endings", () => {
    const h = setup({ crlf: true });
    const { suggestion } = suggestFor(h, h.key, "---\nname: review-loop\n---\n\nReview it once.\n");
    const accepted = h.s.suggestions.accept(suggestion.id, "user");
    expect(accepted).toMatchObject({ status: "accepted", resolvedBy: "user" });
    expect(readFileSync(h.path, "utf8")).toBe("---\r\nname: review-loop\r\n---\r\n\r\nReview it once.\r\n");
    expect(() => h.s.suggestions.accept(suggestion.id, "user")).toThrow(/already accepted/);
  });

  it("marks a suggestion stale instead of applying it when the text changed after the agent read it", () => {
    const h = setup();
    const { suggestion } = suggestFor(h, h.key, "Review it once.");
    writeFileSync(h.path, "Edited by hand.\n");
    expect(h.s.suggestions.list().items[0]?.current).toBe("changed");
    const result = h.s.suggestions.accept(suggestion.id, "user");
    expect(result.status).toBe("stale");
    expect(readFileSync(h.path, "utf8")).toBe("Edited by hand.\n");
  });

  it("marks it stale when the target is no longer in use", () => {
    const h = setup();
    const { suggestion } = suggestFor(h, h.key, "Review it once.");
    h.s.settings.update({ reviewSkill: { source: "builtin" } });
    expect(h.s.suggestions.list().items[0]?.current).toBe("missing");
    expect(h.s.suggestions.accept(suggestion.id, "user").status).toBe("stale");
  });

  it("rejects without writing", () => {
    const h = setup();
    const { suggestion } = suggestFor(h, h.key, "Review it once.");
    expect(h.s.suggestions.reject(suggestion.id, "user").status).toBe("rejected");
    expect(readFileSync(h.path, "utf8")).toContain("Review it twice.");
    expect(h.s.suggestions.list().open).toBe(0);
  });

  it("updates a custom automation's prompt, refusing one with an unknown placeholder", () => {
    const h = setup();
    const custom = h.s.customAutomations.create({
      name: "Nudge",
      trigger: { kind: "stale", status: "in_progress", hours: 24 },
      action: { kind: "agent", prompt: "Nudge #{{task.number}}." },
    });
    const key = `automation:${custom.id}`;
    expect(() => suggestFor(h, key, "Nudge {{task.nope}}.")).toThrow(/isn't a placeholder/);
    const { suggestion } = suggestFor(h, key, "Nudge #{{task.number}} once.");
    h.s.suggestions.accept(suggestion.id, "user");
    expect(h.s.customAutomations.get(custom.id).action).toMatchObject({ prompt: "Nudge #{{task.number}} once." });
  });

  it("saves a change to a built-in skill as the user's own global skill and switches to it", () => {
    const h = setup();
    h.s.settings.update({ reviewSkill: { source: "builtin" } });
    const project = h.s.projects.create({ title: "Beta", workspaceRoot: join(h.home, "beta") });
    h.s.projects.update(project.id, { reviewSkill: { source: "builtin" } });
    // A folder already taken by an earlier fork.
    mkdirSync(join(h.home, ".claude/skills/aboard-review-custom"), { recursive: true });

    expect(h.s.suggestions.read("builtin:review").hash).toBe(promptHash(BUILTIN_REVIEW_SKILL_BODY));
    const { suggestion } = suggestFor(h, "builtin:review", "# Local review\n\nBe brief.");
    expect(h.s.suggestions.list().items[0]).toMatchObject({ builtin: true, inRepo: false });
    const accepted = h.s.suggestions.accept(suggestion.id, "user");

    const path = join(h.home, ".claude/skills/aboard-review-custom-2/SKILL.md");
    expect(accepted.outcome).toContain(path);
    const file = readFileSync(path, "utf8");
    expect(file).toMatch(/^---\nname: aboard-review-custom-2\ndescription: .+\n---\n\n# Local review\n\nBe brief.\n$/);
    const ref = { source: "global", name: "aboard-review-custom-2", path };
    expect(h.s.settings.get().reviewSkill).toEqual(ref);
    expect(h.s.projects.get(project.id).reviewSkill).toEqual(ref);
  });

  it("removes the saved copy of a built-in skill when switching Settings to it fails, and keeps the suggestion open", () => {
    const h = setup();
    h.s.settings.update({ reviewSkill: { source: "builtin" } });
    const { suggestion } = suggestFor(h, "builtin:review", "# Local review\n\nBe brief.");
    const update = vi.spyOn(h.s.settings, "update").mockImplementation(() => {
      throw new Error("settings are read-only");
    });
    expect(() => h.s.suggestions.accept(suggestion.id, "user")).toThrow(/read-only/);
    update.mockRestore();
    expect(existsSync(join(h.home, ".claude/skills/aboard-review-custom"))).toBe(false);
    expect(h.s.suggestions.get(suggestion.id).status).toBe("open");

    // The next try takes the same folder, not `-custom-2` beside an orphan.
    h.s.suggestions.accept(suggestion.id, "user");
    expect(h.s.settings.get().reviewSkill).toMatchObject({ name: "aboard-review-custom" });
  });

  it("is reached over REST: list, accept and reject", async () => {
    const h = setup();
    const a = suggestFor(h, h.key, "Review it once.").suggestion;
    const listed = (await (await h.request("/api/suggestions")).json()) as { open: number };
    expect(listed.open).toBe(1);
    const res = await h.request(`/api/suggestions/${a.id}/reject`, { method: "POST" });
    expect(((await res.json()) as { status: string }).status).toBe("rejected");
    const b = suggestFor(h, h.key, "Review it once.").suggestion;
    const ok = await h.request(`/api/suggestions/${b.id}/accept`, { method: "POST" });
    expect(((await ok.json()) as { status: string }).status).toBe("accepted");
    expect((await h.request(`/api/suggestions/${b.id}/accept`, { method: "POST" })).status).toBe(409);
  });
});
