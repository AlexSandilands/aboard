import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTestHarness } from "../test/harness.ts";

type Harness = ReturnType<typeof createTestHarness>;

async function connect(h: Harness, name = "implementer") {
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

describe("local review loop over MCP", () => {
  let h: Harness;
  let agent: Client;
  let taskRef: string;

  beforeEach(async () => {
    h = createTestHarness();
    agent = await connect(h);
    const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
    const task = h.services.tasks.create({
      projectId: project.id,
      title: "Add CSV export",
      plan: { phases: [{ title: "Build", steps: [{ title: "Export" }] }] },
    });
    taskRef = `#${task.number}`;
    h.services.tasks.move(task.id, { status: "in_progress" }, "implementer");
  });
  afterEach(async () => {
    await agent.close();
    h.db.close();
  });

  it("leaves move_task as it was when auto-review is off", async () => {
    const moved = await call(agent, "move_task", { task: taskRef, status: "review" });
    expect(moved.text).not.toContain("Local review");
    expect(h.services.reviews.list(h.services.tasks.resolveId(taskRef))).toEqual([]);
  });

  it("runs move, review, fix, re-review and ends clean", async () => {
    h.services.settings.update({ autoReview: true });
    const id = h.services.tasks.resolveId(taskRef);

    // 1. The move opens round 1 and tells the implementer how to run the loop.
    const moved = await call(agent, "move_task", { task: taskRef, status: "review" });
    expect(moved.text).toContain("round 1 is open, up to 3 rounds");
    expect(moved.text).toContain("Reviewer brief:");
    expect(moved.text).toContain(`submit_review(task: "${taskRef}", round: 1`);

    // The reviewer reads the task and is told it's the reviewer's turn, not to start another reviewer.
    const reviewer = await connect(h, "implementer");
    const seen = await call(reviewer, "get_task", { task: taskRef });
    expect(seen.text).toContain("Review round 1 is waiting for its reviewer.");
    expect(seen.text).not.toContain("Start a reviewer subagent");

    // 2. The reviewer submits findings.
    const submitted = await call(reviewer, "submit_review", {
      task: taskRef,
      round: 1,
      summary: "Export breaks on commas",
      headSha: "abc1234",
      findings: [
        {
          severity: "blocking",
          title: "Fields with commas aren't quoted",
          file: "src/export.ts",
          line: 40,
          body: "A title like `a, b` splits into two columns.",
          suggestion: "Quote fields per RFC 4180.",
        },
        { severity: "nit", title: "Rename `rows` to `records`", body: "They hold records, not rows." },
      ],
    });
    expect(submitted.text).toContain("Recorded round 1");
    expect(submitted.text).toContain("1 blocking, 1 nit");
    expect(h.services.reviews.list(id)[0]?.reviewer).toBe("agent (reviewer)");

    // 3. The implementer reads the findings and resolves them.
    const detail = await call(agent, "get_task", { task: taskRef });
    expect(detail.text).toContain("Local review: 1 open");
    expect(detail.text).toContain("R1.1 [blocking] src/export.ts:40 Fields with commas aren't quoted");
    expect(detail.text).toContain("Suggestion: Quote fields per RFC 4180.");

    const fixed = await call(agent, "resolve_finding", {
      task: taskRef,
      finding: "R1.1",
      status: "fixed",
      note: "Quoting added with a test",
    });
    expect(fixed.text).toContain("R1.1 marked fixed.");
    expect(fixed.text).toContain(`start_review("${taskRef}")`);
    expect(fixed.text).not.toContain("open the pull request");
    // Mid-loop there is no PR to ask for yet.
    expect((await call(agent, "get_task", { task: taskRef })).text).not.toContain("PR: the review loop is done");

    // 4. Round 2 with a fresh reviewer comes back clean, and the reviewer's reply says to open the PR.
    const second = await call(agent, "start_review", { task: taskRef });
    expect(second.text).toContain("Round 2 is open");
    expect(second.text).toContain(`round: 2`);
    const clean = await call(reviewer, "submit_review", { task: taskRef, findings: [] });
    expect(clean.text).toContain("implementing agent should open the pull request now");

    const summary = h.services.tasks.summary(id);
    expect(summary.review).toMatchObject({ state: "clean", round: 2, open: { blocking: 0, nit: 1 } });
    expect(summary.attention).toEqual([]);
    const final = await call(agent, "get_task", { task: taskRef, events: 20 });
    expect(final.text).toContain("Local review: Reviewed");
    expect(final.text).toContain("Still open from earlier rounds:");
    expect(final.text).toContain("They hold records, not rows.");
    expect(final.text).toContain("Resolved in earlier rounds:");
    expect(final.text).toContain(
      "R1.1 [blocking] src/export.ts:40 Fields with commas aren't quoted -> fixed: Quoting added with a test",
    );
    expect(final.text).toContain("finding R1.1 fixed: Quoting added with a test");
    expect(final.text).not.toContain("waiting for its reviewer");

    // 5. The loop is done with no PR linked: get_task asks for it until one is.
    expect(final.text).toContain("Missing links:");
    expect(final.text).toContain("PR: the review loop is done and no pull request is linked");
    await call(agent, "link", { task: taskRef, value: "https://github.com/acme/app/pull/3" });
    const linked = await call(agent, "get_task", { task: taskRef });
    expect(linked.text).not.toContain("PR: the review loop is done");
    await reviewer.close();
  });

  it("refuses rounds past the limit, and says to open the PR with the open findings", async () => {
    h.services.settings.update({ autoReview: true, reviewMaxRounds: 1 });
    await call(agent, "move_task", { task: taskRef, status: "review" });
    const submitted = await call(agent, "submit_review", {
      task: taskRef,
      findings: [{ severity: "major", title: "x" }],
    });
    expect(submitted.text).toContain("implementing agent should open the pull request now");
    const refused = await call(agent, "start_review", { task: taskRef });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("limit 1");
    expect(refused.text).toContain("open the pull request");
    expect(h.services.tasks.summary(h.services.tasks.resolveId(taskRef)).review?.state).toBe("stuck");

    const detail = await call(agent, "get_task", { task: taskRef });
    expect(detail.text).toContain("PR: the review loop is done");
    const resolved = await call(agent, "resolve_finding", {
      task: taskRef,
      finding: "R1.1",
      status: "fixed",
      note: "done",
    });
    expect(resolved.text).toContain("The review loop is done: open the pull request now");
  });

  it("doesn't ask for a PR when the review is off, still pending, or the task isn't in Review", async () => {
    const detail = () => call(agent, "get_task", { task: taskRef }).then((r) => r.text);
    await call(agent, "move_task", { task: taskRef, status: "review" });
    expect(await detail()).not.toContain("PR: the review loop");

    h.services.settings.update({ autoReview: true });
    await call(agent, "move_task", { task: taskRef, status: "in_progress" });
    await call(agent, "move_task", { task: taskRef, status: "review" });
    expect(await detail()).not.toContain("PR: the review loop");

    await call(agent, "submit_review", { task: taskRef, findings: [] });
    expect(await detail()).toContain("PR: the review loop is done");
    await call(agent, "move_task", { task: taskRef, status: "in_progress" });
    expect(await detail()).not.toContain("PR: the review loop");
  });

  it("follows a per-task override set through update_task", async () => {
    h.services.settings.update({ autoReview: true });
    await call(agent, "update_task", { task: taskRef, autoReview: false });
    const moved = await call(agent, "move_task", { task: taskRef, status: "review" });
    expect(moved.text).not.toContain("Local review");
  });

  it("doesn't open a round when merged PRs finish the task on entering Review", async () => {
    h.services.settings.update({ autoReview: true });
    const id = h.services.tasks.resolveId(taskRef);
    const link = h.services.links.add(id, { value: "https://github.com/acme/app/pull/3" }, "agent");
    h.services.links.setSnapshot(link.id, {
      state: "merged",
      title: "Export",
      checks: "passing",
      reviewDecision: null,
      mergeable: "unknown",
      headRef: null,
      updatedAt: null,
    });
    const moved = await call(agent, "move_task", { task: taskRef, status: "review" });
    expect(moved.text).toContain("already merged");
    expect(h.services.reviews.list(id)).toEqual([]);
  });
});
