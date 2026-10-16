import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTestHarness } from "../test/harness.ts";

type Harness = ReturnType<typeof createTestHarness>;

async function connect(h: Harness) {
  const client = new Client({ name: "implementer", version: "1.0.0" });
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
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

describe("plan progress hints over MCP", () => {
  let h: Harness;
  let agent: Client;
  let task: string;

  beforeEach(async () => {
    h = createTestHarness();
    agent = await connect(h);
    const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
    const created = h.services.tasks.create({ projectId: project.id, title: "Ship it" });
    task = `#${created.number}`;
    await call(agent, "set_plan", {
      task,
      phases: [{ title: "Build", steps: [{ title: "One" }, { title: "Two" }, { title: "Three" }] }],
    });
  });
  afterEach(async () => {
    await agent.close();
    h.db.close();
  });

  it("names the next step to start after each update", async () => {
    const started = await call(agent, "move_task", { task, status: "in_progress" });
    expect(started).toContain("Plan progress:");
    expect(started).toContain('update_step(task: "' + task + '", step: "1.1", status: "in_progress")');

    const working = await call(agent, "update_step", { task, step: "1.1", status: "in_progress" });
    expect(working).not.toContain("Plan progress:");

    const done = await call(agent, "update_step", { task, step: "1.1", status: "done" });
    expect(done).toContain("Plan progress:");
    expect(done).toContain('step: "1.2", status: "in_progress"');
  });

  it("corrects a bulk update_plan that completes unstarted steps, but not started ones", async () => {
    await call(agent, "move_task", { task, status: "in_progress" });
    const bulk = await call(agent, "update_plan", {
      task,
      steps: [
        { step: "1.1", status: "done" },
        { step: "1.2", status: "done" },
      ],
    });
    expect(bulk).toContain("2 steps went straight to done without being started");

    await call(agent, "update_step", { task, step: "1.3", status: "in_progress" });
    const single = await call(agent, "update_plan", {
      task,
      steps: [{ step: "1.3", status: "done" }],
    });
    expect(single).not.toContain("went straight to done");
  });

  it("lists open steps when the task moves to Review and to Done, but get_task on a Done task stays quiet", async () => {
    await call(agent, "update_step", { task, step: "1.1", status: "done" });
    const review = await call(agent, "move_task", { task, status: "review" });
    expect(review).toContain("2 plan step(s) are still open");

    const done = await call(agent, "move_task", { task, status: "done" });
    expect(done).toContain("2 plan step(s) are still open");
    expect(await call(agent, "get_task", { task })).not.toContain("Plan progress:");
  });
});
