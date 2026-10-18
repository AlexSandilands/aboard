import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import { claudeProjectSlug } from "./claudeSessionTitle.ts";
import { createSessionTranscriptReader } from "./sessionTranscript.ts";

const CWD = "/work/alpha";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const claudeDir = mkdtempSync(join(tmpdir(), "transcripts-"));
  roots.push(claudeDir);
  const h = createTestHarness();
  const reader = createSessionTranscriptReader({ services: () => h.services, claudeDir });
  const project = h.services.projects.create({ title: "Alpha", workspaceRoot: CWD });
  const task = h.services.tasks.create({
    projectId: project.id,
    title: "Work",
    plan: { phases: [{ title: "P", steps: [{ title: "s" }] }] },
  });
  const link = (harness: "claude-code" | "copilot-cli", label?: string) => {
    const sessionId = randomUUID();
    h.services.links.add(
      task.id,
      { agentSession: { harness, sessionId, cwd: CWD }, ...(label ? { label } : {}) },
      "agent",
    );
    return sessionId;
  };
  const write = (sessionId: string, prompt: string) => {
    const folder = join(claudeDir, "projects", claudeProjectSlug(CWD));
    mkdirSync(folder, { recursive: true });
    const entry = { type: "user", timestamp: "2026-01-01T10:00:00.000Z", message: { role: "user", content: prompt } };
    writeFileSync(join(folder, `${sessionId}.jsonl`), `${JSON.stringify(entry)}\n`);
  };
  const failure = async (input: { session?: string; offset?: number } = {}) => {
    try {
      await reader.read(task.id, input);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected the read to fail");
  };
  return { h, reader, task, link, write, failure };
}

describe("session transcripts", () => {
  it("reads the one linked Claude Code session, by default or by its id in any case", async () => {
    const { reader, task, link, write } = setup();
    const id = link("claude-code", "Implementing #1");
    write(id, "Fix the bug");
    const read = await reader.read(task.id, {});
    expect(read).toMatchObject({ taskNumber: task.number, sessionId: id, label: "Implementing #1" });
    expect(read.page.lines).toEqual(["[user #1] Fix the bug"]);
    expect(read.stats.turns).toBe(1);
    const named = await reader.read(task.id, { session: ` ${id.toUpperCase()} ` });
    expect(named.sessionId).toBe(id);
  });

  it("asks which session when there are several, and refuses one that isn't linked", async () => {
    const { link, write, failure, reader, task } = setup();
    const first = link("claude-code", "Planning");
    const second = link("claude-code", "Implementing");
    write(second, "Go");
    const several = await failure();
    expect(several.includes("several Claude Code sessions")).toBe(true);
    expect(several.includes(first) && several.includes(second)).toBe(true);
    expect((await reader.read(task.id, { session: second })).sessionId).toBe(second);
    const stranger = await failure({ session: randomUUID() });
    expect(stranger.includes("isn't linked")).toBe(true);
    expect(stranger.includes(first)).toBe(true);
  });

  it("redacts a session's label in the list of sessions", async () => {
    const { link, failure } = setup();
    const value = "x7".repeat(8);
    link("claude-code", `run with ${["TOK", "EN"].join("")}=${value}`);
    link("claude-code");
    const message = await failure();
    expect(message.includes(value)).toBe(false);
    expect(message.includes("[redacted]")).toBe(true);
  });

  it("says why there is nothing to read", async () => {
    const none = setup();
    expect((await none.failure()).includes("no Claude Code session is linked")).toBe(true);
    expect((await none.failure()).includes("can't be read here")).toBe(false);

    const t3 = setup();
    t3.h.services.links.add(t3.task.id, { t3Thread: { environmentId: "local", threadId: "th-1" } }, "user");
    expect((await t3.failure()).includes("(the transcripts of T3 Code threads can't be read here)")).toBe(true);

    const copilot = setup();
    copilot.link("copilot-cli");
    expect((await copilot.failure()).includes("(the transcripts of Copilot CLI sessions can't be read here)")).toBe(
      true,
    );
  });

  it("says when the linked session's transcript isn't on this machine", async () => {
    const { link, failure } = setup();
    const id = link("claude-code");
    const message = await failure();
    expect(message.includes(`No transcript for session ${id} was found`)).toBe(true);
  });
});
