import {
  automationsSkillFile,
  BOARD_AGENTS_SNIPPET,
  boardSkillFile,
  BRAND,
  brandEnv,
  type SkillSyncStatus,
} from "@repo/contracts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRepos } from "../db/repos/index.ts";
import { createTestHarness } from "../test/harness.ts";
import { harnessHomesFrom, SKILL_SYNC_KEY } from "./skillSync.ts";
import { promptHash } from "./suggestions.ts";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "skill-sync-home-"));
  const h = createTestHarness({ userHome: home });
  const path = join(home, ".claude/skills", BRAND.id, "SKILL.md");
  const automationsPath = join(home, ".claude/skills", `${BRAND.id}-automations`, "SKILL.md");
  const put = (text: string, at = path) => {
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, text);
  };
  const read = (at = path) => readFileSync(at, "utf8");
  const claude = (status: SkillSyncStatus) => status.harnesses.find((s) => s.harness === "claude")!;
  return { home, h, path, automationsPath, put, read, claude, sync: h.services.skillSync };
}

describe("skill sync", () => {
  it("is off by default and touches nothing", () => {
    const { home, sync, claude } = setup();
    sync.syncAll();
    expect(claude(sync.status())).toMatchObject({ enabled: false, state: "not_installed" });
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it("installs every shipped skill when turned on, then leaves up-to-date copies alone", () => {
    const { home, sync, claude, read, path, automationsPath } = setup();
    expect(claude(sync.enable("claude"))).toMatchObject({
      enabled: true,
      state: "up_to_date",
      path: join(home, ".claude/skills"),
      skills: [
        { id: BRAND.id, state: "up_to_date", path },
        { id: `${BRAND.id}-automations`, state: "up_to_date", path: automationsPath },
      ],
    });
    expect(read()).toBe(boardSkillFile());
    expect(read()).toContain(`name: ${BRAND.id}\n`);
    expect(read(automationsPath)).toBe(automationsSkillFile());
    expect(read(automationsPath)).toContain(`name: ${BRAND.id}-automations\n`);
    sync.syncAll();
    expect(claude(sync.status()).state).toBe("up_to_date");
  });

  it("rewrites a copy the board wrote once the app's skill changes", () => {
    const { h, sync, claude, read, put } = setup();
    const old = "---\nname: old\n---\n\nThe old workflow.\n";
    put(old);
    createRepos(h.db).settings.set(SKILL_SYNC_KEY, {
      harnesses: { claude: { enabled: true, installedHashes: { board: promptHash(old) } } },
      snippetCopiedHash: null,
    });
    expect(claude(sync.status()).state).toBe("out_of_date");
    sync.syncAll();
    expect(read()).toBe(boardSkillFile());
    expect(claude(sync.status()).state).toBe("up_to_date");
  });

  it("adds a skill the app gained to a harness that synced only the board skill", () => {
    const { h, sync, claude, read, put, automationsPath } = setup();
    // The record as saved when the board shipped one skill: a single installedHash.
    put(boardSkillFile());
    createRepos(h.db).settings.set(SKILL_SYNC_KEY, {
      harnesses: { claude: { enabled: true, installedHash: promptHash(boardSkillFile()) } },
      snippetCopiedHash: null,
    });
    expect(claude(sync.status())).toMatchObject({ state: "out_of_date", installedByBoard: true });
    expect(existsSync(automationsPath)).toBe(false);
    sync.syncAll();
    expect(read(automationsPath)).toBe(automationsSkillFile());
    expect(claude(sync.status()).state).toBe("up_to_date");
  });

  it("never rewrites a copy the user edited, until they overwrite it", () => {
    const { sync, claude, read, put } = setup();
    sync.enable("claude");
    const edited = `${boardSkillFile()}\nMy own rule.\n`;
    put(edited);
    expect(claude(sync.status())).toMatchObject({ state: "edited", installedByBoard: true });
    sync.syncAll();
    sync.enable("claude");
    expect(read()).toBe(edited);
    expect(claude(sync.overwrite("claude"))).toMatchObject({ enabled: true, state: "up_to_date" });
    expect(read()).toBe(boardSkillFile());
  });

  it("keeps updating the other skill while one is edited", () => {
    const { h, sync, claude, read, put, automationsPath } = setup();
    sync.enable("claude");
    const edited = `${automationsSkillFile()}\nMy own rule.\n`;
    put(edited, automationsPath);
    const old = "---\nname: old\n---\n\nThe old workflow.\n";
    put(old);
    createRepos(h.db).settings.set(SKILL_SYNC_KEY, {
      harnesses: {
        claude: {
          enabled: true,
          installedHashes: { board: promptHash(old), automations: promptHash(automationsSkillFile()) },
        },
      },
      snippetCopiedHash: null,
    });
    expect(claude(sync.status())).toMatchObject({ state: "edited", installedByBoard: true });
    sync.syncAll();
    expect(read()).toBe(boardSkillFile());
    expect(read(automationsPath)).toBe(edited);
  });

  it("adopts an identical copy already there, CRLF or not, and keeps it current", () => {
    const { h, sync, claude, put } = setup();
    put(boardSkillFile().replace(/\n/g, "\r\n"));
    expect(claude(sync.enable("claude")).state).toBe("up_to_date");
    const stored = createRepos(h.db).settings.all().get(SKILL_SYNC_KEY) as {
      harnesses: { claude: { installedHashes: { board: string } } };
    };
    expect(stored.harnesses.claude.installedHashes.board).toBe(promptHash(boardSkillFile()));
  });

  it("treats a different copy already there as edited and leaves it", () => {
    const { sync, claude, read, put } = setup();
    put("---\nname: mine\n---\n\nMy skill.\n");
    expect(claude(sync.enable("claude"))).toMatchObject({ enabled: true, state: "edited", installedByBoard: false });
    expect(read()).toContain("My skill.");
  });

  it("turning off keeps the copy unless asked to remove it", () => {
    const { sync, claude, path } = setup();
    sync.enable("claude");
    expect(claude(sync.disable("claude", { remove: false }))).toMatchObject({ enabled: false, state: "up_to_date" });
    expect(existsSync(path)).toBe(true);
    expect(claude(sync.disable("claude", { remove: true }))).toMatchObject({ enabled: false, state: "not_installed" });
    expect(existsSync(dirname(path))).toBe(false);
  });

  it("refuses to remove an edited copy without force, and never touches other skills", async () => {
    const { h, home, sync, claude, path, put } = setup();
    const other = join(home, ".claude/skills/review-loop/SKILL.md");
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, "---\nname: review-loop\n---\n");
    sync.enable("claude");
    put("edited");
    writeFileSync(join(dirname(path), "notes.md"), "mine");

    const refused = await h.request("/api/skill-sync/claude/disable", { method: "POST", json: { remove: true } });
    expect(refused.status).toBe(409);
    expect(existsSync(path)).toBe(true);

    const removed = await h.request("/api/skill-sync/claude/disable", {
      method: "POST",
      json: { remove: true, force: true },
    });
    expect(claude((await removed.json()) as SkillSyncStatus).state).toBe("not_installed");
    expect(existsSync(path)).toBe(false);
    // The folder had a file of the user's in it, so it stays; other skills are untouched.
    expect(readFileSync(join(dirname(path), "notes.md"), "utf8")).toBe("mine");
    expect(readFileSync(other, "utf8")).toContain("review-loop");
  });

  it("refuses to remove while only the automations skill is edited, then removes both", async () => {
    const { h, sync, claude, read, path, automationsPath, put } = setup();
    sync.enable("claude");
    put("edited", automationsPath);
    writeFileSync(join(dirname(automationsPath), "notes.md"), "mine");

    const refused = await h.request("/api/skill-sync/claude/disable", { method: "POST", json: { remove: true } });
    expect(refused.status).toBe(409);
    expect(existsSync(path)).toBe(true);
    expect(read(automationsPath)).toBe("edited");

    const removed = await h.request("/api/skill-sync/claude/disable", {
      method: "POST",
      json: { remove: true, force: true },
    });
    expect(claude((await removed.json()) as SkillSyncStatus).state).toBe("not_installed");
    expect(existsSync(dirname(path))).toBe(false);
    expect(existsSync(automationsPath)).toBe(false);
    // The automations folder held a file of the user's, so it stays.
    expect(readFileSync(join(dirname(automationsPath), "notes.md"), "utf8")).toBe("mine");
  });

  it("removes both skills when none is edited", () => {
    const { sync, claude, path, automationsPath } = setup();
    sync.enable("claude");
    expect(claude(sync.disable("claude", { remove: true })).state).toBe("not_installed");
    expect(existsSync(dirname(path))).toBe(false);
    expect(existsSync(dirname(automationsPath))).toBe(false);
  });

  it("overwrite restores both skills and records both hashes", () => {
    const { h, sync, claude, read, put, automationsPath } = setup();
    sync.enable("claude");
    put("edited");
    put("edited too", automationsPath);
    expect(claude(sync.status()).state).toBe("edited");
    expect(claude(sync.overwrite("claude"))).toMatchObject({ enabled: true, state: "up_to_date" });
    expect(read()).toBe(boardSkillFile());
    expect(read(automationsPath)).toBe(automationsSkillFile());
    const stored = createRepos(h.db).settings.all().get(SKILL_SYNC_KEY) as {
      harnesses: { claude: { installedHashes: Record<string, string> } };
    };
    expect(stored.harnesses.claude.installedHashes).toEqual({
      board: promptHash(boardSkillFile()),
      automations: promptHash(automationsSkillFile()),
    });
  });

  it("each harness has its own folder and switch", async () => {
    const { h, home } = setup();
    const res = await h.request("/api/skill-sync/codex/enable", { method: "POST" });
    const status = (await res.json()) as SkillSyncStatus;
    expect(status.harnesses.map((s) => [s.harness, s.enabled, s.state])).toEqual([
      ["claude", false, "not_installed"],
      ["copilot", false, "not_installed"],
      ["codex", true, "up_to_date"],
    ]);
    expect(existsSync(join(home, ".codex/skills", BRAND.id, "SKILL.md"))).toBe(true);
    expect((await h.request("/api/skill-sync/agents/enable", { method: "POST" })).status).toBe(400);
  });

  it("remembers the snippet the user copied and says when it changes", () => {
    const { h, sync } = setup();
    expect(sync.status().snippet).toEqual({ copied: false, changedSinceCopied: false });
    expect(sync.snippetCopied().snippet).toEqual({ copied: true, changedSinceCopied: false });
    createRepos(h.db).settings.set(SKILL_SYNC_KEY, {
      harnesses: {},
      snippetCopiedHash: promptHash(`${BOARD_AGENTS_SNIPPET}old`),
    });
    expect(sync.status().snippet).toEqual({ copied: true, changedSinceCopied: true });
  });

  it("installs where the harness's env var moves its folder", () => {
    const home = mkdtempSync(join(tmpdir(), "skill-sync-home-"));
    const copilotHome = mkdtempSync(join(tmpdir(), "skill-sync-copilot-"));
    const homes = harnessHomesFrom({ COPILOT_HOME: copilotHome }, home);
    expect(homes).toEqual({ claude: join(home, ".claude"), copilot: copilotHome, codex: join(home, ".codex") });

    const h = createTestHarness({ userHome: home, harnessHomes: homes });
    const status = h.services.skillSync.enable("copilot").harnesses.find((s) => s.harness === "copilot")!;
    expect(status.path).toBe(join(copilotHome, "skills"));
    expect(readFileSync(status.skills[0]!.path, "utf8")).toBe(boardSkillFile());
    expect(readFileSync(status.skills[1]!.path, "utf8")).toBe(automationsSkillFile());
    expect(existsSync(join(home, ".copilot"))).toBe(false);
  });

  it("ignores the harnesses' env vars when the home is overridden, as the sandbox does", () => {
    const env = {
      [brandEnv("USER_HOME")]: "/sandbox/user",
      CLAUDE_CONFIG_DIR: "/real/.claude",
      CODEX_HOME: "/real/codex",
    };
    expect(harnessHomesFrom(env, "/sandbox/user")).toEqual({
      claude: join("/sandbox/user", ".claude"),
      copilot: join("/sandbox/user", ".copilot"),
      codex: join("/sandbox/user", ".codex"),
    });
  });
});
