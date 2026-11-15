import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createBoardAndRunner } from "../test/boardAndRunner.ts";
import type { createTestHarness } from "../test/harness.ts";

// An agent on a machine that holds tasks for a board: the same tools, on 127.0.0.1, against the runner's app.

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function connect(h: ReturnType<typeof createTestHarness>) {
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4318/mcp"), {
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      headers.set("host", "127.0.0.1:4318");
      return Promise.resolve(h.app.request(url.pathname + url.search, { ...init, headers }));
    },
  });
  await client.connect(transport);
  closers.push(() => client.close());
  return client;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result as CallToolResult).content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

async function setup() {
  const pair = await createBoardAndRunner({ remotes: { "/work/app": "git@github.com:acme/app.git" } });
  closers.push(pair.stop);
  const { board, machine } = pair;
  const project = board.services.projects.create({ title: "App", workspaceRoot: "/work/app" });
  const plan = { phases: [{ title: "Build", steps: [{ title: "Write it" }] }] };
  const held = board.services.tasks.create({ projectId: project.id, title: "Held here", plan });
  const other = board.services.tasks.create({ projectId: project.id, title: "Stays on the board", plan });
  await board.integrations.machineSync.handOver(held.id, machine.id, "user");
  // The board's first read of the log: the machine now knows its board is there.
  await pair.sync();
  const agent = await connect(pair.runner);
  /** A call that needs the board: the board's next round carries it there and the answer back. */
  const withBoard = async (call: Promise<Awaited<ReturnType<Client["callTool"]>>>) => {
    const state = { settled: false };
    const result = call.finally(() => (state.settled = true));
    while (!state.settled) {
      await pair.sync();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return result;
  };
  /** Long enough without a poll that the machine takes its board for gone. */
  const boardAway = () => {
    pair.clock.now = new Date(pair.clock.now.getTime() + 60_000);
  };
  return { ...pair, project, held, other, agent, withBoard, boardAway };
}

describe("the tools on a machine", () => {
  it("change a held task as on a board, and the board follows", async () => {
    const { board, agent, held, sync } = await setup();
    const moved = await agent.callTool({
      name: "move_task",
      arguments: { task: `#${held.number}`, status: "in_progress" },
    });
    expect(text(moved)).toContain(`Moved #${held.number} to In Progress`);
    await agent.callTool({ name: "update_step", arguments: { task: `#${held.number}`, step: "1.1", status: "done" } });
    await agent.callTool({
      name: "add_note",
      arguments: { task: `#${held.number}`, text: "Done with the first part" },
    });
    await sync();

    const now = board.services.tasks.detail(held.id);
    expect(now.status).toBe("in_progress");
    expect(now.progress).toEqual({ done: 1, total: 1 });
    expect(now.lastNote).toMatchObject({ text: "Done with the first part" });
  });

  it("pass a read of a task the machine doesn't hold on to the board", async () => {
    const { agent, other, withBoard } = await setup();
    const read = await withBoard(agent.callTool({ name: "get_task", arguments: { task: `#${other.number}` } }));
    expect(read.isError).toBeFalsy();
    expect(text(read)).toContain(`#${other.number} Stays on the board [Planned]`);
  });

  it("say why when the board can't be reached", async () => {
    const { agent, other, boardAway } = await setup();
    boardAway();
    const read = await agent.callTool({ name: "get_task", arguments: { task: `#${other.number}` } });
    expect(read.isError).toBe(true);
    expect(text(read)).toBe(
      `CONFLICT: #${other.number} isn't held by engine, and the board can't be reached from it right now, so it ` +
        "can't be read here. Try again once the board is back.",
    );
  });

  it("list the whole board while it is reachable, and only what is held here when it isn't", async () => {
    const { runner, agent, held, withBoard, boardAway } = await setup();
    const workspacePath = runner.services.projects.get(runner.services.tasks.summary(held.id).projectId).workspaceRoot!;
    const all = await withBoard(agent.callTool({ name: "list_tasks", arguments: { workspacePath } }));
    expect(text(all)).toContain("Stays on the board");
    expect(text(all)).toContain("Held here");

    boardAway();
    const here = await agent.callTool({ name: "list_tasks", arguments: { workspacePath } });
    expect(text(here)).toContain(
      "This shows only the tasks engine holds: the board can't be reached from it right now.",
    );
    expect(text(here)).toContain("Held here");
    expect(text(here)).not.toContain("Stays on the board");
  });

  it("refuse to change a task the machine doesn't hold", async () => {
    const { board, agent, other } = await setup();
    const moved = await agent.callTool({
      name: "move_task",
      arguments: { task: `#${other.number}`, status: "in_progress" },
    });
    expect(moved.isError).toBe(true);
    expect(text(moved)).toContain(`#${other.number} isn't held by engine, so it can't be changed here`);
    expect(board.services.tasks.summary(other.id).status).toBe("planned");
  });

  it("refuse what only the board does", async () => {
    const { agent, held } = await setup();
    const epic = await agent.callTool({ name: "create_epic", arguments: { title: "Big", workspacePath: "/work/x" } });
    expect(text(epic)).toContain("create_epic works on the user's board, not on engine");
    const merge = await agent.callTool({ name: "merge_task_pr", arguments: { task: `#${held.number}` } });
    expect(merge.isError).toBe(true);
  });
});

describe("a task made on a machine", () => {
  it("takes the board's next number while the board is reachable, and is the machine's to hold", async () => {
    const { board, runner, machine, agent, held, other, withBoard, sync } = await setup();
    const workspacePath = runner.services.projects.get(runner.services.tasks.summary(held.id).projectId).workspaceRoot!;
    const made = await withBoard(
      agent.callTool({ name: "add_to_backlog", arguments: { title: "Found on the way", workspacePath } }),
    );
    const number = other.number + 1;
    expect(text(made)).toContain(`#${number}`);
    await sync();

    const onBoard = board.services.tasks.detail(board.services.tasks.resolveId(`#${number}`));
    expect(onBoard).toMatchObject({ title: "Found on the way", status: "backlog", projectId: held.projectId });
    expect(onBoard.hold).toMatchObject({ machineId: machine.id });
    expect(onBoard.numberPrefix).toBe("");
    // The board's own next task doesn't collide with it.
    expect(board.services.tasks.create({ projectId: held.projectId, title: "Next" }).number).toBe(number + 1);
  });

  it("takes the machine's prefix and its own counter while the board is away, for good", async () => {
    const { board, runner, machine, agent, held, boardAway, sync } = await setup();
    const workspacePath = runner.services.projects.get(runner.services.tasks.summary(held.id).projectId).workspaceRoot!;
    boardAway();
    const first = await agent.callTool({ name: "add_to_backlog", arguments: { title: "While away", workspacePath } });
    const second = await agent.callTool({ name: "add_to_backlog", arguments: { title: "And again", workspacePath } });
    expect(text(first)).toContain("#E1");
    expect(text(second)).toContain("#E2");
    // Any spelling names it, on the machine and later on the board.
    const read = await agent.callTool({ name: "get_task", arguments: { task: "e2" } });
    expect(text(read)).toContain("#E2 And again");

    await sync();
    const onBoard = board.services.tasks.summary(board.services.tasks.resolveId("#E1"));
    expect(onBoard).toMatchObject({ title: "While away", number: 1, numberPrefix: "E", projectId: held.projectId });
    expect(onBoard.hold?.machineId).toBe(machine.id);
    expect(board.services.tasks.resolveId("E2")).toBe(board.services.tasks.resolveId("#e2"));
    // A task carries the prefix now, so it can't change, and the board knows how far the counter got.
    expect(board.services.machines.get(machine.id).prefixFixed).toBe(true);
    expect(board.services.holds.position(machine.id).counter).toBe(2);
  });

  it("carries on from the board's high-water mark after the machine was reinstalled", async () => {
    const { board, machine } = await setup();
    board.db.prepare("INSERT INTO counters (name, value) VALUES ('machine_task_number:E', 41)").run();
    expect(board.services.holds.position(machine.id).counter).toBe(41);
    // A fresh runner told so on its first poll numbers from there.
    const fresh = await createBoardAndRunner();
    closers.push(fresh.stop);
    fresh.runner.services.workingCopies.setNumbering("E", 41);
    expect(fresh.runner.services.workingCopies.nextNumber()).toEqual({ prefix: "E", number: 42 });
  });
});
