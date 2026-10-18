import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createFakeGithub, fakePr, type FakePr } from "../test/fakeGithub.ts";
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

const PR_URL = "https://github.com/o/r/pull/7";
const failing = {
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: { nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }] },
          },
        },
      },
    ],
  },
};

describe("merge_task_pr", () => {
  let h: Harness;
  let gh: ReturnType<typeof createFakeGithub>;
  let agent: Client;

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await agent.callTool({ name, arguments: args })) as CallToolResult;
    return {
      isError: result.isError === true,
      text: result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"),
    };
  };

  /** A task in Review with PR #7 linked and polled as GitHub has it, auto-merge set as given. */
  const reviewTask = async (opts: { autoMerge?: boolean | null; pr?: Partial<FakePr> } = {}) => {
    const s = h.services;
    gh.prs.set("o/r#7", fakePr(opts.pr));
    const project = s.projects.list()[0] ?? s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
    const task = s.tasks.create({
      projectId: project.id,
      title: "Add the thing",
      plan: { phases: [{ title: "Do", steps: [{ title: "It", status: "done" }] }] },
      links: [{ value: PR_URL }],
      ...(opts.autoMerge !== undefined ? { autoMerge: opts.autoMerge } : {}),
    });
    s.tasks.update(task.id, { autoReview: false }, "user");
    s.tasks.move(task.id, { status: "review" }, "agent");
    await refresh(task.id);
    return task;
  };
  const linkOf = (taskId: string) => h.services.tasks.summary(taskId).links.find((l) => l.kind === "pr")!;
  const refresh = (taskId: string) => h.integrations.refreshLink(linkOf(taskId).id);
  const merges = () => gh.mutations.filter((m) => m.operation === "MergePullRequest");

  beforeEach(async () => {
    gh = createFakeGithub();
    h = createTestHarness({ integrations: { runGh: gh.runGh, githubFetch: gh.fetch } });
    agent = await connect(h);
  });
  afterEach(async () => {
    await agent.close();
    h.db.close();
  });

  it("merges a reviewed, green PR into the default branch when auto-merge is on, and the task goes Done", async () => {
    const task = await reviewTask({ autoMerge: true });
    const result = await call("merge_task_pr", { task: `#${task.number}` });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(`Merged PR #7 (${PR_URL}) into main with a squash merge.`);
    expect(merges()).toEqual([
      {
        operation: "MergePullRequest",
        input: { pullRequestId: "PR_o/r#7", mergeMethod: "SQUASH", expectedHeadOid: "head-1" },
      },
    ]);
    const after = h.services.tasks.summary(task.id);
    expect(after.status).toBe("done");
    expect(after.lastNote?.text).toMatch(/Merged PR #7 into main \(squash\) with merge_task_pr/);
  });

  it("uses the method asked for, and refuses one the repository doesn't allow", async () => {
    const task = await reviewTask({ autoMerge: true });
    const refused = await call("merge_task_pr", { task: `#${task.number}`, method: "rebase" });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain("doesn't allow rebase merges");
    expect(merges()).toEqual([]);
    expect(await call("merge_task_pr", { task: `#${task.number}`, method: "merge" })).toMatchObject({ isError: false });
    expect(merges()[0]!.input).toMatchObject({ mergeMethod: "MERGE" });
  });

  it("refuses unless the user turned auto-merge on for the task", async () => {
    for (const autoMerge of [undefined, null, false]) {
      const task = await reviewTask(autoMerge === undefined ? {} : { autoMerge });
      const result = await call("merge_task_pr", { task: `#${task.number}` });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("auto-merge isn't on for this task");
      expect(h.services.tasks.summary(task.id).status).toBe("review");
    }
    expect(merges()).toEqual([]);
  });

  it("refuses failing checks, a conflict, requested changes or a task not in Review", async () => {
    const cases: Array<{ pr: Partial<FakePr>; reason: RegExp }> = [
      { pr: failing, reason: /its checks are failing/ },
      { pr: { mergeable: "CONFLICTING" }, reason: /conflicts with main/ },
      { pr: { reviewDecision: "CHANGES_REQUESTED" }, reason: /requested changes/ },
      { pr: { reviewDecision: "REVIEW_REQUIRED" }, reason: /still needs an approving review/ },
      { pr: { isDraft: true }, reason: /isn't open and ready for review/ },
    ];
    for (const { pr, reason } of cases) {
      const task = await reviewTask({ autoMerge: true, pr });
      const result = await call("merge_task_pr", { task: `#${task.number}` });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(reason);
    }
    const planned = await reviewTask({ autoMerge: true });
    h.services.tasks.move(planned.id, { status: "in_progress" }, "agent");
    expect((await call("merge_task_pr", { task: `#${planned.number}` })).text).toContain("it isn't in Review");
    expect(merges()).toEqual([]);
  });

  it("refuses while the local review is going or left blocking or major findings open", async () => {
    const task = await reviewTask({ autoMerge: true });
    const s = h.services;
    s.tasks.update(task.id, { autoReview: true }, "user");
    s.tasks.move(task.id, { status: "in_progress" }, "agent");
    s.tasks.move(task.id, { status: "review" }, "agent");
    expect((await call("merge_task_pr", { task: `#${task.number}` })).text).toContain(
      "its local review is still going",
    );
    const round = s.reviews.list(task.id).at(-1)!;
    s.reviews.submit(task.id, { round: round.round, findings: [{ severity: "major", title: "Wrong" }] }, "reviewer");
    s.tasks.update(task.id, { autoReview: false }, "user");
    expect((await call("merge_task_pr", { task: `#${task.number}` })).text).toContain(
      "left blocking or major findings open",
    );
    expect(merges()).toEqual([]);
  });

  it("refuses a PR that moved past the head it checked, and shows the new head", async () => {
    const task = await reviewTask({ autoMerge: true });
    gh.prs.get("o/r#7")!.headRefOid = "head-2";
    const result = await call("merge_task_pr", { task: `#${task.number}` });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^CONFLICT: .*moved on to head-2/);
    expect(merges()).toEqual([]);
    expect(linkOf(task.id)).toMatchObject({ snapshot: { headOid: "head-2" } });
    expect(h.services.tasks.summary(task.id).status).toBe("review");
  });

  it("never merges past a branch rule, even when the account could (an admin's)", async () => {
    const task = await reviewTask({ autoMerge: true, pr: { mergeStateStatus: "BLOCKED" } });
    const result = await call("merge_task_pr", { task: `#${task.number}` });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("can't be merged yet (BLOCKED)");
    expect(merges()).toEqual([]);
    expect(h.services.tasks.summary(task.id).status).toBe("review");
    // Still being computed (just after a push): wait, rather than a branch rule.
    gh.prs.get("o/r#7")!.mergeStateStatus = "UNKNOWN";
    expect((await call("merge_task_pr", { task: `#${task.number}` })).text).toContain("try again in a minute");
    expect(merges()).toEqual([]);
  });

  it("never merges into a branch other than the default branch", async () => {
    const task = await reviewTask({ autoMerge: true, pr: { baseRefName: "release" } });
    const result = await call("merge_task_pr", { task: `#${task.number}` });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("merge_task_pr only merges into the default branch");
    expect(merges()).toEqual([]);
  });

  it("refuses a task with no open PR, or more than one", async () => {
    const task = await reviewTask({ autoMerge: true });
    h.services.links.add(task.id, { value: "https://github.com/o/r/pull/8" }, "agent");
    expect((await call("merge_task_pr", { task: `#${task.number}` })).text).toContain("2 open pull requests");
    const bare = h.services.tasks.create({ projectId: task.projectId, title: "No PR", autoMerge: true });
    expect((await call("merge_task_pr", { task: `#${bare.number}` })).text).toContain("no open pull request");
    expect(merges()).toEqual([]);
  });

  it("leaves a task in an integration epic to Autopilot's merge into the epic's branch", async () => {
    const task = await reviewTask({ autoMerge: true });
    const s = h.services;
    const epic = s.tasks.createEpic({ projectId: task.projectId, title: "Checkout" }, [task.id], "user");
    s.tasks.setDelivery(epic.id, "integration", "epic/2-checkout", "user");
    const result = await call("merge_task_pr", { task: `#${task.number}` });
    expect(result.text).toContain("Autopilot merges its pull request there");
    expect(merges()).toEqual([]);
  });

  it("sets the flag over MCP and shows it in the task", async () => {
    const created = await call("add_to_backlog", { title: "Flag me", workspacePath: "C:/Fake/proj" });
    const ref = /#(\d+)/.exec(created.text)![0];
    expect((await call("update_task", { task: ref, autoMerge: "on" })).text).toContain("Auto-merge: on");
    expect((await call("update_task", { task: ref, autoMerge: "off" })).text).toContain("Auto-merge: off");
    expect((await call("update_task", { task: ref, autoMerge: "default" })).text).not.toContain("Auto-merge:");
  });
});
