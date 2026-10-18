import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AUTOPILOT_START_PLANNED, startPlanned } from "../autopilot/automations/startPlanned.ts";
import { createTestHarness } from "../test/harness.ts";

type Harness = ReturnType<typeof createTestHarness>;

async function connect(h: Harness) {
  const client = new Client({ name: "claude-code", version: "1.0.0" });
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

const workspacePath = "C:/Fake/proj";

describe("manual tasks over MCP", () => {
  let h: Harness;
  let agent: Client;

  const raw = async (name: string, args: Record<string, unknown>) => {
    const result = (await agent.callTool({ name, arguments: args })) as CallToolResult;
    return { text: result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"), error: !!result.isError };
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const { text, error } = await raw(name, args);
    expect(error ? text : null).toBeNull();
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

  it("creates one with add_to_backlog and create_task (no plan needed), and turns one on and off with update_task", async () => {
    await call("add_to_backlog", { title: "Ask for access", workspacePath, manual: true });
    expect(h.services.tasks.summary(h.services.tasks.resolveId("#1")).manual).toBe(true);

    const created = await call("create_task", { title: "Sign off", workspacePath, manual: true });
    expect(created).toContain("[Planned]");
    expect(created).toContain("Manual task: yes");

    await call("add_to_backlog", { title: "Code", workspacePath });
    expect(await call("update_task", { task: "#3", manual: true })).toContain("Manual task: yes");
    expect(await call("update_task", { task: "#3", manual: false })).not.toContain("Manual task");
  });

  it("tags it in list_tasks and leaves out the hints meant for an agent working on it", async () => {
    const project = h.services.projects.resolve({ workspacePath }, { autoCreate: true });
    h.services.autopilot.setScope("project", project.id, AUTOPILOT_START_PLANNED, { mode: "on" });
    await call("create_task", {
      title: "Sign off",
      workspacePath,
      manual: true,
      markdown: "## Do\n- [ ] Ask legal",
    });
    await call("move_task", { task: "#1", status: "in_progress" });

    expect(await call("list_tasks", { workspacePath })).toContain("#1 Sign off [manual]");
    const detail = await call("get_task", { task: "#1" });
    expect(detail).not.toContain("Missing links:");
    expect(detail).not.toContain("Plan progress:");
    expect(detail).not.toContain("Autopilot flag not set:");
  });

  it("refuses the hand-off prompt, a thread and a session link", async () => {
    await call("add_to_backlog", { title: "Ask for access", workspacePath, manual: true });
    for (const [tool, args] of [
      ["get_handoff_prompt", { task: "#1" }],
      ["start_task_thread", { task: "#1" }],
      ["link", { task: "#1", agentSession: { harness: "claude-code", sessionId: crypto.randomUUID(), cwd: "C:/x" } }],
    ] as const) {
      const { text, error } = await raw(tool, args);
      expect(error).toBe(true);
      expect(text).toContain("manual task");
    }
  });

  it("refuses the Autopilot flag", async () => {
    const { text, error } = await raw("add_to_backlog", { title: "M", workspacePath, manual: true, autopilot: "on" });
    expect(error).toBe(true);
    expect(text).toContain("manual task");
  });
});
