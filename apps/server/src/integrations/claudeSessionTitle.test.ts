import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeProjectSlug, createTitleReader, MISSING_RETRY_MS, readTranscriptTitle } from "./claudeSessionTitle.ts";

const ID = "b76a4a91-3196-48df-a421-9a32d5ac9978";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const line = (entry: object) => `${JSON.stringify({ sessionId: ID, ...entry })}\n`;
const custom = (customTitle: string) => line({ type: "custom-title", customTitle });
const ai = (aiTitle: string) => line({ type: "ai-title", aiTitle });
const noise = (n: number) => line({ type: "user", message: "x".repeat(n) });

function setup() {
  const claudeDir = mkdtempSync(join(tmpdir(), "titles-"));
  roots.push(claudeDir);
  const transcript = (cwd: string, body: string, folder = claudeProjectSlug(cwd)) => {
    mkdirSync(join(claudeDir, "projects", folder), { recursive: true });
    const path = join(claudeDir, "projects", folder, `${ID}.jsonl`);
    writeFileSync(path, body);
    return path;
  };
  return { claudeDir, transcript };
}

describe("Claude session titles", () => {
  it("makes a folder name the way Claude Code does", () => {
    expect(claudeProjectSlug("C:\\Users\\me\\.t3\\worktrees\\app")).toBe("C--Users-me--t3-worktrees-app");
    expect(claudeProjectSlug("/home/me/app")).toBe("-home-me-app");
  });

  it("takes the newest title Claude wrote, and prefers a name the session was given", () => {
    const { transcript } = setup();
    const aiOnly = transcript("/w/a", `${noise(10)}${ai("First")}${noise(10)}${ai("Newer")}`);
    expect(readTranscriptTitle(aiOnly)).toBe("Newer");
    const named = transcript("/w/b", `${ai("Generated")}${custom("Autopilot · Fix PRs")}${ai("Generated again")}`);
    expect(readTranscriptTitle(named)).toBe("Autopilot · Fix PRs");
    expect(readTranscriptTitle(transcript("/w/c", noise(10)))).toBeNull();
  });

  it("tidies a title and cuts a long one", () => {
    const { transcript } = setup();
    expect(readTranscriptTitle(transcript("/w/a", ai("  Two\n lines   here ")))).toBe("Two lines here");
    const long = readTranscriptTitle(transcript("/w/b", ai("x".repeat(500))))!;
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
  });

  it("finds a name given at the start of a long transcript, and skips a line cut in half", () => {
    const { transcript } = setup();
    const long = `${custom("Early name")}${noise(300 * 1024)}${ai("Late title")}`;
    expect(readTranscriptTitle(transcript("/w/a", long))).toBe("Early name");
    const cut = `${noise(200 * 1024)}{"type":"custom-title","customTitle":"Cut off\n${ai("Whole")}`;
    expect(readTranscriptTitle(transcript("/w/b", cut))).toBe("Whole");
  });

  it("finds the transcript by its folder, else by looking in every project folder", () => {
    const { claudeDir, transcript } = setup();
    transcript("/w/app", ai("By folder"));
    const reader = createTitleReader(claudeDir);
    expect(reader.read(ID, "/w/app")).toBe("By folder");
    // The session moved (or the folder name was hashed for a long path): the id still finds it.
    expect(reader.read(ID, "/somewhere/else")).toBe("By folder");
    expect(reader.read(ID, undefined)).toBe("By folder");
  });

  it("says nothing when there is no transcript, no projects folder or an unreadable file", () => {
    const { claudeDir } = setup();
    const reader = createTitleReader(claudeDir);
    expect(reader.read(ID, "/w/app")).toBeNull();
    expect(readTranscriptTitle(join(claudeDir, "nope.jsonl"))).toBeNull();
    expect(createTitleReader(join(claudeDir, "missing")).read(ID, "/w/app")).toBeNull();
  });

  it("doesn't search again for a missing transcript until a while has passed", () => {
    const { claudeDir, transcript } = setup();
    let clock = 1_000;
    const reader = createTitleReader(claudeDir, () => clock);
    expect(reader.read(ID, "/w/app")).toBeNull();
    transcript("/w/app", ai("Now there"));
    clock += MISSING_RETRY_MS - 1;
    expect(reader.read(ID, "/w/app")).toBeNull();
    clock += 1;
    expect(reader.read(ID, "/w/app")).toBe("Now there");
  });

  it("reads a transcript again only when it changed", () => {
    const { claudeDir, transcript } = setup();
    const path = transcript("/w/app", ai("One"));
    const reader = createTitleReader(claudeDir);
    expect(reader.read(ID, "/w/app")).toBe("One");
    writeFileSync(path, `${ai("One")}${custom("Two")}`);
    expect(reader.read(ID, "/w/app")).toBe("Two");
  });
});
