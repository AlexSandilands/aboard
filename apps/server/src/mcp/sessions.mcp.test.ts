import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";
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
    const { client, task } = await setup();
    const before = text(await client.callTool({ name: "get_task", arguments: { task: `#${task.number}` } }));
    expect(before).toContain(
      `Your session: if you are the one working on this task, link(task: "#${task.number}", agentSession: {harness: "claude-code", sessionId: <$CLAUDE_CODE_SESSION_ID>`,
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
    const detail = text(await client.callTool({ name: "get_task", arguments: { task: `#${epic.number}` } }));
    expect(detail).toContain("Your session: if you are the one working on this epic");
    expect(detail).toContain("e.g. Orchestrating #N");
  });

  it("doesn't ask other clients", async () => {
    const { client, task } = await setup("codex/1.0");
    const detail = text(await client.callTool({ name: "get_task", arguments: { task: `#${task.number}` } }));
    expect(detail).not.toContain("Your session:");
  });

  it.each([
    ["claude-code", "claude-code"],
    ["Claude Code", "claude-code"],
    ["github-copilot-cli", "copilot-cli"],
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

  it("asks which session when there are several, and says when one has no transcript", async () => {
    const { link, call } = await setup();
    const first = link("Planning");
    const second = link("Implementing");
    const several = await call();
    expect(several.error).toBe(true);
    expect(several.body).toContain("several Claude Code sessions; pass session with one of:");
    expect(several.body.includes(first) && several.body.includes(second)).toBe(true);
    const missing = await call({ session: second });
    expect(missing.error).toBe(true);
    expect(missing.body).toContain(`No transcript for session ${second} was found on this machine`);
  });
});
