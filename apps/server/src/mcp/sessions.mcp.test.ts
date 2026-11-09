import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import { AGENT_HARNESSES, SELF_LINK_FAILED, SELF_LINK_OTHER_HOST } from "@repo/contracts";
import { harnessOfClient } from "./format.ts";

const ID = "b76a4a91-3196-48df-a421-9a32d5ac9978";

type Harness = ReturnType<typeof createTestHarness>;

/** An SDK client that says it is `userAgent`; the stateless server reads the caller from it on tool calls. */
async function connect(h: Harness, userAgent: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4317/mcp"), {
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      headers.set("host", "127.0.0.1:4317");
      headers.set("user-agent", userAgent);
      return Promise.resolve(h.app.request(url.pathname + url.search, { ...init, headers }));
    },
  });
  await client.connect(transport);
  return client;
}

const text = (result: unknown) =>
  (result as CallToolResult).content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("agent sessions over MCP", () => {
  const open: Array<{ client: Client; h: Harness }> = [];
  afterEach(async () => {
    for (const { client } of open.splice(0)) await client.close();
  });

  async function setup(userAgent = "claude-code/2.1.301") {
    const h = createTestHarness();
    const client = await connect(h, userAgent);
    open.push({ client, h });
    const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
    const task = h.services.tasks.create({
      projectId: project.id,
      title: "Work",
      plan: { phases: [{ title: "P", steps: [{ title: "s" }] }] },
    });
    return { h, client, task };
  }

  it("links the caller's own session", async () => {
    const { h, client, task } = await setup();
    const result = await client.callTool({
      name: "link",
      arguments: {
        task: `#${task.number}`,
        agentSession: { harness: "claude-code", sessionId: ID, cwd: "/work/alpha" },
      },
    });
    expect(text(result)).toContain(`Claude Code session ${ID}`);
    expect(h.services.tasks.summary(task.id).links).toMatchObject([
      { kind: "agent_session", ref: { harness: "claude-code", sessionId: ID, cwd: "/work/alpha" } },
    ]);
  });

  it("refuses a made-up session id, and more than one kind of link per call", async () => {
    const { client, task } = await setup();
    const bad = await client.callTool({
      name: "link",
      arguments: {
        task: `#${task.number}`,
        agentSession: { harness: "claude-code", sessionId: "my-session", cwd: "/w" },
      },
    });
    expect((bad as CallToolResult).isError).toBe(true);
    expect(text(bad)).toMatch(/sessionId must be a UUID/);
    const both = await client.callTool({
      name: "link",
      arguments: {
        task: `#${task.number}`,
        value: "https://example.com",
        agentSession: { harness: "claude-code", sessionId: ID, cwd: "/w" },
      },
    });
    expect(text(both)).toMatch(/exactly one of value, t3Thread or agentSession/);
  });

  it("asks Claude Code for its session in get_task until it is linked", async () => {
    const { h, client, task } = await setup();
    h.services.tasks.move(task.id, { status: "in_progress" }, "test");
    const before = text(await client.callTool({ name: "get_task", arguments: { task: `#${task.number}` } }));
    expect(before).toContain(
      `Your session: only if you're working on this task, link(task: "#${task.number}", agentSession: {harness: "claude-code", sessionId: <$CLAUDE_CODE_SESSION_ID>`,
    );
    await client.callTool({
      name: "link",
      arguments: {
        task: `#${task.number}`,
        agentSession: { harness: "claude-code", sessionId: ID, cwd: "/work/alpha" },
      },
    });
    const after = text(await client.callTool({ name: "get_task", arguments: { task: `#${task.number}` } }));
    expect(after).not.toContain("Your session:");
  });

  it("asks for the session that orchestrates an epic, with its own label", async () => {
    const { h, client, task } = await setup();
    const epic = h.services.tasks.create({ projectId: task.projectId, title: "Feature", kind: "epic" });
    h.services.tasks.update(task.id, { epicId: epic.id }, "test");
    h.services.tasks.move(task.id, { status: "in_progress" }, "test");
    const detail = text(await client.callTool({ name: "get_task", arguments: { task: `#${epic.number}` } }));
    expect(detail).toContain("Your session: only if you're working on this epic");
    expect(detail).toContain("e.g. Orchestrating #N");
  });

  it("asks Codex for $CODEX_THREAD_ID, without promising a live status", async () => {
    // What codex-cli 0.166.0 sends; the stateless server reads the client from it on tool calls.
    const { h, client, task } = await setup("codex-mcp-client/0.166.0");
    h.services.tasks.move(task.id, { status: "in_progress" }, "test");
    const ask = () => client.callTool({ name: "get_task", arguments: { task: `#${task.number}` } });
    const before = text(await ask());
    expect(before).toContain(
      `Your session: only if you're working on this task, link(task: "#${task.number}", agentSession: {harness: "codex", sessionId: <$CODEX_THREAD_ID>`,
    );
    expect(before).toContain("so the user can reopen it in a terminal from the board");
    expect(before).not.toContain("see it running");
    await client.callTool({
      name: "link",
      arguments: {
        task: `#${task.number}`,
        agentSession: { harness: "codex", sessionId: ID, cwd: "/work/alpha" },
        label: `Implementing #${task.number}`,
      },
    });
    expect(text(await ask())).not.toContain("Your session:");
  });

  it("doesn't ask other clients", async () => {
    const { h, client, task } = await setup("vscode/1.105.0");
    h.services.tasks.move(task.id, { status: "in_progress" }, "test");
    const detail = text(await client.callTool({ name: "get_task", arguments: { task: `#${task.number}` } }));
    expect(detail).not.toContain("Your session:");
  });

  it("asks nothing of a session that only reads a task in Backlog or Planned", async () => {
    const { h, client, task } = await setup();
    for (const status of ["backlog", "planned"] as const) {
      h.services.tasks.move(task.id, { status }, "test");
      const detail = text(await client.callTool({ name: "get_task", arguments: { task: `#${task.number}` } }));
      expect(detail).not.toContain("Your session:");
      expect(detail).not.toContain("T3 thread:");
      expect(detail).not.toContain("Link your work:");
    }
  });

  it("says how to look up a T3 thread on a task in progress", async () => {
    const { h, client, task } = await setup();
    h.services.tasks.move(task.id, { status: "in_progress" }, "test");
    const detail = text(await client.callTool({ name: "get_task", arguments: { task: `#${task.number}` } }));
    expect(detail).toContain(
      `T3 thread: only if you're working on this task in T3 Code, link(task: "#${task.number}", value: "<thread id>")`,
    );
    expect(detail).toContain("t3_thread_configure");
    expect(detail).toContain("T3 references");
    expect(detail).toContain(SELF_LINK_FAILED);
  });

  const reminderOf = (result: unknown) => text(result).split("Link your work:")[1] ?? "";

  it("reminds the caller how to link itself when it sets a plan or starts the task", async () => {
    const { h, client, task } = await setup();
    h.services.tasks.move(task.id, { status: "backlog" }, "test");
    const planned = await client.callTool({
      name: "set_plan",
      arguments: { task: `#${task.number}`, markdown: "## P\n- [ ] s" },
    });
    expect(reminderOf(planned)).toContain('label: "Planning #');
    expect(reminderOf(planned)).toContain("$CLAUDE_CODE_SESSION_ID");
    expect(reminderOf(planned)).not.toContain("$CODEX_THREAD_ID");
    const started = await client.callTool({
      name: "move_task",
      arguments: { task: `#${task.number}`, status: "in_progress" },
    });
    expect(reminderOf(started)).toContain('label: "Implementing #');
    expect(reminderOf(started)).toContain("t3_thread_configure");
    // The reminder says it all, so Missing links doesn't repeat it.
    expect(text(started)).not.toContain("T3 thread: only if");
    const review = await client.callTool({
      name: "move_task",
      arguments: { task: `#${task.number}`, status: "planned" },
    });
    expect(text(review)).not.toContain("Link your work:");
  });

  it("still reminds when another thread and session are already linked", async () => {
    const { h, client, task } = await setup();
    h.services.links.add(task.id, { t3Thread: { environmentId: "env", threadId: "filed-it" } }, "other");
    h.services.links.add(
      task.id,
      { agentSession: { harness: "claude-code", sessionId: randomUUID(), cwd: "/work/alpha" } },
      "other",
    );
    const started = await client.callTool({
      name: "move_task",
      arguments: { task: `#${task.number}`, status: "in_progress" },
    });
    expect(reminderOf(started)).toContain("t3_thread_configure");
    expect(reminderOf(started)).toContain("$CLAUDE_CODE_SESSION_ID");
  });

  it("gives a client it can't place every host's lookups and the route for other hosts", async () => {
    const { client, task } = await setup("some-new-agent/1.0");
    const started = await client.callTool({
      name: "move_task",
      arguments: { task: `#${task.number}`, status: "in_progress" },
    });
    for (const { idEnvVar } of Object.values(AGENT_HARNESSES)) expect(reminderOf(started)).toContain(`$${idEnvVar}`);
    expect(reminderOf(started)).toContain(SELF_LINK_OTHER_HOST);
  });

  it("never repeats a refused value that isn't shaped like an id", async () => {
    const { client, task } = await setup();
    const secret = "API_KEY=abc123 PATH=/usr/bin";
    const bad = [
      { value: secret },
      { agentSession: { harness: "claude-code", sessionId: secret, cwd: "/w" } },
      { agentSession: { harness: "claude-code", sessionId: ID, cwd: secret } },
      { agentSession: { harness: secret, sessionId: ID, cwd: "/w" } },
    ];
    for (const args of bad) {
      const result = await client.callTool({ name: "link", arguments: { task: `#${task.number}`, ...args } });
      expect((result as CallToolResult).isError).toBe(true);
      expect(text(result)).not.toContain("abc123");
    }
  });

  it.each([
    ["claude-code", "claude-code"],
    ["Claude Code", "claude-code"],
    ["github-copilot-cli", "copilot-cli"],
    ["codex-mcp-client", "codex"],
    ["Codex", null],
    ["Visual Studio Code", null],
    [undefined, null],
  ])("reads client %j as %j", (client, harness) => expect(harnessOfClient(client)).toBe(harness));
});

describe("get_session_transcript over MCP", () => {
  const dirs: string[] = [];
  const clients: Client[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const claudeDir = mkdtempSync(join(tmpdir(), "transcripts-"));
    dirs.push(claudeDir);
    const h = createTestHarness({ sessionDirs: { claudeDir, copilotDir: join(claudeDir, "copilot") } });
    const client = await connect(h, "claude-code/2.1.0");
    clients.push(client);
    const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
    const task = h.services.tasks.create({
      projectId: project.id,
      title: "Work",
      plan: { phases: [{ title: "P", steps: [{ title: "s" }] }] },
    });
    const link = (label: string) => {
      const sessionId = randomUUID();
      h.services.links.add(
        task.id,
        { agentSession: { harness: "claude-code", sessionId, cwd: "/work/alpha" }, label },
        "agent",
      );
      return sessionId;
    };
    const write = (sessionId: string, entries: object[]) => {
      // Not the folder Claude Code would pick: the transcript is found in any project folder.
      const folder = join(claudeDir, "projects", "elsewhere");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${sessionId}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n"));
    };
    const call = async (args: object = {}) => {
      const result = (await client.callTool({
        name: "get_session_transcript",
        arguments: { task: `#${task.number}`, ...args },
      })) as CallToolResult;
      return { error: result.isError === true, body: text(result) };
    };
    return { link, write, call };
  }

  const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

  it("reads the linked session a page at a time", async () => {
    const { link, write, call } = await setup();
    const id = link("Implementing #1");
    write(id, [
      { type: "user", timestamp: at(0), message: { role: "user", content: "Fix the bug" } },
      {
        type: "assistant",
        timestamp: at(3),
        message: { role: "assistant", content: [{ type: "text", text: "Fixed it." }] },
      },
    ]);
    const read = await call();
    expect(read.error).toBe(false);
    expect(read.body.split("\n")).toEqual([
      `Transcript of Claude Code session ${id} "Implementing #1" for #1`,
      "1 turn, 0 tool calls, 0 errors, 0 denied, 0 retries, 0 interruptions, 3m",
      `From ${at(0)} to ${at(3)}`,
      "Entries 1-2 of 2 (offset 0):",
      "",
      "[user #1] Fix the bug",
      "[assistant] Fixed it.",
      "",
      "End of transcript.",
    ]);
    const past = await call({ offset: 5 });
    expect(past.body).toContain("Offset 5 is past the end: the transcript has 2 entries, offsets 0 to 1.");
  });

  it("reads the newest of several sessions, names the others, and says when one has no transcript", async () => {
    const { link, write, call } = await setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-02T10:00:00.000Z"));
    const first = link("Planning");
    vi.setSystemTime(new Date("2026-03-02T11:00:00.000Z"));
    const second = link("Implementing");
    vi.useRealTimers();
    write(second, [{ type: "user", timestamp: at(0), message: { role: "user", content: "Go" } }]);
    const newest = await call();
    expect(newest.error).toBe(false);
    expect(newest.body).toContain(`session ${second}`);
    expect(newest.body).toContain(
      `The newest of 2 linked Claude Code sessions; pass session to read another: ${first} "Planning".`,
    );
    const missing = await call({ session: first });
    expect(missing.error).toBe(true);
    expect(missing.body).toContain(`No transcript for session ${first} was found on this machine`);
  });
});
