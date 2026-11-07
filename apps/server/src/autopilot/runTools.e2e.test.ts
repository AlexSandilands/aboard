import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { PR_REVIEW_OUTPUT_SCHEMA, type AutopilotRun, type ProviderSetting } from "@repo/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pageDiff, type GitHostReads, type HostPrFile } from "../integrations/gitHost.ts";
import type { AgentJob } from "../integrations/headlessAgent.ts";
import { RUN_SERVER_NAME, RUN_TOKEN_ENV, type RunToolScope } from "../mcp/runTokens.ts";
import { RUN_TOOLS_PATH } from "../mcp/runTools.ts";
import { createGitFixture } from "../test/gitRepo.ts";
import { createTestHarness } from "../test/harness.ts";
import { PROCESS_TEST_TIMEOUT } from "../test/timeouts.ts";
import { createAutopilotRunner } from "./runner.ts";

// A run on the board's run tools from end to end: the real runner mints the token and writes the config, a fake CLI
// connects to `/mcp/run` exactly as the config tells it and reads a large PR in full, and the token is gone after.

const SESSION = "11111111-2222-4333-8444-555555555555";
const THREAD = "01a1a0ab-0000-7000-8000-000000000001";
const ALL_PROVIDERS: ProviderSetting[] = [
  { id: "claude-code", enabled: true },
  { id: "codex", enabled: true },
];
const SCOPE: RunToolScope = {
  toolSet: "prReview",
  target: { kind: "pr", host: "github.com", repo: "acme/app", number: 7 },
};

/** A large PR: 25 files of 600 added lines, 15,000 lines in all. */
const FILES: HostPrFile[] = Array.from({ length: 25 }, (_, i) => ({
  path: `src/mod${i}.ts`,
  previousPath: null,
  status: "added",
  additions: 600,
  deletions: 0,
  patch: [`@@ -0,0 +1,600 @@`, ...Array.from({ length: 600 }, (_line, n) => `+mod${i} line ${n + 1}`)].join("\n"),
}));

const host: GitHostReads = {
  getPr: async (ref) => ({
    number: ref.number,
    url: `https://${ref.host}/${ref.repo}/pull/${ref.number}`,
    title: "Add modules",
    body: "",
    state: "open",
    draft: false,
    author: "octo",
    baseRef: "main",
    headRef: "feature",
    headSha: "abc",
    additions: 15_000,
    deletions: 0,
    changedFiles: FILES.length,
  }),
  listFiles: async () => FILES,
  getDiff: async (_ref, path, page) => pageDiff(FILES, path, page),
  getComments: async () => [],
  getIssue: async () => {
    throw new Error("not used");
  },
};

type Harness = ReturnType<typeof createTestHarness>;

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result as CallToolResult).content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

/** Connects to the run's endpoint the way a CLI would, given the URL and headers its config names. */
async function connect(h: Harness, url: string, headers: Record<string, string>) {
  const client = new Client({ name: "fake-cli", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers },
      fetch: (input, init) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        const sent = new Headers(init?.headers);
        sent.set("host", target.host);
        return Promise.resolve(h.app.request(target.pathname, { ...init, headers: sent }));
      },
    }),
  );
  return client;
}

/** Reads every page of the whole diff, as the review prompt says to, and returns it. */
async function readWholeDiff(client: Client): Promise<string> {
  let all = "";
  for (let page = 1; ; page += 1) {
    const out = text(await client.callTool({ name: "pr_diff", arguments: { page } }));
    all += out;
    if (!out.includes(`Next: pr_diff(page: ${page + 1})`)) return all;
  }
}

/** Every line of the PR's diff, in order, is in what was read. */
const readInFull = (diff: string) => {
  const lines = new Set(diff.split("\n"));
  return FILES.every((f) => f.patch!.split("\n").every((line) => lines.has(line)));
};

describe("a run on the board's run tools", { timeout: PROCESS_TEST_TIMEOUT }, () => {
  let repo: ReturnType<typeof createGitFixture>;
  beforeEach(() => {
    repo = createGitFixture();
  }, PROCESS_TEST_TIMEOUT);
  afterEach(() => repo.cleanup());

  function setup(agent: (job: AgentJob, h: Harness) => Promise<string>) {
    const h = createTestHarness({ integrations: { gitHost: host } });
    h.services.settings.update({ providers: ALL_PROVIDERS });
    const project = h.services.projects.create({ title: "App", workspaceRoot: repo.checkout });
    const task = h.services.tasks.create({
      projectId: project.id,
      title: "Add modules",
      plan: { phases: [{ title: "Build", steps: [{ title: "a" }] }] },
    });
    const minted: string[] = [];
    const runner = createAutopilotRunner({
      services: () => h.services,
      t3: {
        status: () => ({
          detected: false,
          origin: null,
          environmentId: null,
          label: null,
          liveStatus: "off",
          error: null,
        }),
        test: async () => {
          throw new Error("no T3");
        },
        launchTaskThread: async () => {
          throw new Error("no T3");
        },
        sendToThread: async () => {},
        threadWorkspace: async () => null,
        retryPreparation: async () => {},
      },
      worktreesDir: repo.worktrees,
      newSessionId: () => SESSION,
      // As integrations/index.ts wires it, on the test app's port.
      runTools: {
        mint: (runId, scope, ttlMs) => {
          minted.push(runId);
          const { token, revoke } = h.integrations.runTools.tokens.mint(runId, scope, ttlMs);
          return { url: `http://127.0.0.1:4317${RUN_TOOLS_PATH}`, token, revoke };
        },
      },
      runAgent: (job) => agent(job, h),
      log: { warn: () => {} },
    });
    const run: AutopilotRun = {
      id: randomUUID(),
      automation: "review-prs",
      taskId: task.id,
      projectId: project.id,
      dedupeKey: "k",
      status: "running",
      summary: "review",
      dryRun: false,
      runner: null,
      sessionId: null,
      threadUrl: null,
      worktreePath: null,
      costUsd: null,
      detail: null,
      exitCode: null,
      error: null,
      deferred: null,
      needsAttention: false,
      dismissedAt: null,
      output: null,
      model: null,
      createdAt: "2026-10-17T00:00:00.000Z",
      startedAt: "2026-10-17T00:00:00.000Z",
      finishedAt: null,
      updatedAt: "2026-10-17T00:00:00.000Z",
    };
    return { h, runner, run, minted };
  }

  it("reviews a large PR on Claude Code: only the run's server, read in full, the token revoked after", async () => {
    let configPath = "";
    let diff = "";
    const { h, runner, run, minted } = setup(async (job, app) => {
      const args = job.args;
      // Locked down to the run's server and nothing else.
      expect(args).toContain("--strict-mcp-config");
      configPath = args[args.indexOf("--mcp-config") + 1]!;
      expect(args[args.indexOf("--mcp-config") + 2]).toBe("--setting-sources");
      // The config sits outside the worktree the agent's file tools reach, readable by the user alone.
      expect(configPath.startsWith(job.cwd)).toBe(false);
      // Windows has no such mode bits.
      const otherAccess = process.platform === "win32" ? 0 : statSync(configPath).mode & 0o077;
      expect(otherAccess).toBe(0);
      const server = JSON.parse(readFileSync(configPath, "utf8")).mcpServers[RUN_SERVER_NAME];
      // Nothing in the argv or the environment carries the token: Claude Code reads it from the config alone.
      expect(args.join(" ")).not.toContain(server.headers.Authorization.slice("Bearer ".length));
      expect(job.env).not.toHaveProperty(RUN_TOKEN_ENV);
      // Its only way to read the PR is that server, so it connects it before the first turn.
      expect(job.env?.MCP_CONNECTION_NONBLOCKING).toBe("false");
      const client = await connect(app, server.url, server.headers);
      try {
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
          "pr_overview",
          "pr_files",
          "pr_diff",
          "pr_comments",
        ]);
        diff = await readWholeDiff(client);
      } finally {
        await client.close();
      }
      return JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: SESSION,
        total_cost_usd: 0.4,
        structured_output: { summary: "Reads fine.", issues: [] },
      });
    });
    const out = await runner.start(
      {
        run,
        prompt: "Review it",
        operation: "prReview",
        options: { runner: "headless" },
        access: "read-only",
        untrustedInput: true,
        outputSchema: PR_REVIEW_OUTPUT_SCHEMA,
        runTools: SCOPE,
        workspace: { branch: "feature" },
      },
      () => {},
    );
    expect(out.output).toEqual({ summary: "Reads fine.", issues: [] });
    expect(minted).toEqual([run.id]);
    expect(readInFull(diff)).toBe(true);
    expect(diff).toContain("+mod24 line 600");
    // Once the run is over, the token opens nothing and its config is gone.
    expect(h.integrations.runTools.tokens.size()).toBe(0);
    expect(existsSync(dirname(configPath))).toBe(false);
  });

  it("gives a Codex run the endpoint and its token through the environment, and revokes it when the run fails", async () => {
    const { h, runner, run } = setup(async (job, app) => {
      const url = /url="([^"]+)"/.exec(job.args.find((a) => a.includes(".url=")) ?? "")?.[1];
      expect(job.args).toContain("--ignore-user-config");
      expect(job.args).toContain(`mcp_servers.${RUN_SERVER_NAME}.bearer_token_env_var="${RUN_TOKEN_ENV}"`);
      const token = job.env?.[RUN_TOKEN_ENV];
      expect(token).toBeTruthy();
      expect(job.args.join(" ")).not.toContain(token!);
      const client = await connect(app, url!, { authorization: `Bearer ${token}` });
      try {
        expect(text(await client.callTool({ name: "pr_overview", arguments: {} }))).toContain("PR #7: Add modules");
      } finally {
        await client.close();
      }
      // The run ends badly: the turn never completes.
      return JSON.stringify({ type: "thread.started", thread_id: THREAD });
    });
    await expect(
      runner.start(
        {
          run,
          prompt: "Read it",
          operation: "taskRun",
          options: { runner: "headless", modelChoice: { provider: "codex", model: "gpt-5.5-codex" } },
          access: "read-only",
          runTools: SCOPE,
        },
        () => {},
      ),
    ).rejects.toThrow("Codex stopped");
    expect(h.integrations.runTools.tokens.size()).toBe(0);
  });

  it("never hands run tools to a provider that can't use them", async () => {
    const { h, runner, run } = setup(async () => {
      throw new Error("the agent must not start");
    });
    h.services.settings.update({ providers: [{ id: "copilot-cli", enabled: true }] });
    await expect(
      runner.start(
        {
          run,
          prompt: "Read it",
          operation: "taskRun",
          options: { runner: "headless" },
          access: "read-only",
          runTools: SCOPE,
        },
        () => {},
      ),
    ).rejects.toThrow("use the board's run tools");
    expect(h.integrations.runTools.tokens.size()).toBe(0);
  });
});
