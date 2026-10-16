import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTestHarness } from "../test/harness.ts";

type Harness = ReturnType<typeof createTestHarness>;

async function connect(h: Harness, name = "orchestrator") {
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

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  return { text, isError: result.isError === true };
}

const plan = { phases: [{ title: "Build", steps: [{ title: "Do it" }] }] };

describe("epics over MCP", () => {
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

  it("lists the epic tools", async () => {
    const names = (await agent.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["create_epic", "epic_overview"]));
  });

  it("creates an epic with existing tasks, then adds new ones to it", async () => {
    const loose = await call(agent, "create_task", { title: "Address form", workspacePath, ...plan });
    expect(loose.isError).toBe(false);
    const created = await call(agent, "create_epic", { title: "Checkout", workspacePath, tasks: ["#1"] });
    expect(created.isError).toBe(false);
    expect(created.text).toContain("Created epic #2 in Alpha with #1.");
    expect(created.text).toContain("[Epic · Planned]");
    expect(created.text).toContain("An epic has no plan of its own");
    expect(created.text).not.toContain("Add one with set_plan");

    const backlog = await call(agent, "add_to_backlog", { title: "Payment form", workspacePath, epic: "#2" });
    expect(backlog.text).toBe('Added #3 "Payment form" to Backlog in Alpha in epic #2.');
    const planned = await call(agent, "create_task", { title: "Receipt", workspacePath, epic: "2", ...plan });
    expect(planned.text).toContain("Epic: #2 Checkout");

    const overview = await call(agent, "epic_overview", { task: "#2" });
    expect(overview.text).toContain("Epic #2 Checkout [Backlog]");
    expect(overview.text).toContain("Tasks (0/3 done · 2 Planned, 1 Backlog):");
    expect(overview.text).toMatch(/Backlog \(1\):\n {4}#3 Payment form — no plan/);
    expect(overview.text).toContain("last activity:");
  });

  it("moves tasks in and out of epics with update_task, and filters list_tasks by epic", async () => {
    await call(agent, "create_epic", { title: "Checkout", workspacePath });
    await call(agent, "create_task", { title: "Address form", workspacePath, ...plan });
    await call(agent, "add_to_backlog", { title: "Elsewhere", workspacePath });

    const attached = await call(agent, "update_task", { task: "#2", epic: "#1" });
    expect(attached.text).toContain("Epic: #1 Checkout");
    const listed = await call(agent, "list_tasks", { workspacePath, epic: "#1" });
    expect(listed.text).toContain("#2 Address form");
    expect(listed.text).not.toContain("Elsewhere");
    const all = await call(agent, "list_tasks", { workspacePath });
    expect(all.text).toContain("#1 Checkout [epic] — 0/1 done · 1 Planned");
    expect(all.text).toContain("in epic #1");

    const detached = await call(agent, "update_task", { task: "#2", epic: null });
    expect(detached.text).not.toContain("Epic: #1");
    const epic = await call(agent, "get_task", { task: "#1" });
    expect(epic.text).toContain("Tasks (No tasks yet):");
    expect(epic.text).toContain("removed");
  });

  it("shows open epics in board_overview without counting them as tasks", async () => {
    await call(agent, "create_epic", { title: "Checkout", workspacePath });
    await call(agent, "add_to_backlog", { title: "Payment form", workspacePath, epic: "#1" });
    const overview = await call(agent, "board_overview", {});
    expect(overview.text).toContain("Alpha (/work/alpha) — Backlog 1");
    expect(overview.text).toContain("  epic #1 Checkout [epic] — 0/1 done · 1 Backlog");
  });

  it("explains what an epic can't do", async () => {
    await call(agent, "create_epic", { title: "Checkout", workspacePath });
    await call(agent, "add_to_backlog", { title: "Loose", workspacePath });
    h.services.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
    await call(agent, "add_to_backlog", { title: "Other project", workspacePath: "/work/beta" });

    const plan1 = await call(agent, "set_plan", { task: "#1", ...plan });
    expect(plan1).toMatchObject({ isError: true });
    expect(plan1.text).toContain("is an epic, which has no plan");
    const move = await call(agent, "move_task", { task: "#1", status: "planned" });
    expect(move.text).toContain("its status follows its child tasks");
    const nested = await call(agent, "update_task", { task: "#1", epic: "#1" });
    expect(nested.text).toContain("Epics don't nest");
    const notEpic = await call(agent, "add_to_backlog", { title: "X", workspacePath, epic: "#2" });
    expect(notEpic.text).toContain("#2 is not an epic");
    const otherProject = await call(agent, "create_epic", { title: "E", workspacePath, tasks: ["#3"] });
    expect(otherProject.text).toContain("#3 is in another project");
    expect((await call(agent, "list_tasks", { workspacePath })).text).not.toContain("#5");
    const overviewOfTask = await call(agent, "epic_overview", { task: "#2" });
    expect(overviewOfTask.text).toContain("#2 is a task, not an epic");
  });
});
