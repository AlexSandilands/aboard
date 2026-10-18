import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { T3ThreadSnapshot, TaskLink } from "@repo/contracts";
import { AppError } from "../errors.ts";
import type { TaskThreadInput } from "../integrations/t3.ts";
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

describe("T3 threads for a task over MCP", () => {
  let h: Harness;
  let agent: Client;
  let taskId: string;

  /**
   * Makes T3 look running, set up and allowed for agents. Launches and messages are recorded instead of opening a
   * socket; setting `state.fail` makes launches throw.
   */
  function fakeT3(opts: { allowed?: boolean } = {}) {
    const launches: Array<{ taskId: string; input: TaskThreadInput; actor: string }> = [];
    const messages: Array<{ threadId: string; text: string }> = [];
    const state: { fail: AppError | null } = { fail: null };
    h.services.settings.update({ t3Token: "tok", agentT3Threads: opts.allowed ?? true });
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
      if (state.fail) return Promise.reject(state.fail);
      const link = h.services.links.add(
        id,
        { t3Thread: { environmentId: ENV, threadId: `th-${launches.length}` } },
        actor,
      );
      return Promise.resolve({
        link,
        modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5", options: [] },
        runtimeMode: "full-access",
        workspace: { mode: "new_worktree", baseRef: input.baseRef ?? "main", startFromOrigin: false },
        suggestionUnavailable: null,
      });
    };
    h.integrations.messageT3Thread = (link, text) => {
      messages.push({ threadId: link.ref.threadId, text });
      return Promise.resolve();
    };
    return { launches, messages, state };
  }

  function linkThread(threadId: string, snapshot: Partial<T3ThreadSnapshot> | null): TaskLink {
    const link = h.services.links.add(taskId, { t3Thread: { environmentId: ENV, threadId } }, "user");
    if (snapshot) {
      h.services.links.setSnapshot(link.id, {
        title: "#2 Address form",
        status: "done",
        settled: false,
        archived: false,
        ...snapshot,
      });
    }
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

  it("starts a task in a new thread with its linked-thread work prompt, and says what it chose", async () => {
    const { launches } = fakeT3();
    expect((await call(agent, "epic_overview", { task: "#1" })).text).toContain("T3 Code: available.");

    const started = await call(agent, "start_task_thread", { task: "#2", baseRef: "feat/base" });
    expect(started.isError).toBe(false);
    expect(started.text).toContain("Started #2 in a new T3 Code thread (work prompt) and linked it");
    expect(started.text).toContain("Model claude-sonnet-5-5, access Full access, in a new worktree from feat/base.");
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ taskId, actor: "agent", input: { work: true, baseRef: "feat/base" } });
    expect(launches[0]!.input.commandId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(launches[0]!.input.prompt).toContain(`Let's work on #2 "Address form"`);
    expect(launches[0]!.input.prompt).toContain("This thread is already linked to the task");
  });

  it("keeps the commandId on a retry after T3 may have started the thread, and says not to start it elsewhere", async () => {
    const { launches, state } = fakeT3();
    state.fail = new AppError("VALIDATION", "T3 Code didn't answer in time.", { t3: "unreachable" });
    const lost = await call(agent, "start_task_thread", { task: "#2" });
    expect(lost.text).toContain("T3 Code didn't answer in time. T3 Code may have started the thread anyway.");
    expect(lost.text).not.toContain("subagent");

    state.fail = new AppError("VALIDATION", "No model is ready");
    const refused = await call(agent, "start_task_thread", { task: "#2" });
    expect(refused.text).toContain('Start it another way: a subagent with get_handoff_prompt("#2", subagent: true)');

    state.fail = null;
    await call(agent, "start_task_thread", { task: "#2" });
    expect(new Set(launches.map((l) => l.input.commandId)).size).toBe(1);
  });

  it("refuses a task with a thread still on it, or one just started, but not one that is settled", async () => {
    const { launches } = fakeT3();
    const busy = linkThread("th-busy", { status: "working" });
    const refused = await call(agent, "start_task_thread", { task: "#2" });
    expect(refused.text).toContain("CONFLICT: #2 already has a T3 thread on it: #2 Address form (working)");
    expect(refused.text).toContain('message_task_thread("#2", ...)');

    h.services.links.setSnapshot(busy.id, { title: "#2", status: "working", settled: true, archived: false });
    expect((await call(agent, "start_task_thread", { task: "#2" })).isError).toBe(false);
    // The thread just linked has no live status yet, so a second call is refused rather than starting another.
    expect((await call(agent, "start_task_thread", { task: "#2" })).text).toContain("just started");
    expect(launches).toHaveLength(1);
  });

  it("doesn't bring back an old thread's commandId after its link is removed", async () => {
    const { launches } = fakeT3();
    await call(agent, "start_task_thread", { task: "#2" });
    const link = h.services.tasks.summary(taskId).links.find((l) => l.kind === "t3_thread")!;
    h.services.links.remove(link.id, "user");
    await call(agent, "start_task_thread", { task: "#2" });
    expect(launches).toHaveLength(2);
    expect(launches[1]!.input.commandId).not.toBe(launches[0]!.input.commandId);
  });

  it("works on a task outside an epic too", async () => {
    const { launches, messages } = fakeT3();
    const loose = h.services.tasks.create({
      projectId: h.services.tasks.summary(taskId).projectId,
      title: "Loose",
      plan,
    });
    const started = await call(agent, "start_task_thread", { task: `#${loose.number}` });
    expect(started.isError).toBe(false);
    expect(started.text).toContain(
      `Follow it with get_task, or message it with message_task_thread("#${loose.number}"`,
    );
    expect(launches).toHaveLength(1);
    expect(launches[0]!.taskId).toBe(loose.id);
    const sent = await call(agent, "message_task_thread", { task: `#${loose.number}`, text: "hi" });
    expect(sent.isError).toBe(false);
    expect(messages).toHaveLength(1);
  });

  it("refuses to start a task whose blockers aren't Done", async () => {
    const { launches } = fakeT3();
    const blocked = h.services.tasks.create({
      projectId: h.services.tasks.summary(taskId).projectId,
      title: "Waits",
      plan,
      blockedBy: [taskId],
    });
    const refused = await call(agent, "start_task_thread", { task: `#${blocked.number}` });
    expect(refused.text).toContain(`#${blocked.number} is blocked by #${h.services.tasks.summary(taskId).number}`);
    expect(launches).toEqual([]);
  });

  it("takes only a branch name as baseRef", async () => {
    const { launches } = fakeT3();
    for (const baseRef of ["--upload-pack=x", "main..evil", "a b", "feat/x.lock"]) {
      expect((await call(agent, "start_task_thread", { task: "#2", baseRef })).isError).toBe(true);
    }
    expect(launches).toEqual([]);
    expect((await call(agent, "start_task_thread", { task: "#2", baseRef: "t3/feat-x_1.2" })).isError).toBe(false);
  });

  it("refuses modes that don't fit the task", async () => {
    fakeT3();
    expect((await call(agent, "start_task_thread", { task: "#1", mode: "work" })).text).toContain("is an epic");
    expect((await call(agent, "start_task_thread", { task: "#2", mode: "orchestrate" })).text).toContain(
      "isn't an epic",
    );
  });

  it("points at subagents and pasted prompts when T3 can't take the task or agents may not start threads", async () => {
    const overview = await call(agent, "epic_overview", { task: "#1" });
    expect(overview.text).toContain("T3 Code: not available (T3 Code isn't running)");
    const refused = await call(agent, "start_task_thread", { task: "#2" });
    expect(refused.text).toContain("VALIDATION: T3 Code isn't running.");
    expect(refused.text).toContain('get_handoff_prompt("#2", subagent: true)');

    const { launches, messages } = fakeT3({ allowed: false });
    expect((await call(agent, "epic_overview", { task: "#1" })).text).toContain(
      "The user hasn't let agents start T3 threads",
    );
    expect((await call(agent, "start_task_thread", { task: "#2" })).isError).toBe(true);
    linkThread("th-1", { status: "working" });
    expect((await call(agent, "message_task_thread", { task: "#2", text: "hi" })).text).toContain("add_note");
    expect(launches).toEqual([]);
    expect(messages).toEqual([]);
  });

  it("messages the thread busy on the task, else its newest, marked as from the orchestrator", async () => {
    const { messages } = fakeT3();
    const none = await call(agent, "message_task_thread", { task: "#2", text: "Use the v2 API" });
    expect(none.text).toContain("has no T3 thread linked. Leave the session an add_note");

    linkThread("th-busy", { status: "input" });
    linkThread("th-done", { status: "done" });
    await call(agent, "message_task_thread", { task: "#2", text: "Use the v2 API" });
    expect(messages).toEqual([
      {
        threadId: "th-busy",
        text: "From an orchestrating agent (sent through the board):\n\nUse the v2 API",
      },
    ]);
  });
});
