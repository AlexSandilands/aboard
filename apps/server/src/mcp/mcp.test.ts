import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTestHarness } from "../test/harness.ts";

type Harness = ReturnType<typeof createTestHarness>;

/** Connects an SDK client to the Hono app in-process: the transport's fetch goes to app.request. */
async function connect(h: Harness, name = "test-agent") {
  const client = new Client({ name, version: "1.0.0" });
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

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as CallToolResult).content;
  return content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

describe("MCP endpoint", () => {
  let h: Harness;
  let client: Client;

  beforeEach(async () => {
    h = createTestHarness();
    client = await connect(h);
  });
  afterEach(async () => {
    await client.close();
    h.db.close();
  });

  it("lists the agent tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of [
      "board_overview",
      "list_projects",
      "list_tasks",
      "get_task",
      "create_idea",
      "create_task",
      "set_plan",
      "add_steps",
      "update_step",
      "move_task",
      "update_task",
      "add_note",
      "link",
    ]) {
      expect(names).toContain(name);
    }
    expect(client.getInstructions()).toContain("get_task");
  });

  it("rejects GET with 405 (stateless)", async () => {
    const res = await h.request("/mcp", { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("drives an idea through plan, progress, links and notes", async () => {
    const workspacePath = "C:\\Fake\\proj";

    const created = await client.callTool({
      name: "create_idea",
      arguments: { title: "Add dark mode", description: "Users asked for it", workspacePath },
    });
    expect(created.isError).toBeFalsy();
    expect(text(created)).toMatch(/#\d+/);
    const number = (created.structuredContent as { number: number }).number;
    const task = `#${number}`;

    const gated = await client.callTool({ name: "move_task", arguments: { task, status: "planned" } });
    expect(gated.isError).toBe(true);
    expect(text(gated)).toContain("PLAN_REQUIRED");
    expect(text(gated)).toContain("set_plan");

    const planned = await client.callTool({
      name: "set_plan",
      arguments: {
        task,
        markdown: "## Build\n- [ ] Add theme tokens\n- [ ] Wire toggle\n\n## Verify\n- [ ] Test in both themes\n",
        context: "Use CSS variables.",
      },
    });
    expect(planned.isError).toBeFalsy();
    expect(text(planned)).toContain("1.1 [ ] Add theme tokens");

    const moved = await client.callTool({ name: "move_task", arguments: { task, status: "in_progress" } });
    expect(moved.isError).toBeFalsy();
    expect(text(moved)).toContain("In Progress");

    const stepped = await client.callTool({ name: "update_step", arguments: { task, step: "1.1", status: "done" } });
    expect(stepped.isError).toBeFalsy();

    const linked = await client.callTool({
      name: "link",
      arguments: { task, value: "https://github.com/acme/app/pull/12" },
    });
    expect(linked.isError).toBeFalsy();
    expect(text(linked)).toContain("acme/app#12");

    const noted = await client.callTool({
      name: "add_note",
      arguments: { task, text: "Handover: toggle wiring next.", actor: "claude-code" },
    });
    expect(noted.isError).toBeFalsy();

    const detail = text(await client.callTool({ name: "get_task", arguments: { task } }));
    expect(detail).toContain("Add dark mode");
    expect(detail).toContain("1.1 [x] Add theme tokens");
    expect(detail).toContain("Use CSS variables.");
    expect(detail).toContain("acme/app#12");
    expect(detail).toContain("claude-code: note: Handover: toggle wiring next.");
    expect(detail).toContain('step "Add theme tokens" todo -> done');

    const listed = text(await client.callTool({ name: "list_tasks", arguments: { workspacePath } }));
    expect(listed).toContain(`#${number} Add dark mode`);

    const overview = text(await client.callTool({ name: "board_overview", arguments: { workspacePath } }));
    expect(overview).toContain("In Progress 1");
  });

  it("update_task only moves projects through the explicit moveTo params", async () => {
    const home = h.services.projects.create({ workspaceRoot: "C:/Fake/home" });
    const other = h.services.projects.create({ workspaceRoot: "C:/Fake/other" });
    const task = h.services.tasks.create({ projectId: home.id, title: "Stay put" });

    // Agents habitually pass workspacePath; it must not move the task.
    const edited = await client.callTool({
      name: "update_task",
      arguments: { task: task.id, title: "Renamed", workspacePath: "C:/Fake/other" },
    });
    expect(edited.isError).toBeFalsy();
    expect(h.services.tasks.summary(task.id)).toMatchObject({ title: "Renamed", projectId: home.id });

    const unknown = await client.callTool({
      name: "update_task",
      arguments: { task: task.id, moveToWorkspacePath: "C:/Fake/nowhere" },
    });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/^NOT_FOUND: /);
    expect(h.services.projects.list()).toHaveLength(2);

    const moved = await client.callTool({
      name: "update_task",
      arguments: { task: task.id, moveToWorkspacePath: "C:/Fake/other/src" },
    });
    expect(moved.isError).toBeFalsy();
    expect(h.services.tasks.summary(task.id).projectId).toBe(other.id);
  });

  it("treats an unknown workspace as empty for read-only tools", async () => {
    const result = await client.callTool({ name: "list_tasks", arguments: { workspacePath: "C:\\Nowhere" } });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("No tasks yet");
  });

  it("returns readable errors for unknown tasks", async () => {
    const result = await client.callTool({ name: "get_task", arguments: { task: "#999" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^NOT_FOUND: /);
  });
});
