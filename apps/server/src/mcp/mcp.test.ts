import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ORCHESTRATE_BOARD_TOOLS, ORCHESTRATE_DENIED_BOARD_TOOLS } from "../autopilot/automations/orchestrate.ts";
import { TEST_JIRA } from "../test/fixtures.ts";
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

  it("places every tool on one side of Orchestrate's allow or deny list", async () => {
    const { tools } = await client.listTools();
    const placed = new Set<string>([...ORCHESTRATE_BOARD_TOOLS, ...ORCHESTRATE_DENIED_BOARD_TOOLS]);
    expect(tools.map((t) => t.name).filter((name) => !placed.has(name))).toEqual([]);
    expect(
      ORCHESTRATE_BOARD_TOOLS.filter((name) => (ORCHESTRATE_DENIED_BOARD_TOOLS as readonly string[]).includes(name)),
    ).toEqual([]);
  });

  it("lists the agent tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of [
      "board_overview",
      "board_activity",
      "list_projects",
      "list_tasks",
      "get_task",
      "add_to_backlog",
      "create_task",
      "set_plan",
      "update_plan",
      "add_steps",
      "update_step",
      "move_task",
      "close_task",
      "update_task",
      "delete_task",
      "add_note",
      "request_attention",
      "link",
      "merge_task_pr",
      "retry_autopilot_run",
    ]) {
      expect(names).toContain(name);
    }
    // Autopilot is REST only, so an agent can't switch it on or lift its limits (ADR 0008).
    expect(names.filter((n) => /autopilot|pause|resume/i.test(n))).toEqual(["retry_autopilot_run"]);
    // An outputSchema makes structuredContent mandatory, which Claude Code would show instead of the text.
    expect(tools.filter((t) => t.outputSchema).map((t) => t.name)).toEqual([]);
    expect(client.getInstructions()).toContain("get_task");
  });

  it("rejects GET with 405 (stateless)", async () => {
    const res = await h.request("/mcp", { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("drives a backlog task through plan, progress, links and notes", async () => {
    const workspacePath = "C:\\Fake\\proj";

    const created = await client.callTool({
      name: "add_to_backlog",
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

    const stepless = await client.callTool({
      name: "set_plan",
      arguments: { task, phases: [{ title: "Tests", steps: [] }] },
    });
    expect(stepless.isError).toBe(true);
    expect(text(stepless)).toContain("VALIDATION");
    expect(text(stepless)).toContain("at least one step");

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
    expect(detail).not.toContain("Images");
    expect(detail).toContain("acme/app#12");
    expect(detail).toContain("claude-code: note: Handover: toggle wiring next.");
    expect(detail).toContain('step "Add theme tokens" todo -> done');

    const listed = text(await client.callTool({ name: "list_tasks", arguments: { workspacePath } }));
    expect(listed).toContain(`#${number} Add dark mode`);

    const overview = text(await client.callTool({ name: "board_overview", arguments: { workspacePath } }));
    expect(overview).toContain("In Progress 1");
  });

  it("links a pasted T3 thread id as a thread and passes on the warning", async () => {
    const project = h.services.projects.create({ workspaceRoot: "C:\\Fake\\proj" });
    const task = h.services.tasks.create({ projectId: project.id, title: "Link a thread" });
    const threadId = "bca46358-2812-4417-93f7-e151c0f96292";
    vi.spyOn(h.integrations, "resolveLinkInput").mockResolvedValue({
      input: { t3Thread: { environmentId: "env-1", threadId } },
      warning: "Linked without checking the thread exists",
    });
    const linked = await client.callTool({ name: "link", arguments: { task: `#${task.number}`, value: threadId } });
    expect(linked.isError).toBeFalsy();
    expect(text(linked)).toContain("Warning: Linked without checking the thread exists");
    expect(h.services.tasks.detail(task.id).links).toMatchObject([{ kind: "t3_thread", ref: { threadId } }]);
  });

  it("get_task lists the task's pasted images with their absolute paths", async () => {
    const project = h.services.projects.create({ workspaceRoot: "C:\\Fake\\proj" });
    const task = h.services.tasks.create({ projectId: project.id, title: "Fix the layout" });
    const image = h.services.attachments.upload({
      taskId: task.id,
      filename: "bug.png",
      mime: "image/png",
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
    });
    const detail = text(await client.callTool({ name: "get_task", arguments: { task: `#${task.number}` } }));
    const [stored] = h.services.attachments.forTask(task.id);
    expect(stored!.id).toBe(image.id);
    expect(detail).toContain("Images");
    expect(detail).toContain(`- ${stored!.path} (bug.png, 7 B)`);
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
      { name: "add_to_backlog", arguments: { title: "Later", workspacePath } },
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

  describe("changing a plan that has progress", () => {
    const markdown = "## One\n- [x] a\n- [ ] b\n\n## Two\n- [ ] c\n- [ ] d\n";
    let task: string;

    beforeEach(() => {
      const project = h.services.projects.create({ workspaceRoot: "C:/Fake/proj" });
      const created = h.services.tasks.create({ projectId: project.id, title: "Big task" });
      task = `#${created.number}`;
    });

    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: { task, ...args } });
      return { error: result.isError === true, body: text(result) };
    };
    const planText = async () => (await call("get_task", {})).body.replace(/ {2}\(id: [^)]+\)/g, "");

    it("refuses a set_plan that would delete finished work and says how to update instead", async () => {
      expect((await call("set_plan", { markdown })).error).toBe(false);
      // The #25 mistake: only the phase being updated is passed, so phase One would be wiped.
      const refused = await call("set_plan", { markdown: "## Two\n- [x] c\n- [x] d\n" });
      expect(refused.error).toBe(true);
      expect(refused.body).toMatch(/^CONFLICT: /);
      expect(refused.body).toContain('1.1 "a" (done)');
      expect(refused.body).toContain("update_plan");
      expect(refused.body).toContain("allowDeletes: true");
      const after = await planText();
      expect(after).toContain("1.1 [x] a");
      expect(after).toContain("1.2 [ ] b");
      expect(after).toContain("2.1 [ ] c");
    });

    it("refuses a set_plan that passes only the current phase and would drop later phases", async () => {
      await call("set_plan", { markdown });
      const one = h.services.tasks.detail(h.services.tasks.resolveId(task)).phases[0]!;
      // Phase One passed back with its ids and both steps done: untouched todos in phase Two would be dropped.
      const onlyPhaseOne = {
        phases: [
          { id: one.id, title: "One", steps: one.steps.map((s) => ({ id: s.id, title: s.title, status: "done" })) },
        ],
      };
      const refused = await call("set_plan", onlyPhaseOne);
      expect(refused.error).toBe(true);
      expect(refused.body).toMatch(/^CONFLICT: /);
      expect(refused.body).toContain('2.1 "c" (all steps of its phase are dropped)');
      expect(await planText()).toContain("2.2 [ ] d");
      expect((await call("set_plan", { ...onlyPhaseOne, allowDeletes: true })).error).toBe(false);
    });

    it("lets set_plan delete started steps with allowDeletes and lists what went", async () => {
      await call("set_plan", { markdown });
      const result = await call("set_plan", { markdown: "## Two\n- [ ] c\n", allowDeletes: true });
      expect(result.error).toBe(false);
      expect(result.body).toContain("Deleted 4 step(s): 1.1 a, 1.2 b, 2.1 c, 2.2 d.");
      expect(await planText()).toContain("1.1 [ ] c");
      // The activity log keeps every deleted title, uncut, so the plan can be rebuilt.
      expect((await call("get_task", {})).body).toContain("deleted 4: 1.1 a, 1.2 b, 2.1 c, 2.2 d");
    });

    it("lets a first plan and a replace that only drops untouched steps through", async () => {
      const first = await call("set_plan", { markdown: "## One\n- [ ] a\n- [ ] b\n" });
      expect(first.error).toBe(false);
      expect(first.body).not.toContain("Deleted");
      // Nothing started, no notes: replacing is allowed, and the result still says what was dropped.
      const replaced = await call("set_plan", { markdown: "## One\n- [ ] x\n" });
      expect(replaced.error).toBe(false);
      expect(replaced.body).toContain("Deleted 2 step(s): 1.1 a, 1.2 b.");
    });

    it("update_plan marks several steps done, moves a step and renames a phase in one call", async () => {
      await call("set_plan", { markdown });
      const result = await call("update_plan", {
        steps: [
          { step: "1.2", status: "done", appendNotes: "merged" },
          { step: "2.1", status: "done" },
          { step: "2.2", move: { phase: "1" } },
        ],
        phases: [{ phase: "2", title: "Two renamed" }],
      });
      expect(result.error).toBe(false);
      expect(result.body).toContain("Updated 3 step(s) and 1 phase(s) in the plan.");
      const body = await planText();
      expect(body).toContain("Phase 1: One");
      expect(body).toContain("1.1 [x] a");
      expect(body).toContain("1.2 [x] b");
      expect(body).toContain("1.3 [ ] d");
      expect(body).toContain("Phase 2: Two renamed");
      expect(body).toContain("2.1 [x] c");
      expect(body).toContain("merged");
    });

    it("update_plan changes nothing when one reference is bad", async () => {
      await call("set_plan", { markdown });
      const before = await planText();
      const result = await call("update_plan", {
        steps: [
          { step: "1.2", status: "done" },
          { step: "7.7", status: "done" },
        ],
      });
      expect(result.error).toBe(true);
      expect(result.body).toMatch(/^NOT_FOUND: /);
      expect(await planText()).toBe(before);
      expect((await call("update_plan", {})).body).toMatch(/^VALIDATION: /);
    });
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

  it("update_task archives an epic with its Done tasks", async () => {
    const project = h.services.projects.create({ workspaceRoot: "C:/Fake/proj" });
    const epic = h.services.tasks.create({ projectId: project.id, title: "Epic", kind: "epic" });
    const task = h.services.tasks.create({
      projectId: project.id,
      title: "Part",
      epicId: epic.id,
      plan: { phases: [{ title: "Do", steps: [{ title: "it" }] }] },
    });
    h.services.tasks.move(task.id, { status: "done" }, "agent");

    const archived = await client.callTool({
      name: "update_task",
      arguments: { task: `#${epic.number}`, archived: true },
    });
    expect(archived.isError).toBeFalsy();
    expect(h.services.tasks.summary(task.id).archivedAt).not.toBeNull();
    expect(h.services.tasks.summary(epic.id).status).toBe("done");
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

  it("files work that belongs to no code project in General, only when asked", async () => {
    // Neither a path nor general: still refused, so repo work never lands in General by accident.
    const neither = await client.callTool({ name: "add_to_backlog", arguments: { title: "Stray" } });
    expect(neither.isError).toBe(true);
    expect(text(neither)).toMatch(/^VALIDATION: .*general: true/);
    const both = await client.callTool({
      name: "add_to_backlog",
      arguments: { title: "Both", general: true, workspacePath: "C:/Fake/proj" },
    });
    expect(both.isError).toBe(true);
    expect(h.services.projects.list()).toEqual([]);

    const added = await client.callTool({
      name: "add_to_backlog",
      arguments: { title: "Update the deck", general: true },
    });
    expect(added.isError).toBeFalsy();
    expect(text(added)).toContain("to Backlog in General");
    const general = h.services.projects.general();
    expect(general.workspaceRoot).toBeNull();
    expect(h.services.tasks.summaries({ projectId: general.id }).map((t) => t.title)).toEqual(["Update the deck"]);

    // An archived General comes back; a deleted one is made again, and create_task works the same way.
    h.services.projects.update(general.id, { archived: true });
    const planned = await client.callTool({
      name: "create_task",
      arguments: {
        title: "Review the proposal",
        general: true,
        markdown: "## Read\n- [ ] Read it\n- [ ] Reply",
      },
    });
    expect(planned.isError).toBeFalsy();
    expect(h.services.projects.get(general.id).archivedAt).toBeNull();
    h.services.projects.delete(general.id);
    const again = await client.callTool({ name: "add_to_backlog", arguments: { title: "Once more", general: true } });
    expect(again.isError).toBeFalsy();
    expect(h.services.projects.list().map((p) => p.title)).toEqual(["General"]);
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

  it("still reads the old idea status as backlog", async () => {
    const workspacePath = "C:/Fake/proj";
    const project = h.services.projects.create({ workspaceRoot: workspacePath });
    const task = h.services.tasks.create({
      projectId: project.id,
      title: "Old agent",
      plan: { phases: [{ title: "P", steps: [{ title: "s" }] }] },
    });

    const moved = await client.callTool({ name: "move_task", arguments: { task: `#${task.number}`, status: "idea" } });
    expect(moved.isError).toBeFalsy();
    expect(h.services.tasks.summary(task.id).status).toBe("backlog");

    const listed = text(await client.callTool({ name: "list_tasks", arguments: { workspacePath, status: "idea" } }));
    expect(listed).toContain(`#${task.number} Old agent`);
  });

  it("closes a task as done by another and shows it on both tasks", async () => {
    const workspacePath = "C:/Fake/proj";
    const project = h.services.projects.create({ workspaceRoot: workspacePath });
    const shipped = h.services.tasks.create({ projectId: project.id, title: "Ship search" });
    const unplanned = h.services.tasks.create({ projectId: project.id, title: "Search titles" });

    const gated = await client.callTool({
      name: "move_task",
      arguments: { task: `#${unplanned.number}`, status: "done" },
    });
    expect(text(gated)).toContain("close_task");

    const missing = await client.callTool({
      name: "close_task",
      arguments: { task: `#${unplanned.number}`, resolution: "completed" },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^VALIDATION: byTask/);

    const closed = await client.callTool({
      name: "close_task",
      arguments: { task: `#${unplanned.number}`, resolution: "completed", byTask: `#${shipped.number}` },
    });
    expect(closed.isError).toBeFalsy();
    expect(text(closed)).toContain(`Closed #${unplanned.number} as done by #${shipped.number}.`);
    expect(text(closed)).toContain(`Closed: done by #${shipped.number} "Ship search"`);

    const delivering = text(await client.callTool({ name: "get_task", arguments: { task: `#${shipped.number}` } }));
    expect(delivering).toContain(`Also resolved: #${unplanned.number} Search titles (done by this)`);

    const listed = text(await client.callTool({ name: "list_tasks", arguments: { workspacePath, status: "done" } }));
    expect(listed).toContain(`#${unplanned.number} Search titles — done by #${shipped.number}`);
  });

  it("lists missing ticket and T3 thread links until they are added, and never on done tasks", async () => {
    h.services.settings.update({ ticketSystems: [TEST_JIRA] });
    const workspacePath = "C:/Fake/proj";
    const project = h.services.projects.create({ workspaceRoot: workspacePath });
    const task = h.services.tasks.create({
      projectId: project.id,
      title: "CORE-1245 Fix login",
      description: "Follows CORE-1200. Uses utf-8.",
    });
    const ref = `#${task.number}`;
    const getTask = async () => text(await client.callTool({ name: "get_task", arguments: { task: ref } }));

    let detail = await getTask();
    expect(detail).toContain("Missing links:");
    expect(detail).toContain(`Jira CORE-1200: link(task: "${ref}", value: "CORE-1200")`);
    expect(detail).not.toContain("Jira CORE-1245:");
    expect(detail).not.toContain("utf-8:");
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

  it("add_to_backlog attaches links and the T3 thread", async () => {
    h.services.settings.update({ ticketSystems: [TEST_JIRA] });
    const created = await client.callTool({
      name: "add_to_backlog",
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
    expect(links.sort()).toEqual(["t3_thread", "ticket", "url"]);
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
    await call("add_to_backlog", { title: "Polish header", workspacePath, labels: ["UI", "polish"] });
    await call("create_task", {
      title: "Add endpoint",
      workspacePath,
      markdown: "## Build\n- [ ] route",
      labels: ["backend"],
    });
    await call("add_to_backlog", { title: "Write docs", workspacePath });

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

  it("asks for labels when planning an unlabelled task, naming the labels in use", async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const body = text(result);
      expect(result.isError ? body : null).toBeNull();
      return body;
    };
    const workspacePath = "C:/Fake/proj";
    const markdown = "## Build\n- [ ] route";
    await call("add_to_backlog", { title: "Tagged", workspacePath, labels: ["ui", "bug"] });
    await call("add_to_backlog", { title: "Untagged", workspacePath });

    const planned = await call("set_plan", { task: "#2", markdown });
    expect(planned).toContain("Missing labels:");
    expect(planned).toContain("Prefer labels already on the board: bug (1), ui (1).");
    expect(planned).toContain('update_task(task: "#2", labels: [...])');
    expect(await call("set_plan", { task: "#1", markdown })).not.toContain("Missing labels:");
    // Only the planning moments carry it, not every mutation.
    expect(await call("update_step", { task: "#2", step: "1.1", status: "in_progress" })).not.toContain(
      "Missing labels:",
    );

    expect(await call("create_task", { title: "New", workspacePath, markdown })).toContain("Missing labels:");
    expect(await call("create_task", { title: "Labelled", workspacePath, markdown, labels: ["ui"] })).not.toContain(
      "Missing labels:",
    );

    expect(await call("get_task", { task: "#2" })).toContain("Missing labels:");
    await call("close_task", { task: "#2", resolution: "wont_do" });
    expect(await call("get_task", { task: "#2" })).not.toContain("Missing labels:");
  });

  it("sets, keeps and clears the suggested model through set_plan, create_task and update_task", async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const body = text(result);
      expect(result.isError ? body : null).toBeNull();
      return body;
    };
    const workspacePath = "C:/Fake/proj";
    const markdown = "## Build\n- [ ] route";

    const created = await call("create_task", {
      title: "Endpoint",
      workspacePath,
      markdown,
      suggestedModel: { tier: "light", reason: "One route" },
    });
    expect(created).toContain("Suggested model: light (One route)");
    expect(created).not.toContain("Missing suggested model:");

    await call("add_to_backlog", { title: "Bare", workspacePath });
    const planned = await call("set_plan", { task: "#2", markdown });
    expect(planned).toContain("Missing suggested model:");
    expect(planned).toContain('update_task(task: "#2", suggestedModel:');
    const suggested = await call("set_plan", { task: "#2", markdown, suggestedModel: { tier: "deep" } });
    expect(suggested).toContain("Suggested model: deep");
    // Revising the plan without the argument keeps the suggestion.
    expect(await call("set_plan", { task: "#2", markdown })).toContain("Suggested model: deep");

    expect(await call("update_task", { task: "#2", suggestedModel: { tier: "standard" } })).toContain(
      "Suggested model: standard",
    );
    expect(await call("update_task", { task: "#2", suggestedModel: null })).not.toContain("Suggested model:");
    expect(await call("get_task", { task: "#2" })).toContain("suggested model cleared");

    const rejected = await client.callTool({
      name: "update_task",
      arguments: { task: "#2", suggestedModel: { tier: "huge" } },
    });
    expect(rejected.isError).toBe(true);
  });

  it("offers generic label examples only when the board has no labels yet", async () => {
    const created = await client.callTool({
      name: "create_task",
      arguments: { title: "First", workspacePath: "C:/Fake/proj", markdown: "## Build\n- [ ] route" },
    });
    expect(text(created)).toContain("No labels are in use yet; pick short type labels such as ui");
    expect(text(created)).not.toContain("Prefer labels already on the board");
  });

  it("lets an agent flag a task for the user and clear it again", async () => {
    const task = h.services.tasks.create({
      projectId: h.services.projects.create({ workspaceRoot: "C:/Fake/proj" }).id,
      title: "Plans",
      plan: { phases: [{ title: "Write", steps: [{ title: "a" }] }] },
    });
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "request_attention", arguments: { task: "#1", ...args } });
      return { isError: result.isError ?? false, out: text(result) };
    };

    expect(await call({})).toMatchObject({ isError: true, out: expect.stringContaining("Pass a message") });
    expect(await call({ message: "Plans are ready to review", clear: true })).toMatchObject({ isError: true });

    const flagged = await call({ message: "Plans are ready to review", actor: "claude-code" });
    expect(flagged).toEqual({ isError: false, out: expect.stringContaining("Flagged #1 for the user") });
    expect(h.services.tasks.summary(task.id).attention.map((a) => a.message)).toEqual(["Plans are ready to review"]);
    expect(text(await client.callTool({ name: "get_task", arguments: { task: "#1" } }))).toContain(
      "Needs attention: Plans are ready to review",
    );
    expect(h.services.tasks.summary(task.id).attentionRequest?.actor).toBe("claude-code");

    expect((await call({ clear: true })).out).toContain("Cleared");
    expect((await call({ clear: true })).out).toContain("no request for attention to clear");
    expect(h.services.tasks.summary(task.id).attention).toEqual([]);
  });
});
