import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TaskLink } from "@repo/contracts";
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

const ENV = "env-1";
const plan = { phases: [{ title: "Build", steps: [{ title: "Do it" }] }] };

describe("T3 threads for an epic's tasks over MCP", () => {
  let h: Harness;
  let agent: Client;
  let taskId: string;

  /** Makes T3 look running and set up, recording launches and messages instead of opening a socket. */
  function fakeT3() {
    const launches: Array<{ taskId: string; input: unknown; actor: string }> = [];
    const messages: Array<{ threadId: string; text: string }> = [];
    h.services.settings.update({ t3Token: "tok" });
    h.integrations.t3Status = () => ({
      detected: true,
      origin: "http://127.0.0.1:3773",
      environmentId: ENV,
      label: null,
      liveStatus: "ok",
      error: null,
    });
    h.integrations.launchT3TaskThread = (id, input, actor) => {
      launches.push({ taskId: id, input, actor });
      return Promise.resolve(
        h.services.links.add(id, { t3Thread: { environmentId: ENV, threadId: `th-${launches.length}` } }, actor),
      );
    };
    h.integrations.messageT3Thread = (link, text) => {
      messages.push({ threadId: link.ref.threadId, text });
      return Promise.resolve();
    };
    return { launches, messages };
  }

  function linkThread(status: "working" | "done", threadId = "th-busy"): TaskLink {
    const link = h.services.links.add(taskId, { t3Thread: { environmentId: ENV, threadId } }, "user");
    h.services.links.setSnapshot(link.id, { title: "#2 Address form", status, settled: false, archived: false });
    return link;
  }

  beforeEach(async () => {
    h = createTestHarness();
    agent = await connect(h);
    const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
    const epic = h.services.tasks.create({ projectId: project.id, title: "Checkout", kind: "epic" });
    taskId = h.services.tasks.create({ projectId: project.id, title: "Address form", epicId: epic.id, plan }).id;
  });
  afterEach(async () => {
    await agent.close();
    h.db.close();
  });

  it("starts a task in a new thread with its linked-thread work prompt", async () => {
    const { launches } = fakeT3();
    expect((await call(agent, "epic_overview", { task: "#1" })).text).toContain("T3 Code: available.");

    const started = await call(agent, "start_task_thread", {
      task: "#2",
      baseRef: "feat/base",
      startFromOrigin: false,
    });
    expect(started.isError).toBe(false);
    expect(started.text).toContain("Started #2 in a new T3 Code thread (work prompt) and linked it");
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      taskId,
      actor: "agent",
      input: { work: true, baseRef: "feat/base", startFromOrigin: false },
    });
    const prompt = (launches[0]!.input as { prompt: string }).prompt;
    expect(prompt).toContain(`Let's work on #2 "Address form"`);
    expect(prompt).toContain("This thread is already linked to the task");
  });

  it("refuses a task with a thread still on it, but not one whose thread is done", async () => {
    linkThread("working");
    const busy = await call(agent, "start_task_thread", { task: "#2" });
    expect(busy.isError).toBe(true);
    expect(busy.text).toContain("CONFLICT: #2 already has a T3 thread on it: #2 Address form (working)");
    expect(busy.text).toContain('message_task_thread("#2", ...)');

    h.services.links.setSnapshot(h.services.tasks.summary(taskId).links[0]!.id, {
      title: "#2 Address form",
      status: "done",
      settled: false,
      archived: false,
    });
    const { launches } = fakeT3();
    expect((await call(agent, "start_task_thread", { task: "#2" })).isError).toBe(false);
    expect(launches).toHaveLength(1);
  });

  it("points at subagents and pasted prompts when T3 Code can't take the task", async () => {
    const overview = await call(agent, "epic_overview", { task: "#1" });
    expect(overview.text).toContain("T3 Code: not available (T3 Code isn't running)");
    const refused = await call(agent, "start_task_thread", { task: "#2" });
    expect(refused.text).toContain("VALIDATION: T3 Code isn't running.");
    expect(refused.text).toContain('get_handoff_prompt("#2", subagent: true)');
    expect((await call(agent, "start_task_thread", { task: "#1", mode: "work" })).text).toContain("is an epic");
  });

  it("messages the task's newest thread, or says to leave a note when it has none", async () => {
    const { messages } = fakeT3();
    const none = await call(agent, "message_task_thread", { task: "#2", text: "Use the v2 API" });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("has no T3 thread linked. Leave the session an add_note");

    linkThread("done", "th-old");
    linkThread("working", "th-new");
    const sent = await call(agent, "message_task_thread", { task: "#2", text: "Use the v2 API" });
    expect(sent.text).toContain("Sent to #2's thread");
    expect(messages).toEqual([{ threadId: "th-new", text: "Use the v2 API" }]);
  });
});
