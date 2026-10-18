import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTestHarness } from "../test/harness.ts";

type Harness = ReturnType<typeof createTestHarness>;

async function connect(h: Harness) {
  const client = new Client({ name: "improver", version: "1.0.0" });
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

async function call(client: Client, args: Record<string, unknown>) {
  const result = (await client.callTool({
    name: "board_activity",
    arguments: args,
  })) as CallToolResult;
  return {
    isError: result.isError === true,
    text: result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"),
  };
}

describe("board_activity over MCP", () => {
  let h: Harness;
  let agent: Client;

  beforeEach(async () => {
    h = createTestHarness();
    agent = await connect(h);
    const alpha = h.services.projects.create({
      title: "Alpha",
      workspaceRoot: "/work/alpha",
    });
    const beta = h.services.projects.create({
      title: "Beta",
      workspaceRoot: "/work/beta",
    });
    const plan = { phases: [{ title: "Build", steps: [{ title: "a" }] }] };
    for (const [project, title] of [
      [alpha, "Alpha task"],
      [beta, "Beta task"],
    ] as const) {
      const task = h.services.tasks.create({
        projectId: project.id,
        title,
        plan,
      });
      h.services.tasks.move(task.id, { status: "done" }, "agent");
    }
  });
  afterEach(async () => {
    await agent.close();
    h.db.close();
  });

  it("summarises the last few days, relative to now", async () => {
    const { text } = await call(agent, { since: "7d" });
    expect(text).toContain("all projects");
    expect(text).toContain("Tasks finished (2):");
    expect(text).toContain("Alpha task");
    expect(text).toContain("Beta task");
    expect(text).toContain("Drill into a task with get_task.");
  });

  it("limits to one project by workspacePath or projectId", async () => {
    const byPath = await call(agent, {
      since: "24h",
      workspacePath: "/work/alpha",
    });
    expect(byPath.text).toContain("·  Alpha");
    expect(byPath.text).toContain("Tasks finished (1):");
    expect(byPath.text).not.toContain("Beta task");

    const beta = h.services.projects.list().find((p) => p.title === "Beta")!;
    const byId = await call(agent, { since: "24h", projectId: beta.id });
    expect(byId.text).toContain("Beta task");
    expect(byId.text).not.toContain("Alpha task");
  });

  it("finds nothing before the work happened, and says so for an unknown project", async () => {
    const past = await call(agent, {
      since: "2020-01-01",
      until: "2020-01-02",
    });
    expect(past.text).toContain("Tasks finished (0):");
    const unknown = await call(agent, {
      since: "7d",
      workspacePath: "/work/none",
    });
    expect(unknown.text).toContain("no such project");
  });

  it("reads a date-time without an offset as UTC, with a T or a space", async () => {
    for (const since of ["2026-10-12T09:00", "2026-10-12 09:00"]) {
      const { text } = await call(agent, { since, until: "2026-10-13" });
      expect(text).toContain("Board activity 2026-10-12 09:00 to 2026-10-13 00:00 UTC");
    }
  });

  it("rejects a period it can't read or that runs backwards", async () => {
    const bad = await call(agent, { since: "last week" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('since must be an ISO date or time, or how long ago ("24h", "7d")');
    // Forms the date parser would read loosely: "7" as a year, a slashed date as local time.
    for (const loose of ["7", "2026/10/12"]) expect((await call(agent, { since: loose })).isError).toBe(true);
    const backwards = await call(agent, {
      since: "2026-10-02",
      until: "2026-10-01",
    });
    expect(backwards.isError).toBe(true);
    expect(backwards.text).toContain("since must be before until");
  });
});
