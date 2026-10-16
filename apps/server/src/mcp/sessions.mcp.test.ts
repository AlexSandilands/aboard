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
      `Your session: link(task: "#${task.number}", agentSession: {harness: "claude-code", sessionId: <$CLAUDE_CODE_SESSION_ID>`,
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
