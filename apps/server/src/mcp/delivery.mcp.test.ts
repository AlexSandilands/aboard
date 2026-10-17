import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunGit } from "../integrations/backup.ts";
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

const HINT = "Epic delivery not chosen:";
const markdown = "## Build\n- [ ] route";

/** git for a checkout whose origin has main, and the epic branches pushed so far. */
function fakeGit(repo: string) {
  const pushed: string[] = [];
  let failPush = false;
  const runGit: RunGit = async (args) => {
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const no = { code: 1, stdout: "", stderr: "" };
    const cmd = args.join(" ");
    if (cmd === "rev-parse --show-toplevel") return ok(`${repo}\n`);
    if (cmd === "remote get-url origin") return ok("https://github.com/acme/app.git\n");
    if (cmd.startsWith("fetch")) return ok();
    if (cmd.startsWith("symbolic-ref")) return ok("origin/main\n");
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      const ref = args.at(-1)!.replace("^{commit}", "");
      if (ref === "refs/remotes/origin/main") return ok("abc\n");
      return pushed.some((b) => ref === `refs/remotes/origin/${b}`) ? ok("def\n") : no;
    }
    if (args[0] === "push") {
      if (failPush) return { code: 1, stdout: "", stderr: "remote: Permission denied" };
      pushed.push(args[2]!.slice(args[2]!.indexOf("refs/heads/") + "refs/heads/".length));
      return ok();
    }
    throw new Error(`fake git: unexpected ${cmd}`);
  };
  return { runGit, pushed, failPush: () => (failPush = true) };
}

describe("epic delivery over MCP", () => {
  let h: Harness;
  let agent: Client;
  let repo: string;
  let git: ReturnType<typeof fakeGit>;

  const result = async (name: string, args: Record<string, unknown>) => {
    const r = (await agent.callTool({ name, arguments: args })) as CallToolResult;
    return { text: r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"), isError: r.isError === true };
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await result(name, args);
    expect(r.isError ? r.text : null).toBeNull();
    return r.text;
  };

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "delivery-"));
    git = fakeGit(repo);
    h = createTestHarness({ integrations: { autopilotGit: git.runGit } });
    agent = await connect(h);
  });
  afterEach(async () => {
    await agent.close();
    h.db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("asks about delivery once an epic's tasks build on each other, until the user has chosen", async () => {
    const workspacePath = repo;
    await call("create_task", { title: "Model", workspacePath, markdown });
    // One task: nothing to ask yet.
    expect(await call("create_epic", { title: "Checkout", workspacePath, tasks: ["#1"] })).not.toContain(HINT);
    const planned = await call("create_task", {
      title: "Routes",
      workspacePath,
      markdown,
      epic: "#2",
      blockedBy: ["#1"],
    });
    expect(planned).toContain(HINT);
    expect(planned).toContain('update_task(task: "#2", delivery: "integration" | "main")');
    expect(await call("epic_overview", { task: "#2" })).toContain(HINT);
    // Elsewhere it stays quiet.
    expect(await call("get_task", { task: "#3" })).not.toContain(HINT);

    expect(await call("update_task", { task: "#2", delivery: "main" })).not.toContain(HINT);
    expect(await call("set_plan", { task: "#3", markdown })).not.toContain(HINT);
    expect(await call("epic_overview", { task: "#2" })).toContain("Delivery: pull requests to the default branch");
  });

  it("asks for three planned tasks with no relations too", async () => {
    const workspacePath = repo;
    for (const title of ["A", "B", "C"]) await call("create_task", { title, workspacePath, markdown });
    expect(await call("create_epic", { title: "Batch", workspacePath, tasks: ["#1", "#2", "#3"] })).toContain(HINT);
  });

  it("switches an epic to an integration branch it makes on origin, and tells its tasks", async () => {
    const workspacePath = repo;
    await call("create_task", { title: "Model", workspacePath, markdown });
    const created = await call("create_epic", {
      title: "One-page checkout",
      workspacePath,
      tasks: ["#1"],
      delivery: "integration",
    });
    expect(git.pushed).toEqual(["epic/2-one-page-checkout"]);
    expect(created).toContain("Delivery: integration branch epic/2-one-page-checkout");
    expect(await call("get_task", { task: "#1" })).toContain(
      "Delivery: start from epic/2-one-page-checkout and open your pull request against it",
    );
    const prompt = await call("get_handoff_prompt", { task: "#1" });
    expect(prompt).toContain("gh pr create --base epic/2-one-page-checkout");
    expect(await call("get_handoff_prompt", { task: "#2" })).toContain(
      "This epic is delivered through the integration branch `epic/2-one-page-checkout`",
    );

    // Once a task has started, there's no going back to main.
    await call("move_task", { task: "#1", status: "in_progress" });
    const back = await result("update_task", { task: "#2", delivery: "main" });
    expect(back.isError).toBe(true);
    expect(back.text).toMatch(/can't go back to pull requests to main: #1 already started/);
  });

  it("goes back to main while nothing started, and reuses the branch when switching again", async () => {
    const workspacePath = repo;
    await call("create_epic", { title: "Checkout", workspacePath, delivery: "integration" });
    expect(await call("update_task", { task: "#1", delivery: "main" })).not.toContain("Delivery: integration");
    expect(await call("update_task", { task: "#1", delivery: "integration" })).toContain(
      "Delivery: integration branch epic/1-checkout",
    );
    expect(git.pushed).toEqual(["epic/1-checkout"]);
  });

  it("refuses delivery on a task, and says why a branch couldn't be made", async () => {
    const workspacePath = repo;
    await call("create_task", { title: "Model", workspacePath, markdown });
    const onTask = await result("update_task", { task: "#1", delivery: "integration" });
    expect(onTask.isError).toBe(true);
    expect(onTask.text).toContain("delivery is set on an epic");
    git.failPush();
    const created = await call("create_epic", { title: "Checkout", workspacePath, delivery: "integration" });
    expect(created).toContain("Its delivery wasn't set: Couldn't make the epic's branch epic/2-checkout");
    expect(created).toContain("Permission denied");
    expect(h.services.tasks.summary(h.services.tasks.resolveId("#2")).delivery).toBeNull();
  });
});
