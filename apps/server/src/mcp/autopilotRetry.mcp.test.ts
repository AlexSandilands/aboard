import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AUTOPILOT_START_PLANNED, startPlanned } from "../autopilot/automations/startPlanned.ts";
import { createTestHarness } from "../test/harness.ts";

type Harness = ReturnType<typeof createTestHarness>;

async function connect(h: Harness) {
  const client = new Client({ name: "orchestrator", version: "1.0.0" });
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

describe("retrying an Autopilot run", () => {
  let h: Harness;
  let agent: Client;
  let taskId: string;

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await agent.callTool({ name, arguments: args })) as CallToolResult;
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    return { text, isError: result.isError === true };
  };

  /** A run of an automation on the task that ended as given. */
  const endedRun = (automation: string, key: string, status: "failed" | "skipped" | "succeeded") => {
    const s = h.services;
    const run = s.autopilot.record({
      automation,
      candidate: { dedupeKey: key, summary: `do ${key}`, taskId, projectId: null },
      dryRun: false,
    })!;
    s.autopilot.start(run.id);
    return s.autopilot.finish(run.id, {
      status,
      ...(status === "failed" ? { error: "the board restarted", needsAttention: true } : {}),
    });
  };

  beforeEach(async () => {
    h = createTestHarness({ integrations: { automations: [startPlanned] } });
    agent = await connect(h);
    const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
    taskId = h.services.tasks.create({ projectId: project.id, title: "Thing" }).id;
  });
  afterEach(async () => {
    await agent.close();
    h.db.close();
  });

  it("retries the task's newest failed or skipped run, by automation when asked", async () => {
    expect((await call("retry_autopilot_run", { task: "#1" })).text).toContain("no failed or skipped Autopilot run");

    endedRun(AUTOPILOT_START_PLANNED, "start:c", "succeeded");
    const older = endedRun(AUTOPILOT_START_PLANNED, "start:a", "failed");
    expect(h.services.tasks.summary(taskId).attention.map((a) => a.kind)).toContain("autopilot");
    endedRun("custom:x", "other:b", "skipped");

    const byTitle = await call("retry_autopilot_run", { task: "#1", automation: "Start planned tasks" });
    expect(byTitle.isError).toBe(false);
    expect(byTitle.text).toContain("Asked Start planned tasks to try again (do start:a)");
    const runs = h.services.autopilot.runsForTask(taskId);
    expect(runs.find((r) => r.id === older.id)).toMatchObject({
      dedupeKey: `retried:${older.id}:start:a`,
      needsAttention: false,
      status: "failed",
    });

    // The newest retryable one is the skipped custom run; after that nothing is left.
    expect((await call("retry_autopilot_run", { task: "#1" })).text).toContain("try again (do other:b)");
    expect((await call("retry_autopilot_run", { task: "#1", automation: AUTOPILOT_START_PLANNED })).text).toContain(
      `no failed or skipped ${AUTOPILOT_START_PLANNED} Autopilot run`,
    );
  });

  it("leaves a failed run alone once the same automation has run again since", async () => {
    endedRun(AUTOPILOT_START_PLANNED, "start:a", "failed");
    endedRun(AUTOPILOT_START_PLANNED, "start:b", "succeeded");
    const refused = await call("retry_autopilot_run", { task: "#1" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("no failed or skipped Autopilot run");
  });

  it("retries over REST, once, and never a dry run", async () => {
    const failed = endedRun(AUTOPILOT_START_PLANNED, "start:a", "failed");
    const first = await h.request(`/api/autopilot/runs/${failed.id}/retry`, { method: "POST" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ dedupeKey: `retried:${failed.id}:start:a` });
    expect((await h.request(`/api/autopilot/runs/${failed.id}/retry`, { method: "POST" })).status).toBe(409);

    const dry = h.services.autopilot.record({
      automation: AUTOPILOT_START_PLANNED,
      candidate: { dedupeKey: "start:dry", summary: "start", taskId },
      dryRun: true,
    })!;
    expect((await h.request(`/api/autopilot/runs/${dry.id}/retry`, { method: "POST" })).status).toBe(400);
    expect((await h.request("/api/autopilot/runs/nope/retry", { method: "POST" })).status).toBe(404);
  });
});
