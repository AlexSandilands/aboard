import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTestHarness } from "../test/harness.ts";

type Harness = ReturnType<typeof createTestHarness>;

/** Connects an SDK client to the Hono app in-process: the transport's fetch goes to app.request. */
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

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as CallToolResult).content;
  return content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

describe("MCP endpoint", () => {
  let h: Harness;
  let client: Client;

  beforeEach(async () => {
    h = createTestHarness();
    client = await connect(h);
  });
  afterEach(async () => {
    await client.close();
    h.db.close();
  });

  it("lists the agent tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of [
      "board_overview",
      "list_projects",
      "list_tasks",
      "get_task",
      "create_idea",
      "create_task",
      "set_plan",
      "add_steps",
      "update_step",
      "move_task",
      "close_task",
      "update_task",
      "delete_task",
      "add_note",
      "link",
    ]) {
      expect(names).toContain(name);
    }
    // An outputSchema makes structuredContent mandatory, which Claude Code would show instead of the text.
    expect(tools.filter((t) => t.outputSchema).map((t) => t.name)).toEqual([]);
    expect(client.getInstructions()).toContain("get_task");
  });

  it("rejects GET with 405 (stateless)", async () => {
    const res = await h.request("/mcp", { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("drives an idea through plan, progress, links and notes", async () => {
    const workspacePath = "C:\\Fake\\proj";

    const created = await client.callTool({
      name: "create_idea",
      arguments: { title: "Add dark mode", description: "Users asked for it", workspacePath },
    });
    expect(created.isError).toBeFalsy();
    expect(text(created)).toMatch(/#\d+/);
    const number = Number(/#(\d+)/.exec(text(created))?.[1]);
    const task = `#${number}`;

    const gated = await client.callTool({ name: "move_task", arguments: { task, status: "planned" } });
    expect(gated.isError).toBe(true);
    expect(text(gated)).toContain("PLAN_REQUIRED");
    expect(text(gated)).toContain("set_plan");

    const planned = await client.callTool({
      name: "set_plan",
      arguments: {
        task,
        markdown: "## Build\n- [ ] Add theme tokens\n- [ ] Wire toggle\n\n## Verify\n- [ ] Test in both themes\n",
        context: "Use CSS variables.",
      },
    });
    expect(planned.isError).toBeFalsy();
    expect(text(planned)).toContain("1.1 [ ] Add theme tokens");

    const moved = await client.callTool({ name: "move_task", arguments: { task, status: "in_progress" } });
    expect(moved.isError).toBeFalsy();
    expect(text(moved)).toContain("In Progress");

    const stepped = await client.callTool({ name: "update_step", arguments: { task, step: "1.1", status: "done" } });
    expect(stepped.isError).toBeFalsy();

    const linked = await client.callTool({
      name: "link",
      arguments: { task, value: "https://github.com/acme/app/pull/12" },
    });
    expect(linked.isError).toBeFalsy();
    expect(text(linked)).toContain("acme/app#12");

    const noted = await client.callTool({
      name: "add_note",
      arguments: { task, text: "Handover: toggle wiring next.", actor: "claude-code" },
    });
    expect(noted.isError).toBeFalsy();

    const detail = text(await client.callTool({ name: "get_task", arguments: { task } }));
    expect(detail).toContain("Add dark mode");
    expect(detail).toContain("1.1 [x] Add theme tokens");
    expect(detail).toContain("Use CSS variables.");
    expect(detail).toContain("acme/app#12");
    expect(detail).toContain("claude-code: note: Handover: toggle wiring next.");
    expect(detail).toContain('step "Add theme tokens" todo -> done');

    const listed = text(await client.callTool({ name: "list_tasks", arguments: { workspacePath } }));
    expect(listed).toContain(`#${number} Add dark mode`);

    const overview = text(await client.callTool({ name: "board_overview", arguments: { workspacePath } }));
    expect(overview).toContain("In Progress 1");
  });

  it("puts the full detail in the text and sends no structuredContent", async () => {
    // Clients such as Claude Code show structuredContent instead of the text when both are present.
    const workspacePath = "C:\\Fake\\proj";
    const project = h.services.projects.create({ workspaceRoot: workspacePath });
    const task = h.services.tasks.create({ projectId: project.id, title: "Ship search", description: "Index titles" });
    const getTask = { name: "get_task", arguments: { task: `#${task.number}` } };

    const calls = [
      { name: "set_plan", arguments: { task: `#${task.number}`, markdown: "## Build\n- [ ] Add FTS table" } },
      getTask,
      { name: "list_tasks", arguments: { workspacePath } },
      { name: "board_overview", arguments: { workspacePath } },
      { name: "add_note", arguments: { task: `#${task.number}`, text: "Handover" } },
      { name: "link", arguments: { task: `#${task.number}`, value: "https://example.com" } },
      { name: "move_task", arguments: { task: `#${task.number}`, status: "in_progress" } },
      { name: "create_idea", arguments: { title: "Later", workspacePath } },
    ];
    for (const call of calls) {
      const result = await client.callTool(call);
      expect({ tool: call.name, isError: result.isError }).toEqual({ tool: call.name, isError: undefined });
      expect({ tool: call.name, structured: result.structuredContent }).toEqual({
        tool: call.name,
        structured: undefined,
      });
    }

    const detail = text(await client.callTool(getTask));
    expect(detail).toContain("Ship search");
    expect(detail).toContain("Index titles");
    expect(detail).toContain("1.1 [ ] Add FTS table");
  });

  it("update_task only moves projects through the explicit moveTo params", async () => {
    const home = h.services.projects.create({ workspaceRoot: "C:/Fake/home" });
    const other = h.services.projects.create({ workspaceRoot: "C:/Fake/other" });
    const task = h.services.tasks.create({ projectId: home.id, title: "Stay put" });

    // Agents habitually pass workspacePath; it must not move the task.
    const edited = await client.callTool({
      name: "update_task",
      arguments: { task: task.id, title: "Renamed", workspacePath: "C:/Fake/other" },
    });
    expect(edited.isError).toBeFalsy();
    expect(h.services.tasks.summary(task.id)).toMatchObject({ title: "Renamed", projectId: home.id });

    const unknown = await client.callTool({
      name: "update_task",
      arguments: { task: task.id, moveToWorkspacePath: "C:/Fake/nowhere" },
    });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/^NOT_FOUND: /);
    expect(h.services.projects.list()).toHaveLength(2);

    const moved = await client.callTool({
      name: "update_task",
      arguments: { task: task.id, moveToWorkspacePath: "C:/Fake/other/src" },
    });
    expect(moved.isError).toBeFalsy();
    expect(h.services.tasks.summary(task.id).projectId).toBe(other.id);
  });

  it("delete_task requires the task to be archived first", async () => {
    const project = h.services.projects.create({ workspaceRoot: "C:/Fake/proj" });
    const task = h.services.tasks.create({ projectId: project.id, title: "Scrap me" });
    const ref = `#${task.number}`;

    const refused = await client.callTool({ name: "delete_task", arguments: { task: ref } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/^VALIDATION: Archive #\d+ before deleting it/);

    await client.callTool({ name: "update_task", arguments: { task: ref, archived: true } });
    const deleted = await client.callTool({ name: "delete_task", arguments: { task: ref } });
    expect(deleted.isError).toBeFalsy();
    expect(text(deleted)).toBe(`Deleted ${ref} "Scrap me" permanently.`);
    expect(text(await client.callTool({ name: "get_task", arguments: { task: ref } }))).toMatch(/^NOT_FOUND: /);
  });

  it("treats an unknown workspace as empty for read-only tools", async () => {
    const result = await client.callTool({ name: "list_tasks", arguments: { workspacePath: "C:\\Nowhere" } });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("No tasks yet");
  });

  it("returns readable errors for unknown tasks", async () => {
    const result = await client.callTool({ name: "get_task", arguments: { task: "#999" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^NOT_FOUND: /);
  });

  it("closes a task as done by another and shows it on both tasks", async () => {
    const workspacePath = "C:/Fake/proj";
    const project = h.services.projects.create({ workspaceRoot: workspacePath });
    const shipped = h.services.tasks.create({ projectId: project.id, title: "Ship search" });
    const idea = h.services.tasks.create({ projectId: project.id, title: "Search titles" });

    const gated = await client.callTool({ name: "move_task", arguments: { task: `#${idea.number}`, status: "done" } });
    expect(text(gated)).toContain("close_task");

    const missing = await client.callTool({
      name: "close_task",
      arguments: { task: `#${idea.number}`, resolution: "completed" },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^VALIDATION: byTask/);

    const closed = await client.callTool({
      name: "close_task",
      arguments: { task: `#${idea.number}`, resolution: "completed", byTask: `#${shipped.number}` },
    });
    expect(closed.isError).toBeFalsy();
    expect(text(closed)).toContain(`Closed #${idea.number} as done by #${shipped.number}.`);
    expect(text(closed)).toContain(`Closed: done by #${shipped.number} "Ship search"`);

    const delivering = text(await client.callTool({ name: "get_task", arguments: { task: `#${shipped.number}` } }));
    expect(delivering).toContain(`Also resolved: #${idea.number} Search titles (done by this)`);

    const listed = text(await client.callTool({ name: "list_tasks", arguments: { workspacePath, status: "done" } }));
    expect(listed).toContain(`#${idea.number} Search titles — done by #${shipped.number}`);
  });

  it("lists missing Jira and T3 thread links until they are added, and never on done tasks", async () => {
    const workspacePath = "C:/Fake/proj";
    const project = h.services.projects.create({ workspaceRoot: workspacePath });
    const task = h.services.tasks.create({
      projectId: project.id,
      title: "CORE-1245 Fix login",
      description: "Follows CORE-1200. Uses UTF-8.",
    });
    const ref = `#${task.number}`;
    const getTask = async () => text(await client.callTool({ name: "get_task", arguments: { task: ref } }));

    let detail = await getTask();
    expect(detail).toContain("Missing links:");
    expect(detail).toContain(`Jira CORE-1200: link(task: "${ref}", value: "CORE-1200")`);
    expect(detail).not.toContain("Jira CORE-1245:");
    expect(detail).not.toContain("UTF-8:");
    expect(detail).toContain(`link(task: "${ref}", t3Thread: {environmentId, threadId})`);

    await client.callTool({ name: "link", arguments: { task: ref, value: "CORE-1200" } });
    const linked = await client.callTool({
      name: "link",
      arguments: { task: ref, t3Thread: { environmentId: "env-1", threadId: "thread-1" } },
    });
    expect(linked.isError).toBeFalsy();
    detail = await getTask();
    expect(detail).not.toContain("Missing links:");

    const other = h.services.tasks.create({ projectId: project.id, title: "Old", description: "OPS-1" });
    const closed = await client.callTool({
      name: "close_task",
      arguments: { task: `#${other.number}`, resolution: "wont_do" },
    });
    expect(text(closed)).not.toContain("Missing links:");
  });

  it("create_idea attaches links and the T3 thread", async () => {
    const created = await client.callTool({
      name: "create_idea",
      arguments: {
        title: "Retry flaky upload",
        workspacePath: "C:/Fake/proj",
        links: ["PAY-12", "https://example.com/spec"],
        t3Thread: { environmentId: "env-1", threadId: "thread-1" },
      },
    });
    expect(created.isError).toBeFalsy();
    const number = Number(/#(\d+)/.exec(text(created))?.[1]);
    const links = h.services.tasks.detail(h.services.tasks.resolveId(`#${number}`)).links.map((l) => l.kind);
    expect(links.sort()).toEqual(["jira", "t3_thread", "url"]);
  });

  it("move_task says when a task with merged PRs went on to Done", async () => {
    const s = h.services;
    const project = s.projects.create({ workspaceRoot: "C:/Fake/proj" });
    const task = s.tasks.create({
      projectId: project.id,
      title: "Ship it",
      plan: { phases: [{ title: "Build", steps: [{ title: "a" }] }] },
      links: [{ value: "https://github.com/acme/app/pull/7" }],
    });
    const [pr] = s.links.listByKind("pr");
    s.links.setSnapshot(pr!.id, {
      state: "merged",
      title: "Change",
      checks: "passing",
      reviewDecision: null,
      mergeable: "mergeable",
      headRef: "feat/x",
      updatedAt: "2026-10-01T10:00:00Z",
    });

    const moved = await client.callTool({
      name: "move_task",
      arguments: { task: `#${task.number}`, status: "review" },
    });

    expect(moved.isError).toBeFalsy();
    expect(text(moved)).toContain(
      `Moved #${task.number} to Review; its PRs are already merged, so it went on to Done.`,
    );
    expect(s.tasks.summary(task.id).status).toBe("done");
  });

  it("tags tasks with labels, filters and shows them", async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const body = text(result);
      expect(result.isError ? body : null).toBeNull();
      return body;
    };
    const workspacePath = "C:/Fake/proj";
    await call("create_idea", { title: "Polish header", workspacePath, labels: ["UI", "polish"] });
    await call("create_task", {
      title: "Add endpoint",
      workspacePath,
      markdown: "## Build\n- [ ] route",
      labels: ["backend"],
    });
    await call("create_idea", { title: "Write docs", workspacePath });

    const listed = await call("list_tasks", { workspacePath, labels: ["ui", "Backend"] });
    expect(listed).toContain("Polish header [polish] [ui]");
    expect(listed).toContain("Add endpoint [backend]");
    expect(listed).not.toContain("Write docs");
    expect(await call("list_tasks", { query: "polish" })).toContain("Polish header");
    expect(await call("board_overview", {})).toContain("Labels in use: backend (1), polish (1), ui (1)");

    const updated = await call("update_task", { task: "#1", labels: ["ui", "design"] });
    expect(updated).toContain("Labels: design, ui");
    const detail = await call("get_task", { task: "#1" });
    expect(detail).toContain("labels +design -polish");

    const rejected = await client.callTool({ name: "update_task", arguments: { task: "#1", labels: ["#"] } });
    expect(rejected.isError).toBe(true);
    expect(text(rejected)).toMatch(/^VALIDATION: Label "#" is empty/);
  });
});
