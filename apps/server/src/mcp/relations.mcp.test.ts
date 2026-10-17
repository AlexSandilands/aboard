import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTestHarness } from "../test/harness.ts";

type Harness = ReturnType<typeof createTestHarness>;

async function connect(h: Harness) {
  const client = new Client({ name: "agent", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4317/mcp"), {
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      headers.set("host", "127.0.0.1:4317");
      return Promise.resolve(h.app.request(url.pathname + url.search, { ...init, headers }));
    },
  });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  return { text, isError: result.isError === true };
}

describe("task relations over MCP", () => {
  let h: Harness;
  let agent: Client;
  const workspacePath = "/work/alpha";

  beforeEach(async () => {
    h = createTestHarness();
    agent = await connect(h);
    h.services.projects.create({ title: "Alpha", workspaceRoot: workspacePath });
  });
  afterEach(async () => {
    await agent.close();
    h.db.close();
  });

  it("sets blockers at creation and shows them from both sides", async () => {
    await call(agent, "add_to_backlog", { title: "Migration", workspacePath });
    const created = await call(agent, "add_to_backlog", { title: "API", workspacePath, blockedBy: ["#1"] });
    expect(created.isError).toBe(false);

    const api = await call(agent, "get_task", { task: "#2" });
    expect(api.text).toContain("Blocked by: #1 Migration [Backlog] (blocked until #1 are Done)");
    const migration = await call(agent, "get_task", { task: "#1" });
    expect(migration.text).toContain("Blocks: #2 API [Backlog]");
    expect(migration.text).toContain("now blocks #2 API");
    expect((await call(agent, "list_tasks", { workspacePath })).text).toContain("#2 API — no plan · blocked by #1");
  });

  it("adds and removes blockers with update_task, and stops showing one once it is Done", async () => {
    await call(agent, "add_to_backlog", { title: "Migration", workspacePath });
    await call(agent, "add_to_backlog", { title: "API", workspacePath });
    const added = await call(agent, "update_task", { task: "#2", addBlockedBy: ["#1"] });
    expect(added.text).toContain("Blocked by: #1 Migration");

    await call(agent, "close_task", { task: "#1", resolution: "wont_do" });
    const list = (await call(agent, "list_tasks", { workspacePath })).text;
    expect(list).not.toContain("blocked by");
    expect((await call(agent, "get_task", { task: "#2" })).text).toContain("Blocked by: #1 Migration [Done]");

    const removed = await call(agent, "update_task", { task: "#2", removeBlockedBy: ["#1"] });
    expect(removed.text).not.toContain("Blocked by");
  });

  it("refuses a cycle with the chain in the error", async () => {
    await call(agent, "add_to_backlog", { title: "A", workspacePath });
    await call(agent, "add_to_backlog", { title: "B", workspacePath, blockedBy: ["#1"] });
    const refused = await call(agent, "update_task", { task: "#1", addBlockedBy: ["#2"] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("#2 cannot block #1");
    expect(refused.text).toContain("#1 blocks #2 blocks #1");
  });

  it("tells agents about blocking in the server instructions", () => {
    expect(agent.getInstructions()).toContain("addBlockedBy");
  });
});
