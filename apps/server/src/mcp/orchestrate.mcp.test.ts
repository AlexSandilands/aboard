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

describe("orchestrating an epic over MCP", () => {
  let h: Harness;
  let agent: Client;
  let epicId: string;
  let taskId: string;

  beforeEach(async () => {
    h = createTestHarness();
    agent = await connect(h);
    const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
    epicId = h.services.tasks.create({ projectId: project.id, title: "Checkout", kind: "epic" }).id;
    taskId = h.services.tasks.create({ projectId: project.id, title: "Address form", epicId, plan }).id;
    h.services.tasks.create({ projectId: project.id, title: "Payment form", epicId });
  });
  afterEach(async () => {
    await agent.close();
    h.db.close();
  });

  it("gives an epic its orchestrate prompt and a task the prompt for its state", async () => {
    const epic = await call(agent, "get_handoff_prompt", { task: "#1" });
    expect(epic.isError).toBe(false);
    expect(epic.text).toContain("Orchestrate prompt for #1. Pass it on as it is:");
    expect(epic.text).toContain(`epic_overview("${epicId}")`);
    // No built web app in tests, so the link points at the Vite dev server.
    expect(epic.text).toContain(`Board: http://127.0.0.1:5317/?task=${epicId}`);

    expect((await call(agent, "get_handoff_prompt", { task: "#2" })).text).toContain(`Let's work on #2 "Address form"`);
    expect((await call(agent, "get_handoff_prompt", { task: "#3" })).text).toContain(`Let's plan #3 "Payment form"`);
  });

  it("gives a subagent its own prompt, with the suggested model addressed to the orchestrator", async () => {
    h.services.settings.update({
      modelTiers: {
        light: { description: "Haiku", t3: null },
        standard: { description: null, t3: null },
        deep: { description: null, t3: null },
      },
    });
    h.services.tasks.update(taskId, { suggestedModel: { tier: "light", reason: "Small form" } }, "user");
    const result = await call(agent, "get_handoff_prompt", { task: "#2", subagent: true });
    expect(result.text).toContain("Work prompt for #2, for a subagent.");
    expect(result.text).toContain("You are a subagent");
    expect(result.text).toMatch(
      /---\n\nSuggested model: light \(Haiku\): Small form\. Start the subagent on that model if you can choose one\.$/,
    );
  });

  it("refuses modes that don't fit the task", async () => {
    const epicWork = await call(agent, "get_handoff_prompt", { task: "#1", mode: "work" });
    expect(epicWork.isError).toBe(true);
    expect(epicWork.text).toContain('#1 is an epic: its prompt is mode "orchestrate"');
    expect((await call(agent, "get_handoff_prompt", { task: "#2", mode: "orchestrate" })).text).toContain(
      "#2 isn't an epic",
    );
    expect((await call(agent, "get_handoff_prompt", { task: "#3", mode: "plan", subagent: true })).text).toContain(
      "Only work prompts go to subagents",
    );
  });

  it("start_review hands back the open round a subagent stopped at, without opening another", async () => {
    h.services.settings.update({ autoReview: true });
    h.services.tasks.move(taskId, { status: "in_progress" }, "subagent");
    const subagent = await connect(h, "subagent");
    const moved = await call(subagent, "move_task", { task: "#2", status: "review" });
    expect(moved.text).toContain("round 1 is open");

    const brief = await call(agent, "start_review", { task: "#2" });
    expect(brief.text).toContain("Round 1 is open on #2.");
    expect(brief.text).toContain("Reviewer brief:");
    expect(brief.text).toContain(`submit_review(task: "#2", round: 1`);
    expect(h.services.reviews.list(taskId).map((r) => r.round)).toEqual([1]);
    await subagent.close();
  });
});
