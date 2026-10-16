import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AUTOPILOT_START_PLANNED, startPlanned } from "../autopilot/automations/startPlanned.ts";
import { createTestHarness } from "../test/harness.ts";

type Harness = ReturnType<typeof createTestHarness>;

async function connect(h: Harness) {
  const client = new Client({ name: "planner", version: "1.0.0" });
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

const HINT = "Autopilot flag not set:";
const markdown = "## Build\n- [ ] route";
const workspacePath = "C:/Fake/proj";

describe("the Autopilot flag over MCP", () => {
  let h: Harness;
  let agent: Client;

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await agent.callTool({ name, arguments: args })) as CallToolResult;
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(result.isError ? text : null).toBeNull();
    return text;
  };

  beforeEach(async () => {
    h = createTestHarness({ integrations: { automations: [startPlanned] } });
    agent = await connect(h);
  });
  afterEach(async () => {
    await agent.close();
    h.db.close();
  });

  it("sets, shows and resets the flag on create_task, add_to_backlog and update_task", async () => {
    const created = await call("create_task", { title: "Flagged", workspacePath, markdown, autopilot: "on" });
    expect(created).toContain("Autopilot: flagged on");
    expect(h.services.tasks.summary(h.services.tasks.resolveId("#1")).autopilot).toBe(true);

    await call("add_to_backlog", { title: "Off", workspacePath, autopilot: "off" });
    expect(h.services.tasks.summary(h.services.tasks.resolveId("#2")).autopilot).toBe(false);
    await call("add_to_backlog", { title: "Unset", workspacePath });
    expect(h.services.tasks.summary(h.services.tasks.resolveId("#3")).autopilot).toBeNull();

    expect(await call("update_task", { task: "#3", autopilot: "on" })).toContain("Autopilot: flagged on");
    expect(await call("update_task", { task: "#3", autopilot: "default" })).not.toContain("Autopilot:");
    expect(h.services.tasks.summary(h.services.tasks.resolveId("#3")).autopilot).toBeNull();

    const rejected = (await agent.callTool({
      name: "update_task",
      arguments: { task: "#3", autopilot: "maybe" },
    })) as CallToolResult;
    expect(rejected.isError).toBe(true);
  });

  it("asks whether to flag a planned task only while Start planned tasks is on for its project", async () => {
    // Nothing is switched on yet.
    expect(await call("create_task", { title: "Quiet", workspacePath, markdown })).not.toContain(HINT);

    h.services.autopilot.setScope("board", null, AUTOPILOT_START_PLANNED, { mode: "on" });
    const created = await call("create_task", { title: "Asked", workspacePath, markdown });
    expect(created).toContain(HINT);
    expect(created).toContain("Ask the user whether to flag this one");
    expect(created).toContain('update_task(task: "#2", autopilot: "on" | "off")');

    await call("add_to_backlog", { title: "Bare", workspacePath });
    expect(await call("set_plan", { task: "#3", markdown })).toContain(HINT);

    // Only the planning moments carry it, and not once the user has decided either way.
    expect(await call("get_task", { task: "#2" })).not.toContain(HINT);
    expect(await call("update_task", { task: "#2", autopilot: "off" })).not.toContain(HINT);
    expect(await call("set_plan", { task: "#2", markdown })).not.toContain(HINT);
    expect(await call("create_task", { title: "Decided", workspacePath, markdown, autopilot: "on" })).not.toContain(
      HINT,
    );

    // A project that switches it off isn't asked about.
    const project = h.services.projects.resolve({ workspacePath }, { autoCreate: false });
    h.services.autopilot.setScope("project", project.id, AUTOPILOT_START_PLANNED, { mode: "off" });
    expect(await call("create_task", { title: "Off here", workspacePath, markdown })).not.toContain(HINT);
  });

  it("does not offer the flag to epics, closed or started tasks", async () => {
    h.services.autopilot.setScope("board", null, AUTOPILOT_START_PLANNED, { mode: "on" });
    await call("create_task", { title: "Started", workspacePath, markdown });
    await call("move_task", { task: "#1", status: "in_progress" });
    expect(await call("set_plan", { task: "#1", markdown })).not.toContain(HINT);

    const epic = await call("create_epic", { title: "Big", workspacePath });
    expect(epic).not.toContain(HINT);
  });

  it("gives agents no way to change Autopilot's own settings", async () => {
    const { tools } = await agent.listTools();
    expect(tools.filter((t) => /autopilot|pause|resume/i.test(t.name))).toEqual([]);
    const instructions = agent.getInstructions() ?? "";
    expect(instructions).toContain("Autopilot's own settings are the user's alone");
  });
});
