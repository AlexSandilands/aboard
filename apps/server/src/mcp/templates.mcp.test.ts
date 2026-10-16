import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTestHarness } from "../test/harness.ts";

type Harness = ReturnType<typeof createTestHarness>;

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

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  return { text, isError: result.isError === true };
}

describe("templates over MCP", () => {
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

  it("lists templates with their plans, and the project's own with the board-wide ones", async () => {
    const project = h.services.projects.resolve({ workspacePath });
    h.services.templates.create({ name: "Alpha chore", projectId: project.id, titlePattern: "Chore {{date}}" });
    const all = await call(agent, "list_templates", { workspacePath });
    expect(all.isError).toBe(false);
    expect(all.text).toContain("Bug  (board-wide)");
    expect(all.text).toContain("plan: Fix the bug: Reproduce; Fix; Regression test");
    expect(all.text).toContain("Alpha chore  (project Alpha)");
    expect(all.text).toContain("title: Chore {{date}}");

    const elsewhere = await call(agent, "list_templates", { workspacePath: "/work/unknown" });
    expect(elsewhere.text).toContain("Spike");
    expect(elsewhere.text).not.toContain("Alpha chore");
  });

  it("gives agents no tool to create or edit templates", async () => {
    const names = (await agent.listTools()).tools.map((t) => t.name);
    expect(names).toContain("list_templates");
    expect(names.filter((n) => n.includes("template"))).toEqual(["list_templates"]);
    expect(agent.getInstructions()).toContain("list_templates");
  });

  it("add_to_backlog copies the template into a Backlog task, and what the agent passes wins", async () => {
    const created = await call(agent, "add_to_backlog", { title: "Upload fails", workspacePath, template: "bug" });
    expect(created.isError).toBe(false);
    expect(created.text).toMatch(
      /Added #\d+ "Upload fails" to Backlog in Alpha from template Bug with its 3-step plan\./,
    );
    const task = h.services.tasks.detail(h.services.tasks.resolveId("#1"));
    expect(task).toMatchObject({ status: "backlog", labels: ["bug"], title: "Upload fails" });
    expect(task.description).toContain("## Steps to reproduce");
    expect(task.phases[0]!.steps.map((s) => s.title)).toEqual(["Reproduce", "Fix", "Regression test"]);

    await call(agent, "add_to_backlog", {
      title: "Other",
      workspacePath,
      template: "Bug",
      description: "Mine",
      labels: ["auth"],
    });
    expect(h.services.tasks.detail(h.services.tasks.resolveId("#2"))).toMatchObject({
      description: "Mine",
      labels: ["auth"],
    });
  });

  it("add_to_backlog needs a title unless the template has a title pattern", async () => {
    const refused = await call(agent, "add_to_backlog", { workspacePath, template: "Bug" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("VALIDATION");
    const project = h.services.projects.resolve({ workspacePath });
    h.services.templates.create({ name: "Weekly", projectId: project.id, titlePattern: "Review for {{project}}" });
    const ok = await call(agent, "add_to_backlog", { workspacePath, template: "Weekly" });
    expect(ok.text).toContain('"Review for Alpha"');
  });

  it("create_task takes the template's plan when it is given none, and lands in Planned", async () => {
    const created = await call(agent, "create_task", { title: "Crash on save", workspacePath, template: "Spike" });
    expect(created.isError).toBe(false);
    expect(created.text).toContain("Created task #1");
    expect(created.text).toContain("Questions");
    expect(created.text).toContain("Write up findings");
    expect(h.services.tasks.summary(h.services.tasks.resolveId("#1")).status).toBe("planned");

    const own = await call(agent, "create_task", {
      title: "With own plan",
      workspacePath,
      template: "Spike",
      phases: [{ title: "Mine", steps: [{ title: "Only" }] }],
    });
    expect(own.text).toContain("Only");
    expect(own.text).not.toContain("Questions");
  });

  it("create_task still needs a plan without a template, or when the template has none", async () => {
    const bare = await call(agent, "create_task", { title: "No plan", workspacePath });
    expect(bare.isError).toBe(true);
    expect(bare.text).toContain("or a template that has one");
    h.services.templates.create({ name: "Notes", description: "Just text" });
    const planless = await call(agent, "create_task", { title: "No steps", workspacePath, template: "Notes" });
    expect(planless.isError).toBe(true);
    expect(planless.text).toContain("has no plan");
  });

  it("doesn't create a project when the template isn't found", async () => {
    const missing = await call(agent, "add_to_backlog", { title: "x", workspacePath: "/work/new", template: "Nope" });
    expect(missing.isError).toBe(true);
    expect(h.services.projects.list().map((p) => p.title)).toEqual(["Alpha"]);
    const planned = await call(agent, "create_task", { title: "x", workspacePath: "/work/new", template: "Nope" });
    expect(planned.isError).toBe(true);
    expect(h.services.projects.list()).toHaveLength(1);
    // Nor when the call would be refused for a missing title or plan.
    const untitled = await call(agent, "add_to_backlog", { workspacePath: "/work/new", template: "Bug" });
    expect(untitled.isError).toBe(true);
    h.services.templates.create({ name: "Notes", description: "Just text" });
    const planless = await call(agent, "create_task", { title: "x", workspacePath: "/work/new", template: "Notes" });
    expect(planless.isError).toBe(true);
    expect(h.services.projects.list()).toHaveLength(1);
    const ok = await call(agent, "add_to_backlog", { title: "x", workspacePath: "/work/new", template: "Bug" });
    expect(ok.isError).toBe(false);
    expect(h.services.projects.list()).toHaveLength(2);
  });

  it("names the templates available when one is not found", async () => {
    const missing = await call(agent, "add_to_backlog", { title: "x", workspacePath, template: "Nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("NOT_FOUND");
    expect(missing.text).toContain("Available here: Bug, Feature, Spike.");
  });

  it("shows the template in the task's activity", async () => {
    await call(agent, "add_to_backlog", { title: "Upload fails", workspacePath, template: "Bug" });
    const got = await call(agent, "get_task", { task: "#1" });
    expect(got.text).toContain('created in Backlog from template "Bug"');
  });
});
