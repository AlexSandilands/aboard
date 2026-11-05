import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createGitFixture, git } from "../test/gitRepo.ts";
import { createTestHarness } from "../test/harness.ts";

type Harness = ReturnType<typeof createTestHarness>;

async function connect(h: Harness) {
  const client = new Client({ name: "agent", version: "1.0.0" });
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

const NOTICE = "Created a NEW project";
const markdown = "## Build\n- [ ] route";

describe("results that create a project", () => {
  let h: Harness;
  let agent: Client;

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await agent.callTool({ name, arguments: args })) as CallToolResult;
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(result.isError ? text : null).toBeNull();
    return text;
  };

  beforeEach(async () => {
    h = createTestHarness();
    agent = await connect(h);
  });
  afterEach(async () => {
    await agent.close();
    h.db.close();
  });

  it("lead with a notice only on the call that made the project", async () => {
    const first = await call("add_to_backlog", { title: "One", workspacePath: "C:/Fake/proj" });
    expect(first.startsWith(`${NOTICE} proj at C:/Fake/proj.`)).toBe(true);
    expect(first).toContain("update_task(moveToProjectId)");
    expect(await call("add_to_backlog", { title: "Two", workspacePath: "C:/Fake/proj" })).not.toContain(NOTICE);

    expect(await call("create_task", { title: "Three", workspacePath: "C:/Fake/other", markdown })).toMatch(
      new RegExp(`^${NOTICE} other at`),
    );
    expect(await call("create_task", { title: "Four", workspacePath: "C:/Fake/other", markdown })).not.toContain(
      NOTICE,
    );

    expect(await call("create_epic", { title: "Epic", workspacePath: "C:/Fake/third" })).toMatch(
      new RegExp(`^${NOTICE} third at .*this epic`),
    );
    expect(await call("add_to_backlog", { title: "General", general: true })).not.toContain(NOTICE);
  });

  it("file a task from a git worktree in the main checkout's project, with no notice", async () => {
    const fx = createGitFixture();
    try {
      const main = realpathSync.native(fx.checkout);
      const worktree = join(realpathSync.native(fx.root), "wt");
      git(main, "worktree", "add", "--quiet", "-b", "wt", worktree);
      const project = h.services.projects.create({ workspaceRoot: main });

      const text = await call("add_to_backlog", { title: "From a worktree", workspacePath: worktree });
      expect(text).not.toContain(NOTICE);
      expect(text).toContain(`in ${project.title}`);
      expect(h.services.projects.list()).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });
});
