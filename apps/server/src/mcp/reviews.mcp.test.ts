import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AUTOPILOT_REVIEW_PRS } from "@repo/contracts";
import { createRepos } from "../db/repos/index.ts";
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
    // The last gating finding is resolved: the board opened round 2 itself.
    expect(fixed.text).toContain("The board opened review round 2");
    expect(fixed.text).toContain(`start_review("${taskRef}")`);
    expect(fixed.text).not.toContain("open the pull request");
    expect(h.services.reviews.list(id)[1]).toMatchObject({ round: 2, status: "pending", openedBy: "board" });
    // Mid-loop there is no PR to ask for yet.
    expect((await call(agent, "get_task", { task: taskRef })).text).not.toContain("PR: the review loop has ended");

    // 4. start_review hands over the brief of that round (it doesn't open a third); a fresh reviewer finds it clean,
    // and the reviewer's reply says to open the PR.
    const second = await call(agent, "start_review", { task: taskRef });
    expect(second.text).toContain("Round 2 is open");
    expect(h.services.reviews.list(id)).toHaveLength(2);
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
    expect(final.text).toContain("PR: the review loop has ended and no pull request is linked");
    await call(agent, "link", { task: taskRef, value: "https://github.com/acme/app/pull/3" });
    const linked = await call(agent, "get_task", { task: taskRef });
    expect(linked.text).not.toContain("PR: the review loop has ended");
    await reviewer.close();
  });

  it("tells an agent whose PR is already linked to finish the loop first and push fixes to it", async () => {
    h.services.settings.update({ autoReview: true });
    await call(agent, "link", { task: taskRef, value: "https://github.com/acme/app/pull/3" });
    const moved = await call(agent, "move_task", { task: taskRef, status: "review" });
    expect(moved.text).toContain("A pull request is already linked. Finish the local review loop below first");
    expect(moved.text).toContain("Local review is on for this task: round 1 is open");

    // Without a linked PR the result doesn't say it.
    await call(agent, "move_task", { task: taskRef, status: "in_progress" });
    const prLink = h.services.tasks.summary(h.services.tasks.resolveId(taskRef)).links.find((l) => l.kind === "pr")!;
    h.services.links.remove(prLink.id, "agent");
    const again = await call(agent, "move_task", { task: taskRef, status: "review" });
    expect(again.text).not.toContain("A pull request is already linked. Finish");
  });

  it("warns when a PR is linked before the loop ended, and only then", async () => {
    const pr = "https://github.com/acme/app/pull/3";
    // Auto-review off: no loop to wait for.
    const off = await call(agent, "link", { task: taskRef, value: pr });
    expect(off.text).not.toContain("before the review loop ended");
    await call(agent, "unlink", { task: taskRef, value: pr });

    h.services.settings.update({ autoReview: true });
    const early = await call(agent, "link", { task: taskRef, value: pr });
    expect(early.text).toContain("Linked to");
    expect(early.text).toContain("this PR was opened before the review loop ended");
    expect(early.text).toContain("Finish the loop first");
    await call(agent, "unlink", { task: taskRef, value: pr });

    // In Review with a round still open it is just as early; once the loop is clean it isn't.
    await call(agent, "move_task", { task: taskRef, status: "review" });
    const inLoop = await call(agent, "link", { task: taskRef, value: pr });
    expect(inLoop.text).toContain("before the review loop ended");
    await call(agent, "unlink", { task: taskRef, value: pr });
    await call(agent, "submit_review", { task: taskRef, round: 1, findings: [] });
    const after = await call(agent, "link", { task: taskRef, value: pr });
    expect(after.text).not.toContain("before the review loop ended");
  });

  it("refuses rounds past the limit, and says to open the PR with the open findings", async () => {
    h.services.settings.update({ autoReview: true, reviewMaxRounds: 1 });
    await call(agent, "move_task", { task: taskRef, status: "review" });
    const submitted = await call(agent, "submit_review", {
      task: taskRef,
      findings: [{ severity: "major", title: "x" }],
    });
    expect(submitted.text).toContain("No further round is allowed");
    expect(submitted.text).not.toContain("open the pull request now");
    const refused = await call(agent, "start_review", { task: taskRef });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("limit 1");
    expect(refused.text).toContain("open the pull request");
    expect(h.services.tasks.summary(h.services.tasks.resolveId(taskRef)).review?.state).toBe("stuck");

    const detail = await call(agent, "get_task", { task: taskRef });
    expect(detail.text).toContain("PR: the review loop has ended");
    const resolved = await call(agent, "resolve_finding", {
      task: taskRef,
      finding: "R1.1",
      status: "fixed",
      note: "done",
    });
    expect(resolved.text).toContain("The review loop is done: open the pull request now");
  });

  it("at the limit, doesn't say to open the PR now while blocking or major findings are unaddressed", async () => {
    h.services.settings.update({ autoReview: true, reviewMaxRounds: 1 });
    await call(agent, "move_task", { task: taskRef, status: "review" });
    await call(agent, "submit_review", {
      task: taskRef,
      findings: [
        { severity: "major", title: "a" },
        { severity: "major", title: "b" },
      ],
    });
    const first = await call(agent, "resolve_finding", { task: taskRef, finding: "R1.1", status: "fixed" });
    expect(first.text).toContain("1 blocking/major finding still open");
    expect(first.text).toContain("fix or wont_fix what's still open, then open the pull request");
    expect(first.text).not.toContain("open the pull request now");
    const second = await call(agent, "resolve_finding", { task: taskRef, finding: "R1.2", status: "fixed" });
    expect(second.text).toContain("open the pull request now");
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
    expect(await detail()).toContain("PR: the review loop has ended");
    await call(agent, "move_task", { task: taskRef, status: "in_progress" });
    expect(await detail()).not.toContain("PR: the review loop");
  });

  it("get_task says no PR is expected yet mid-loop, asks for one once the loop ends, and neither once it is linked", async () => {
    const detail = () => call(agent, "get_task", { task: taskRef }).then((r) => r.text);
    const notYet = "PR: none is expected yet";
    const ended = "PR: the review loop has ended";

    // Auto-review off: there is no loop to wait for, so no line about one.
    await call(agent, "move_task", { task: taskRef, status: "review" });
    expect(await detail()).not.toContain(notYet);
    await call(agent, "move_task", { task: taskRef, status: "in_progress" });

    h.services.settings.update({ autoReview: true });
    await call(agent, "move_task", { task: taskRef, status: "review" });
    // Round 1 is open (pending or running), whatever the age of the task's last activity.
    let text = await detail();
    expect(text).toContain(notYet);
    // The reviewer reads get_task too: only the "Local review" pointer says who calls start_review.
    expect(text.split("\n").find((l) => l.includes(notYet))).not.toContain("start_review");
    expect(text).not.toContain(ended);

    // A round nobody picked up (stalled) is still the loop going.
    const roundId = h.services.reviews.list(h.services.tasks.resolveId(taskRef))[0]!.id;
    h.services.reviews.setRoundStatus(roundId, "stalled", { actor: "board", from: ["pending", "running"] });
    text = await detail();
    expect(text).toContain("Needs review");
    expect(text).toContain(notYet);
    expect(text).not.toContain(ended);
    h.services.reviews.setRoundStatus(roundId, "pending", { actor: "board" });

    // Findings open with rounds left keep the loop going.
    await call(agent, "submit_review", { task: taskRef, findings: [{ severity: "major", title: "x" }] });
    text = await detail();
    expect(text).toContain(notYet);
    expect(text).not.toContain(ended);

    await call(agent, "resolve_finding", { task: taskRef, finding: "R1.1", status: "wont_fix", note: "fine" });
    await call(agent, "submit_review", { task: taskRef, findings: [] });
    text = await detail();
    expect(text).toContain(ended);
    expect(text).not.toContain(notYet);

    await call(agent, "link", { task: taskRef, value: "https://github.com/acme/app/pull/3" });
    text = await detail();
    expect(text).not.toContain(ended);
    expect(text).not.toContain(notYet);
  });

  it("says in get_task when fixes made at the round limit won't be re-reviewed, or were re-reviewed on the PR", async () => {
    h.services.settings.update({ reviewMaxRounds: 1 });
    const id = h.services.tasks.resolveId(taskRef);
    h.services.reviews.submit(id, { findings: [{ severity: "major", title: "Unquoted fields" }] }, "reviewer");
    h.services.reviews.resolveFinding(id, "R1.1", { status: "fixed" }, "agent");
    const atLimit = "The fixes were made in the last allowed round, so no round will re-review them.";
    const onPr = "The fixes were re-reviewed on the pull request";

    const before = (await call(agent, "get_task", { task: taskRef })).text;
    expect(before).toContain("Local review: Fixed at round limit");
    expect(before).toContain(atLimit);
    expect(before).not.toContain(onPr);

    // Autopilot's PR review starts after the fix and comes back clean.
    const start = new Date(Date.now() + 60_000).toISOString();
    createRepos(h.db).autopilotRuns.insert({
      id: "run-1",
      automation: AUTOPILOT_REVIEW_PRS,
      taskId: id,
      projectId: h.services.tasks.summary(id).projectId,
      dedupeKey: "review:pr:l:abc",
      status: "succeeded",
      summary: "",
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
      output: { kind: "pr_review", handoff: "clean", counts: { blocking: 0, major: 0, minor: 0, nit: 0 } },
      model: null,
      createdAt: start,
      startedAt: start,
      finishedAt: start,
      updatedAt: start,
    });
    const after = (await call(agent, "get_task", { task: taskRef })).text;
    expect(after).toContain("Local review: Reviewed");
    expect(after).toContain(onPr);
    expect(after).not.toContain(atLimit);
  });

  it("follows a per-task override set through update_task", async () => {
    h.services.settings.update({ autoReview: true });
    await call(agent, "update_task", { task: taskRef, autoReview: false });
    const moved = await call(agent, "move_task", { task: taskRef, status: "review" });
    expect(moved.text).not.toContain("Local review");
  });

  it("names the reviewer's model in the loop once update_task sets one", async () => {
    h.services.settings.update({ autoReview: true });
    await call(agent, "update_task", { task: taskRef, reviewModel: "claude-code:claude-opus-5-5" });
    const moved = await call(agent, "move_task", { task: taskRef, status: "review" });
    expect(moved.text).toContain('Run the reviewer on `claude-opus-5-5`: in Claude Code pass `model: "opus"`');
    await call(agent, "update_task", { task: taskRef, reviewModel: "deep" });
    expect(h.services.tasks.summary(h.services.tasks.resolveId(taskRef)).reviewModel).toEqual({ tier: "deep" });
    await call(agent, "update_task", { task: taskRef, reviewModel: null });
    expect(h.services.tasks.summary(h.services.tasks.resolveId(taskRef)).reviewModel).toBeNull();
    expect((await call(agent, "update_task", { task: taskRef, reviewModel: "a b" })).isError).toBe(true);
  });

  it("refuses a bare model id for reviewModel, naming the added providers to put in front of it", async () => {
    h.services.settings.update({
      providers: [
        { id: "claude-code", enabled: true },
        { id: "codex", enabled: true },
        { id: "copilot-cli", enabled: false },
      ],
      modelProfiles: [{ id: "fast", name: "Fast", labels: [], description: null, t3: null }],
    });
    const bare = await call(agent, "update_task", { task: taskRef, reviewModel: "gpt-5.5" });
    expect(bare.isError).toBe(true);
    expect(bare.text).toContain('name its provider: "claude-code:gpt-5.5" or "codex:gpt-5.5"');
    await call(agent, "update_task", { task: taskRef, reviewModel: "codex:gpt-5.5" });
    const id = h.services.tasks.resolveId(taskRef);
    expect(h.services.tasks.summary(id).reviewModel).toEqual({ provider: "codex", model: "gpt-5.5" });
    await call(agent, "update_task", { task: taskRef, reviewModel: "fast" });
    expect(h.services.tasks.summary(id).reviewModel).toEqual({ profile: "fast" });
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
