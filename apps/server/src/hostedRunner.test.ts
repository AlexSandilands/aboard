import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, type HostedRunnerPairingCode, type HostedRunnerStatus } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.ts";
import { createHostedRunner, type CallNames, type HostedServer } from "./hostedRunner.ts";
import { startServer, type RunningServer } from "./server.ts";
import type { Services } from "./services/types.ts";
import { harnessHomesFrom } from "./services/skillSync.ts";

// A board that also runs tasks for another board (docs/features/remote-machines.md#a-board-that-is-also-a-runner),
// with real servers: board A hosts the runner, board B pairs with it and hands it a task.

const dirs: string[] = [];
const servers: RunningServer[] = [];
const configs = new Map<RunningServer, Config>();
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

async function startBoard(overrides: Partial<Config> = {}): Promise<RunningServer> {
  const homeDir = mkdtempSync(join(tmpdir(), `${BRAND.id}-hosted-`));
  dirs.push(homeDir);
  const config: Config = {
    role: "board",
    port: 0,
    webPort: 5317,
    host: "127.0.0.1",
    bind: "loopback",
    homeDir,
    dbPath: join(homeDir, "data.sqlite"),
    token: null,
    webDist: null,
    t3Home: "/nonexistent",
    pollers: false,
    userHome: "/nonexistent",
    harnessHomes: harnessHomesFrom({}, "/nonexistent"),
    sessionDirs: { claudeDir: "/nonexistent/.claude", copilotDir: "/nonexistent/.copilot" },
    worktreesDir: join(homeDir, "worktrees"),
    attachmentsDir: join(homeDir, "attachments"),
    modelPricesPath: join(homeDir, "model-prices.json"),
    hostedRunnerPort: await freePort(),
    ...overrides,
  };
  const server = await startServer(config);
  configs.set(server, config);
  servers.push(server);
  return server;
}

const json = async <T>(res: Response | Promise<Response>): Promise<T> => {
  const r = await res;
  const body = (await r.json()) as T;
  if (!r.ok) throw new Error(`${r.status}: ${JSON.stringify(body)}`);
  return body;
};

const send = (url: string, method: string, body?: unknown) =>
  fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** One tool call on a server's `/mcp`, as an agent on that machine makes it. */
async function callTool(url: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { id: number; result: { content: Array<{ text: string }>; isError?: boolean } };
  expect(body.id).toBe(7);
  return { text: body.result.content.map((c) => c.text).join("\n"), isError: body.result.isError === true };
}

async function generalProjectId(url: string): Promise<string> {
  const projects = await json<Array<{ id: string; title: string }>>(fetch(`${url}/api/projects`));
  return projects.find((p) => p.title === "General")!.id;
}

const createTask = async (url: string, title: string) =>
  json<{ id: string; number: number }>(
    send(`${url}/api/tasks`, "POST", {
      projectId: await generalProjectId(url),
      title,
      plan: { phases: [{ title: "Do", steps: [{ title: "It" }] }] },
    }),
  );

/** Board A with its runner on, and board B paired with that runner, holding nothing yet. */
async function pairedBoards() {
  const a = await startBoard();
  const status = await json<HostedRunnerStatus>(send(`${a.url}/api/runner`, "PATCH", { enabled: true }));
  expect(status).toMatchObject({ enabled: true, state: "running", board: null, heldTasks: 0 });
  const code = await json<HostedRunnerPairingCode>(send(`${a.url}/api/runner/pairing`, "POST"));
  expect(code.url).toBe(status.url);

  const b = await startBoard();
  const { machine } = await json<{ machine: { id: string; name: string } }>(
    send(`${b.url}/api/machines`, "POST", { via: "code", url: code.url, code: code.code }),
  );
  return { a, b, machineId: machine.id, runnerUrl: status.url! };
}

describe("a board that also runs tasks for another board", { timeout: 30_000 }, () => {
  it("is off by default, and starts and stops its runner with the setting", async () => {
    const a = await startBoard();
    expect(await json<HostedRunnerStatus>(fetch(`${a.url}/api/runner`))).toMatchObject({
      enabled: false,
      state: "off",
      url: null,
    });
    await expect(send(`${a.url}/api/runner/pairing`, "POST").then((r) => r.status)).resolves.toBe(409);

    const on = await json<HostedRunnerStatus>(send(`${a.url}/api/runner`, "PATCH", { enabled: true }));
    expect(on.state).toBe("running");
    const health = await json<{ role: string }>(fetch(`${on.url}/api/health`));
    expect(health.role).toBe("runner");
    // A runner of its own, which says it updates with the app.
    const descriptor = await json<{ instanceId: string; updatesWithApp: boolean }>(
      fetch(`${on.url}/machine/descriptor`),
    );
    expect(descriptor).toMatchObject({ instanceId: on.instanceId, updatesWithApp: true });
    expect(descriptor.instanceId).not.toBe(a.ctx.instanceId);

    const off = await json<HostedRunnerStatus>(send(`${a.url}/api/runner`, "PATCH", { enabled: false }));
    expect(off.state).toBe("off");
    await expect(fetch(`${on.url}/api/health`)).rejects.toThrow("fetch failed");
  });

  it("says why its runner couldn't start", async () => {
    const taken = await startBoard();
    const a = await startBoard({ hostedRunnerPort: taken.port });
    const status = await json<HostedRunnerStatus>(send(`${a.url}/api/runner`, "PATCH", { enabled: true }));
    expect(status).toMatchObject({ enabled: true, state: "failed" });
    expect(status.error).toContain(`Port ${taken.port} is in use`);
  });

  it("starts again with the board when it was left on", async () => {
    const a = await startBoard();
    await json(send(`${a.url}/api/runner`, "PATCH", { enabled: true }));
    const config = configs.get(a)!;
    await a.close();
    servers.splice(servers.indexOf(a), 1);
    const again = await startServer(config);
    servers.push(again);
    await expect
      .poll(async () => (await json<HostedRunnerStatus>(fetch(`${again.url}/api/runner`))).state)
      .toBe("running");
  });

  it("holds another board's task without this board ever seeing it", async () => {
    const { a, b, machineId, runnerUrl } = await pairedBoards();
    const status = await json<HostedRunnerStatus>(fetch(`${a.url}/api/runner`));
    expect(status.board?.instanceId).toBe(b.ctx.instanceId);

    const mine = await createTask(a.url, "A's own task");
    const theirs = await createTask(b.url, "B's task");
    await json(send(`${b.url}/api/tasks/${theirs.id}/hold`, "POST", { machineId }));
    expect((await json<HostedRunnerStatus>(fetch(`${a.url}/api/runner`))).heldTasks).toBe(1);

    // Not on A's board, its lists or its API.
    const listed = await json<Array<{ id: string }>>(fetch(`${a.url}/api/tasks`));
    expect(listed.map((t) => t.id)).toEqual([mine.id]);
    expect(() => a.ctx.services.tasks.summary(theirs.id)).toThrow(/not found/i);
    const snapshot = await (await fetch(`${a.url}/api/board`)).text();
    expect(snapshot).toContain(mine.id);
    expect(snapshot).not.toContain(theirs.id);
    // Nor in A's backups, or its stats, which read the same tables.
    expect(JSON.stringify(a.ctx.services.backup.dump())).not.toContain(theirs.id);
    const overview = await callTool(a.url, "list_tasks", {});
    expect(overview.text).toContain("A's own task");
    expect(overview.text).not.toContain("B's task");

    // An agent on this machine reads and changes it through A's MCP, by its id: the runner's copy changes.
    const read = await callTool(a.url, "get_task", { task: theirs.id });
    expect(read.isError).toBe(false);
    expect(read.text).toContain("B's task");
    const moved = await callTool(a.url, "move_task", { task: theirs.id, status: "in_progress" });
    expect(moved.isError).toBe(false);
    expect(() => a.ctx.services.tasks.summary(theirs.id)).toThrow(/not found/i);
    const runnerCopy = await json<{ status: string }>(fetch(`${runnerUrl}/api/tasks/${theirs.id}`));
    expect(runnerCopy.status).toBe("in_progress");
    // And B, which owns it, gets the change from the runner's log.
    await expect
      .poll(async () => (await json<{ status: string }>(fetch(`${b.url}/api/tasks/${theirs.id}`))).status, {
        timeout: 15_000,
      })
      .toBe("in_progress");

    // A script on this machine gets the same through A's REST address; a browser never does.
    const viaRest = await fetch(`${a.url}/api/tasks/${theirs.id}`);
    expect(((await viaRest.json()) as { title: string }).title).toBe("B's task");
    const fromBrowser = await fetch(`${a.url}/api/tasks/${theirs.id}`, { headers: { origin: a.url } });
    expect(fromBrowser.status).toBe(404);

    // An agent asking for the user on B's task reaches B's inbox, never A's.
    const ask = await callTool(a.url, "request_attention", { task: theirs.id, message: "Which parser?" });
    expect(ask.isError).toBe(false);
    await expect
      .poll(async () => JSON.stringify(await json(fetch(`${b.url}/api/notifications`))), { timeout: 15_000 })
      .toContain("Which parser?");
    expect(JSON.stringify(await json(fetch(`${a.url}/api/notifications`)))).not.toContain("Which parser?");

    // A's own task is A's.
    const own = await callTool(a.url, "get_task", { task: mine.id });
    expect(own.text).toContain("A's own task");
  });

  it("refuses a task number both boards use, naming both ids", async () => {
    const { a, b, machineId } = await pairedBoards();
    const mine = await createTask(a.url, "A's own task");
    const theirs = await createTask(b.url, "B's task");
    expect(mine.number).toBe(theirs.number);
    await json(send(`${b.url}/api/tasks/${theirs.id}/hold`, "POST", { machineId }));

    const both = await callTool(a.url, "update_step", { task: `#${mine.number}`, step: "1.1", status: "done" });
    expect(both.isError).toBe(true);
    expect(both.text).toContain(mine.id);
    expect(both.text).toContain(theirs.id);
    // Neither changed.
    expect(a.ctx.services.tasks.detail(mine.id).phases[0]?.steps[0]?.status).toBe("todo");

    // A folder in the runner's data dir says whose it is.
    const runnerHome = join(configs.get(a)!.homeDir, "runner", "worktrees", "some-task");
    const byFolder = await callTool(a.url, "get_task", {
      task: `#${mine.number}`,
      workspacePath: runnerHome,
    });
    expect(byFolder.text).toContain("B's task");
  });

  it("knows a worktree of the runner's clone made outside its data dir as the runner's", async () => {
    const { a, b } = await pairedBoards();
    const projectsOf = async (url: string) =>
      (await json<Array<{ title: string }>>(fetch(`${url}/api/projects`))).map((p) => p.title).sort();
    const before = await projectsOf(a.url);
    // A clone of the runner's, and a worktree of it where T3 Code puts a thread's: outside the runner's data dir.
    const clone = join(configs.get(a)!.homeDir, "runner", "repos", "app");
    mkdirSync(clone, { recursive: true });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
    git(clone, "init", "--quiet");
    writeFileSync(join(clone, "README.md"), "hello\n");
    git(clone, "add", ".");
    git(clone, "commit", "--quiet", "-m", "init");
    const elsewhere = mkdtempSync(join(tmpdir(), `${BRAND.id}-t3-worktrees-`));
    dirs.push(elsewhere);
    git(clone, "worktree", "add", "--quiet", join(elsewhere, "thread"));

    // It answers from the runner, which numbers a task once B has polled it.
    await expect
      .poll(
        async () =>
          (
            await callTool(a.url, "add_to_backlog", {
              title: "A follow-up for B",
              workspacePath: join(elsewhere, "thread"),
            })
          ).text,
        { timeout: 15_000 },
      )
      .not.toMatch(/^[A-Z_]+:/);
    // Not a project, or a task, on A.
    expect(await projectsOf(a.url)).toEqual(before);
    expect(await (await fetch(`${a.url}/api/board`)).text()).not.toContain("A follow-up for B");
    // B gets it from the runner.
    await expect
      .poll(async () => (await fetch(`${b.url}/api/board`)).text(), { timeout: 15_000 })
      .toContain("A follow-up for B");
  });

  it("hands a script's change to a held task to the runner, and never a browser's read", async () => {
    const { a, b, machineId, runnerUrl } = await pairedBoards();
    const theirs = await createTask(b.url, "B's task");
    await json(send(`${b.url}/api/tasks/${theirs.id}/hold`, "POST", { machineId }));
    const noted = await send(`${a.url}/api/tasks/${theirs.id}/notes`, "POST", { text: "From a script here" });
    expect(noted.status).toBe(201);
    const copy = await json<{ lastNote: { text: string } }>(fetch(`${runnerUrl}/api/tasks/${theirs.id}`));
    expect(copy.lastNote.text).toBe("From a script here");
    // A same-origin GET carries no Origin, but a browser's always carries Sec-Fetch-*.
    const fromPage = await fetch(`${a.url}/api/tasks/${theirs.id}`, { headers: { "sec-fetch-site": "same-origin" } });
    expect(fromPage.status).toBe(404);
  });

  it("refuses one call naming tasks of both boards", async () => {
    const { a, b, machineId } = await pairedBoards();
    await createTask(b.url, "B's first");
    const theirs = await createTask(b.url, "B's task");
    const mine = await createTask(a.url, "A's own task");
    await json(send(`${b.url}/api/tasks/${theirs.id}/hold`, "POST", { machineId }));
    const both = await callTool(a.url, "get_handoff_prompt", { tasks: [mine.id, theirs.id] });
    expect(both.isError).toBe(true);
    expect(both.text).toContain("make one call for each");
  });

  it("won't pair with the board it runs in", async () => {
    const a = await startBoard();
    await json(send(`${a.url}/api/runner`, "PATCH", { enabled: true }));
    const code = await json<HostedRunnerPairingCode>(send(`${a.url}/api/runner/pairing`, "POST"));
    const res = await send(`${a.url}/api/machines`, "POST", { via: "code", url: code.url, code: code.code });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("board's own machine");
  });

  it("unpairs the board it works for", async () => {
    const { a } = await pairedBoards();
    const status = await json<HostedRunnerStatus>(send(`${a.url}/api/runner/pairing`, "DELETE"));
    expect(status.board).toBeNull();
  });
});

/** A task as `route` sees it: its id and number on one side. */
interface StubTask {
  id: string;
  number: number;
  title: string;
  role?: "held" | "reference";
}

function stubServices(tasks: StubTask[], projects: string[] = []): Services {
  const find = (ref: string) => tasks.find((t) => t.id === ref || `#${t.number}` === ref || String(t.number) === ref);
  let setting = { enabled: true, bind: "loopback" as const };
  let t3Token: string | null = null;
  return {
    tasks: {
      resolveId: (ref: string) => {
        const task = find(ref);
        if (!task) throw new Error("not found");
        return task.id;
      },
      summary: (id: string) => ({ ...find(id)!, numberPrefix: null }),
    },
    workingCopies: { role: (id: string) => find(id)?.role ?? null, heldIds: () => [] },
    machineAuth: { pairings: () => [{ board: { name: "desk" } }] },
    projects: { list: () => projects.map((id) => ({ id })) },
    settings: {
      hostedRunner: () => setting,
      setHostedRunner: (next: typeof setting) => (setting = next),
      t3Token: () => t3Token,
      update: (input: { t3Token?: string | null }) => {
        if (input.t3Token !== undefined) t3Token = input.t3Token;
      },
      get: () => ({ machineName: "laptop" }),
    },
  } as unknown as Services;
}

/** A hosted runner over stub services, started, with `runs` in flight. */
async function stubbed(board: Services, runner: Services, runs = 0) {
  const hosted = createHostedRunner({
    board: { homeDir: mkdtempSync(join(tmpdir(), `${BRAND.id}-route-`)) } as Config,
    boardInstanceId: "00000000-0000-4000-8000-000000000000",
    boardServices: () => board,
    start: () =>
      Promise.resolve({
        url: "http://127.0.0.1:1",
        port: 1,
        ctx: {
          services: runner,
          instanceId: "x",
          integrations: { runnerHost: { workInFlight: () => runs } },
        },
        close: () => Promise.resolve(),
      } as unknown as HostedServer),
    changed: () => {},
    log: { info: () => {}, warn: () => {} },
  });
  await hosted.start();
  return hosted;
}

describe("which board a call belongs to", () => {
  const none: CallNames = { tasks: [], paths: [], projectIds: [] };

  it("follows each row of the routing table", async () => {
    const board = stubServices(
      [
        { id: "b1", number: 1, title: "Mine" },
        { id: "b9", number: 9, title: "Mine too" },
      ],
      ["pb"],
    );
    const runner = stubServices(
      [
        { id: "r1", number: 1, title: "Theirs", role: "held" },
        { id: "r5", number: 5, title: "Theirs too", role: "held" },
        { id: "e9", number: 9, title: "Their epic", role: "reference" },
        { id: "e3", number: 3, title: "Another epic", role: "reference" },
      ],
      ["pr"],
    );
    const hosted = await stubbed(board, runner);
    const to = (names: Partial<typeof none>) => hosted.route({ ...none, ...names }).to;

    expect(to({ tasks: ["r5"] })).toBe("runner");
    expect(to({ tasks: ["#5"] })).toBe("runner");
    expect(to({ tasks: ["#3"] })).toBe("runner");
    expect(to({ tasks: ["b1"] })).toBe("board");
    expect(to({ tasks: ["#404"] })).toBe("board");
    expect(to({})).toBe("board");
    expect(to({ projectIds: ["pr"] })).toBe("runner");
    expect(to({ projectIds: ["pb"] })).toBe("board");
    // A number on both, whether the runner holds its task or only refers to it.
    const held = hosted.route({ ...none, tasks: ["#1"] });
    expect(held).toMatchObject({ to: "ambiguous" });
    expect(held.to === "ambiguous" && held.message).toContain("which this machine holds for desk (id r1)");
    const referred = hosted.route({ ...none, tasks: ["#9"] });
    expect(referred.to === "ambiguous" && referred.message).toContain(
      "which a task this machine holds for it refers to",
    );
    expect(to({ tasks: ["b1", "r5"] })).toBe("ambiguous");
  });

  it("asks before ending runs in flight, and goes ahead when told to", async () => {
    const board = stubServices([]);
    const hosted = await stubbed(board, stubServices([]), 2);
    await expect(hosted.configure({ enabled: false })).rejects.toThrow(/2 runs for desk are going here/);
    await expect(hosted.configure({ bind: "private" })).rejects.toThrow(/restarting the runner ends them/);
    expect(hosted.running()).toBe(true);
    expect(board.settings.hostedRunner()).toEqual({ enabled: true, bind: "loopback" });
    expect((await hosted.configure({ enabled: false, force: true })).state).toBe("off");
  });

  it("keeps the runner's T3 token the board's", async () => {
    const board = stubServices([]);
    const runner = stubServices([]);
    board.settings.update({ t3Token: "first" });
    const hosted = await stubbed(board, runner);
    expect(runner.settings.t3Token()).toBe("first");
    board.settings.update({ t3Token: "second" });
    hosted.syncT3Token();
    expect(runner.settings.t3Token()).toBe("second");
  });
});
