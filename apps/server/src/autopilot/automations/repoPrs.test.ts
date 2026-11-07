import {
  AUTOPILOT_REVIEW_PRS,
  parseReviewMarker,
  prReviewHeader,
  RepoPrReviewRunOutput,
  type PrReviewIssue,
  type RepoPrReviewVerdict,
} from "@repo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StaleReviewError, type PostReviewInput, type PostedComment, type RepoPr } from "../../integrations/gitHost.ts";
import { NO_GIT_HOSTS, type GitHostActions } from "../../integrations/gitHosts.ts";
import { createTestHarness } from "../../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import type { Runner, RunnerRequest, RunnerResult } from "../types.ts";
import { reviewMarker } from "@repo/contracts";
import { otherPrsPolled, renderHandoff, resetOtherPrsPolls, settleDecision } from "./repoPrs.ts";
import { reviewPrs } from "./reviewPrs.ts";

const ME = "owner";
const A = "a".repeat(40);
const B = "b".repeat(40);
const URL42 = "https://github.com/acme/app/pull/42";
const hourAgo = () => new Date(Date.now() - 60 * 60_000).toISOString();

function basePr(over: Partial<RepoPr> = {}): RepoPr {
  return {
    number: 42,
    url: URL42,
    title: "Add the thing",
    author: "alice",
    draft: false,
    state: "open",
    headOid: A,
    headRef: "feat/thing",
    baseRef: "main",
    isCrossRepository: false,
    viewer: ME,
    closingIssues: [5],
    referencingIssues: [50],
    files: { total: 1, paths: ["src/thing.ts"] },
    commits: [{ oid: A, committedDate: hourAgo(), parents: 1 }],
    checks: { pending: [], failing: [], missing: [], latestAt: hourAgo() },
    latestReviews: [],
    reviews: [],
    comments: [],
    threads: [],
    dismissals: [],
    ...over,
  };
}

const major = (over: Partial<PrReviewIssue> = {}): PrReviewIssue => ({
  severity: "major",
  title: "Races on save",
  file: "src/thing.ts",
  line: 3,
  body: "Two saves interleave.",
  suggestion: "Hold the lock.",
  fyi: false,
  ...over,
});

const engines: AutopilotEngine[] = [];
beforeEach(() => resetOtherPrsPolls());
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
});

function setup() {
  let pr = basePr();
  let live: string | null = null;
  let verdict: RepoPrReviewVerdict = { decision: "approve", summary: "Does what #5 asks.", issues: [] };
  const requests: RunnerRequest[] = [];
  const reviews: PostReviewInput[] = [];
  const comments: Array<{ edit: string | null; body: string }> = [];
  const replies: Array<{ threadId: string; body: string }> = [];
  const resolved: string[] = [];
  /** The heads prHead answers in turn (the last repeats); empty is the PR's own head. */
  let heads: string[] = [];
  /** Runs while the agent reviews: what changes on GitHub between the poll and the post. */
  let duringReview: (() => void) | null = null;
  let postErrors: string[] = [];
  let landThenFail = false;
  let readErrors: string[] = [];
  let reads = 0;
  let onRead: ((n: number) => void) | null = null;
  const runner: Runner = {
    start: async (request): Promise<RunnerResult> => {
      requests.push(request);
      duringReview?.();
      return { runner: "headless", result: null, output: verdict };
    },
  };
  let commentId = 900;
  const posted = (): PostedComment => {
    commentId += 1;
    return { id: commentId, nodeId: `IC_${commentId}`, url: `${URL42}#issuecomment-${commentId}` };
  };
  const gitHosts: GitHostActions = {
    ...NO_GIT_HOSTS,
    listOpenPrs: async () => [{ number: pr.number, author: pr.author, draft: pr.draft }],
    readRepoPr: async () => {
      reads += 1;
      onRead?.(reads);
      if (readErrors.length > 0) throw new Error(readErrors.shift());
      return pr;
    },
    unchangedSince: async () => false,
    prHead: async () => (heads.length > 1 ? heads.shift()! : (heads[0] ?? live ?? pr.headOid)),
    postReview: async (_ref, input) => {
      const head = heads[0] ?? live ?? pr.headOid;
      if (!head.startsWith(input.reviewedSha)) throw new StaleReviewError(head, input.reviewedSha);
      const failure = postErrors.shift();
      if (failure) throw new Error(failure);
      reviews.push(input);
      return {
        id: 500 + reviews.length,
        url: `${URL42}#pullrequestreview-${500 + reviews.length}`,
        headOid: head,
        folded: 0,
      };
    },
    postComment: async (_ref, body) => {
      comments.push({ edit: null, body });
      const done = posted();
      if (landThenFail) {
        // GitHub kept it, then answered with an error.
        pr = {
          ...pr,
          comments: [
            ...pr.comments,
            {
              id: done.id,
              nodeId: done.nodeId,
              url: done.url,
              author: ME,
              body,
              createdAt: new Date(Date.now() + 1000).toISOString(),
              editedAt: null,
            },
          ],
        };
        throw new Error("HTTP 502: try again");
      }
      return done;
    },
    editComment: async (_host, nodeId, body) => {
      comments.push({ edit: nodeId, body });
      return { id: Number(nodeId.slice(3)), nodeId, url: `${URL42}#issuecomment-${nodeId.slice(3)}` };
    },
    replyOnThread: async (_host, threadId, body) => {
      replies.push({ threadId, body });
    },
    resolveReviewThread: async (_host, threadId) => {
      resolved.push(threadId);
    },
  };
  const h = createTestHarness({ integrations: { automations: [reviewPrs] } });
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    runner,
    gitHosts,
    repoOf: async () => ({ host: "github.com", repo: "acme/app" }),
    debounceMs: 5,
    tickMs: 1_000_000,
    log: { warn: () => {} },
  });
  engines.push(engine);
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const turnOn = (config: Record<string, unknown> = {}) =>
    s.autopilot.setScope("project", project.id, AUTOPILOT_REVIEW_PRS, {
      mode: "on",
      config: { otherPrs: true, otherAuthors: "alice", otherApprove: true, ...config },
    });
  /** One pass that reads the repository afresh, then the pass that acts on what it found. */
  const pass = async () => {
    resetOtherPrsPolls();
    await engine.pass();
    await otherPrsPolled();
    await engine.pass();
    await engine.idle();
  };
  const runs = () => s.autopilot.automationRunsForProject(AUTOPILOT_REVIEW_PRS, project.id);
  const lastOutput = () => RepoPrReviewRunOutput.parse(runs()[0]!.output);
  return {
    s,
    project,
    requests,
    reviews,
    comments,
    replies,
    resolved,
    turnOn,
    pass,
    runs,
    lastOutput,
    setPr: (next: Partial<RepoPr>) => (pr = { ...pr, ...next }),
    answer: (next: RepoPrReviewVerdict) => (verdict = next),
    setHeads: (next: string[]) => (heads = next),
    whileReviewing: (fn: (() => void) | null) => (duringReview = fn),
    failPosts: (...messages: string[]) => (postErrors = messages),
    failReads: (...messages: string[]) => (readErrors = messages),
    landThenFail: (on: boolean) => (landThenFail = on),
    onRead: (fn: ((n: number) => void) | null) => {
      reads = 0;
      onRead = fn;
    },
    setLive: (sha: string | null) => (live = sha),
    state: () => s.repoPrReviews.get("github.com", "acme/app", 42),
  };
}

describe("other people's PRs: approving", () => {
  it("approves a clean PR when the gate passes, as a review with the marker", async () => {
    const t = setup();
    t.turnOn();
    await t.pass();
    expect(t.requests).toHaveLength(1);
    const request = t.requests[0]!;
    expect(request).toMatchObject({
      access: "read-only",
      untrustedInput: true,
      runTools: { toolSet: "repoPrReview", target: { kind: "pr", host: "github.com", repo: "acme/app", number: 42 } },
      checkout: { branch: "feat/thing", tag: "pr42" },
      expectHead: A,
      repo: "/work/alpha",
    });
    expect(request.prompt).toContain("Open issues that mention it (often a bug report against it, read each one): #50");
    expect(request.prompt).toContain("Concurrency and contracts");
    expect(t.reviews).toHaveLength(1);
    expect(t.reviews[0]!.event).toBe("approve");
    expect(t.reviews[0]!.body.startsWith(prReviewHeader())).toBe(true);
    expect(parseReviewMarker(t.reviews[0]!.body)).toMatchObject({
      head: A,
      verdict: "approve",
      counted: "1",
      round: "1",
    });
    expect(t.lastOutput()).toMatchObject({ outcome: "approved", mode: "full", round: 1, counted: true });
    expect(t.state()).toMatchObject({ outcome: "approved", readySince: null, headOid: A });
  });

  it("never approves when the gate fails: a clean PR waits for the user, with no task and no ping", async () => {
    const t = setup();
    t.turnOn();
    t.setPr({ files: { total: 2, paths: ["src/thing.ts", ".github/workflows/ci.yml"] } });
    await t.pass();
    expect(t.reviews).toHaveLength(0);
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0]!.body).toContain(
      `**Ready for @${ME}'s approval:** touches sensitive paths: .github/workflows/ci.yml`,
    );
    expect(parseReviewMarker(t.comments[0]!.body)).toMatchObject({ event: "escalated", reason: "gate", head: A });
    expect(t.lastOutput()).toMatchObject({ outcome: "ready", reason: "gate" });
    // No manual task; a Needs you item and a notification instead.
    expect(t.s.tasks.summaries({ projectId: t.project.id })).toHaveLength(0);
    expect(t.s.autopilot.overview().needsYou).toContainEqual(
      expect.objectContaining({ kind: "pr_approval", pr: "acme/app#42", url: URL42, author: "alice" }),
    );
    expect(t.s.notifications.list().items[0]).toMatchObject({
      kind: "pr_ready",
      title: "Ready for your approval: acme/app#42",
    });
  });

  it("with Approve off, a clean PR waits for the user too", async () => {
    const t = setup();
    t.turnOn({ otherApprove: false });
    await t.pass();
    expect(t.reviews).toHaveLength(0);
    expect(t.comments[0]!.body).toContain("Approve is off");
    expect(t.state()?.readySince).not.toBeNull();
  });

  it("takes the PR off Needs you once a person approved it", async () => {
    const t = setup();
    t.turnOn({ otherApprove: false });
    await t.pass();
    expect(t.state()?.readySince).not.toBeNull();
    t.setPr({ latestReviews: [{ author: ME, state: "APPROVED", body: "LGTM" }] });
    await t.pass();
    expect(t.state()?.readySince).toBeNull();
    expect(t.s.autopilot.overview().needsYou.filter((n) => n.kind === "pr_approval")).toHaveLength(0);
  });
});

describe("other people's PRs: facts read again before posting", () => {
  it("doesn't approve when a required check turned red after the poll: the PR waits for the user", async () => {
    const t = setup();
    t.turnOn();
    t.whileReviewing(() => t.setPr({ checks: { pending: [], failing: ["test"], missing: [], latestAt: hourAgo() } }));
    await t.pass();
    expect(t.reviews).toHaveLength(0);
    expect(t.comments[0]!.body).toContain("required checks not green: test");
    expect(t.lastOutput()).toMatchObject({ outcome: "ready" });
  });

  it("posts nothing when the user stopped it or a person reviewed it meanwhile", async () => {
    for (const change of [
      {
        comments: [
          {
            id: 7,
            nodeId: "IC_7",
            url: URL42,
            author: ME,
            body: "/autopilot stop",
            createdAt: hourAgo(),
            editedAt: null,
          },
        ],
      },
      { latestReviews: [{ author: "carol", state: "CHANGES_REQUESTED", body: "No" }] },
    ] satisfies Array<Partial<RepoPr>>) {
      const t = setup();
      t.turnOn();
      t.whileReviewing(() => t.setPr(change));
      await t.pass();
      expect(t.reviews).toHaveLength(0);
      expect(t.comments).toHaveLength(0);
      expect(t.runs()[0]).toMatchObject({ status: "skipped" });
    }
  });

  it("doesn't approve while a required check re-run during the review is still running", async () => {
    const t = setup();
    t.turnOn();
    t.whileReviewing(() => t.setPr({ checks: { pending: ["test"], failing: [], missing: [], latestAt: hourAgo() } }));
    await t.pass();
    expect(t.reviews).toHaveLength(0);
    expect(t.comments[0]!.body).toContain("required checks still running: test");
  });

  it("tries again when GitHub fails in passing while the PR is read again before posting", async () => {
    const t = setup();
    t.turnOn();
    // The poll's read succeeds; the one before the post fails once.
    t.onRead((n) => {
      if (n === 2) t.failReads("HTTP 502: try again");
    });
    await t.pass();
    expect(t.runs()[0]).toMatchObject({ status: "skipped", output: { retry: true } });
    t.onRead(null);
    await t.pass();
    expect(t.reviews).toHaveLength(1);
  });

  it("doesn't post again when GitHub took a post but answered with an error", async () => {
    const t = setup();
    t.turnOn({ otherApprove: false });
    t.landThenFail(true);
    await t.pass();
    expect(t.runs()[0]).toMatchObject({ status: "skipped", output: { retry: true } });
    t.landThenFail(false);
    await t.pass();
    // The comment that landed is the hand-off at this head: nothing is posted again.
    expect(t.comments).toHaveLength(1);
    expect(t.runs().filter((r) => r.status === "failed")).toHaveLength(0);
  });

  it("tries a post GitHub failed on in passing again on the next pass", async () => {
    const t = setup();
    t.turnOn();
    t.failPosts("HTTP 502: try again");
    await t.pass();
    expect(t.runs()[0]).toMatchObject({ status: "skipped", output: { retry: true } });
    await t.pass();
    expect(t.reviews).toHaveLength(1);
    expect(t.runs().map((r) => r.dedupeKey.endsWith(":a2"))).toContain(true);
  });
});

describe("other people's PRs: waiting for the user's approval", () => {
  it("looks again, and approves, once the gate passes at the same head", async () => {
    const t = setup();
    t.turnOn();
    t.setPr({ checks: { pending: [], failing: ["test"], missing: [], latestAt: hourAgo() } });
    await t.pass();
    expect(t.state()?.readySince).not.toBeNull();
    // The check is re-run green; the PR now carries Autopilot's Ready comment.
    t.setPr({
      checks: { pending: [], failing: [], missing: [], latestAt: hourAgo() },
      comments: [
        {
          id: 901,
          nodeId: "IC_901",
          url: URL42,
          author: ME,
          body: t.comments[0]!.body,
          createdAt: hourAgo(),
          editedAt: null,
        },
      ],
    });
    await t.pass();
    // A fresh look, not the old review: threads or issues may have come since. It uses no round.
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1]!.prompt).toContain("only the approval gate held it; the gate passes now");
    expect(t.reviews).toHaveLength(1);
    expect(t.reviews[0]!.event).toBe("approve");
    expect(parseReviewMarker(t.reviews[0]!.body)).toMatchObject({ verdict: "approve", counted: "0" });
    expect(t.state()).toMatchObject({ outcome: "approved", readySince: null });
  });

  it("looks again on a later pass after the same check failed again at the moment it tried", async () => {
    const t = setup();
    t.turnOn();
    const failing = { checks: { pending: [], failing: ["test"], missing: [], latestAt: hourAgo() } };
    const passing = { checks: { pending: [], failing: [], missing: [], latestAt: hourAgo() } };
    t.setPr(failing);
    await t.pass();
    t.setPr({
      ...passing,
      comments: [
        {
          id: 901,
          nodeId: "IC_901",
          url: URL42,
          author: ME,
          body: t.comments[0]!.body,
          createdAt: hourAgo(),
          editedAt: null,
        },
      ],
    });
    // The poll sees it pass; by the read before the post it failed again (a flaky check).
    t.onRead((n) => {
      if (n === 2) t.setPr(failing);
    });
    await t.pass();
    expect(t.reviews).toHaveLength(0);
    // Its Ready comment is edited, not posted again.
    expect(t.comments.at(-1)!.edit).not.toBeNull();
    expect(t.state()?.reasonDetail).toBe("required checks not green: test");
    t.onRead(null);
    t.setPr(passing);
    await t.pass();
    expect(t.reviews.map((r) => r.event)).toEqual(["approve"]);
  });

  it("keeps the reason it waits for current when the gate changes without a push", async () => {
    const t = setup();
    t.turnOn({ otherApprove: true });
    t.setPr({ checks: { pending: [], failing: ["test"], missing: [], latestAt: hourAgo() } });
    await t.pass();
    t.setPr({
      checks: { pending: [], failing: ["lint"], missing: [], latestAt: hourAgo() },
      comments: [
        {
          id: 901,
          nodeId: "IC_901",
          url: URL42,
          author: ME,
          body: t.comments[0]!.body,
          createdAt: hourAgo(),
          editedAt: null,
        },
      ],
    });
    await t.pass();
    expect(t.state()?.reasonDetail).toBe("required checks not green: lint");
    expect(t.reviews).toHaveLength(0);
  });

  it("drops the PR from Needs you once the source is off or its author left the list", async () => {
    const t = setup();
    t.turnOn({ otherApprove: false });
    await t.pass();
    const listed = () => t.s.autopilot.overview().needsYou.filter((n) => n.kind === "pr_approval");
    expect(listed()).toHaveLength(1);
    t.turnOn({ otherApprove: false, otherAuthors: "bob" });
    expect(listed()).toHaveLength(0);
    t.turnOn({ otherApprove: false });
    expect(listed()).toHaveLength(1);
    t.turnOn({ otherPrs: false });
    expect(listed()).toHaveLength(0);
  });

  it("uses no round for a ready-for-approval the reviewer calls a small re-check", async () => {
    const t = setup();
    t.turnOn({ otherApprove: false });
    t.setPr({
      headOid: B,
      comments: [
        {
          id: 901,
          nodeId: "IC_901",
          url: URL42,
          author: ME,
          body: renderHandoff({
            summary: "Clean.",
            issues: [],
            viewer: ME,
            reason: "gate",
            why: "Approve is off",
            checklist: [],
            round: 1,
            maxRounds: 3,
            headOid: A,
          }),
          createdAt: hourAgo(),
          editedAt: null,
        },
      ],
    });
    t.answer({ decision: "approve", summary: "Only answers the earlier point.", issues: [], counted: false });
    await t.pass();
    expect(t.requests[0]!.prompt).toContain("Mode: **followup**");
    expect(parseReviewMarker(t.comments[0]!.body)).toMatchObject({ counted: "0" });
  });
});

describe("other people's PRs: changes and hand-offs", () => {
  it("asks for changes with blocking and major points inline, and an agent's approval with one open is not one", async () => {
    const t = setup();
    t.turnOn();
    t.answer({
      decision: "approve",
      summary: "Mostly fine.",
      issues: [major(), { ...major(), severity: "nit", title: "Name" }],
    });
    await t.pass();
    expect(t.reviews).toHaveLength(1);
    const review = t.reviews[0]!;
    expect(review.event).toBe("request_changes");
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]!.body).toContain("**Races on save**");
    expect(parseReviewMarker(review.comments[0]!.body)).toEqual({ finding: "" });
    // The nit is FYI, never a point.
    expect(review.body).toContain("### FYI (no action needed)");
    expect(t.lastOutput()).toMatchObject({ outcome: "changes_requested" });
  });

  it("hands a departure to the user: a manual task with the PR and a checklist, a ping, one comment", async () => {
    const t = setup();
    t.turnOn();
    t.answer({
      decision: "escalate",
      summary: "It reverses the caching decision.",
      issues: [],
      escalation: { reason: "departure", why: "It drops the cache ADR 12 chose", checklist: ["src/cache.ts:10-40"] },
    });
    await t.pass();
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0]!.body).toContain(`**Handed to @${ME} for manual review**`);
    const [task] = t.s.tasks.summaries({ projectId: t.project.id });
    expect(task).toMatchObject({ title: "Review PR #42: Add the thing", manual: true, labels: ["review"] });
    expect(task!.links.some((l) => l.kind === "pr" && l.url === URL42)).toBe(true);
    expect(task!.attentionRequest?.message).toBe("PR #42: It drops the cache ADR 12 chose");
    expect(t.s.tasks.detail(task!.id).description).toContain("- [ ] src/cache.ts:10-40");
    expect(t.state()).toMatchObject({ outcome: "escalated", reason: "departure", taskId: task!.id });

    // The author pushes; the reason still holds: the comment is edited, the task gets a note, and nobody is pinged again.
    const handoff = { ...t.comments[0]! };
    t.setPr({
      headOid: B,
      commits: [
        { oid: A, committedDate: hourAgo(), parents: 1 },
        { oid: B, committedDate: hourAgo(), parents: 1 },
      ],
      comments: [
        {
          id: 901,
          nodeId: "IC_901",
          url: `${URL42}#issuecomment-901`,
          author: ME,
          body: handoff.body,
          createdAt: hourAgo(),
          editedAt: null,
        },
      ],
    });
    t.s.attention.clear(task!.id, "user");
    await t.pass();
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1]!.prompt).toContain("Mode: **followup**");
    expect(t.comments).toHaveLength(2);
    expect(t.comments[1]!.edit).toBe("IC_901");
    expect(parseReviewMarker(t.comments[1]!.body)).toMatchObject({ head: B, reason: "departure", round: "2" });
    expect(t.comments[1]!.body).toContain("_Round 2 of 3");
    expect(t.s.tasks.summaries({ projectId: t.project.id })).toHaveLength(1);
    expect(t.s.tasks.summary(task!.id).attentionRequest).toBeNull();
  });

  it("closes the hand-off task when a later round approves", async () => {
    const t = setup();
    t.turnOn();
    t.answer({
      decision: "escalate",
      summary: "Too vague.",
      issues: [],
      escalation: { reason: "vague", why: "Issue #5 doesn't say", checklist: [] },
    });
    await t.pass();
    const [task] = t.s.tasks.summaries({ projectId: t.project.id });
    t.setPr({
      headOid: B,
      comments: [
        {
          id: 901,
          nodeId: "IC_901",
          url: URL42,
          author: ME,
          body: t.comments[0]!.body,
          createdAt: hourAgo(),
          editedAt: null,
        },
      ],
    });
    t.answer({ decision: "approve", summary: "The issue was clarified.", issues: [] });
    await t.pass();
    expect(t.reviews[0]!.event).toBe("approve");
    expect(t.s.tasks.summary(task!.id).status).toBe("done");
    expect(t.state()?.taskId).toBeNull();
  });

  it("never asks for changes with nothing blocking or major: a review of only minor points and nits is clean", async () => {
    const t = setup();
    t.turnOn();
    const minor = { ...major(), severity: "minor" as const, title: "Name it better" };
    t.answer({ decision: "request_changes", summary: "Small things only.", issues: [minor] });
    await t.pass();
    expect(t.reviews).toHaveLength(1);
    expect(t.reviews[0]!.event).toBe("approve");
    expect(t.reviews[0]!.comments).toHaveLength(0);
    expect(t.reviews[0]!.body).toContain("### FYI (no action needed)");
    // With the gate failing it waits for the user instead; it never blocks the merge.
    expect(
      settleDecision(
        { decision: "request_changes", summary: "x", issues: [minor] },
        { plan: { mode: "full", maxRounds: 3, gate: ["no linked issue (Closes #n)"] } as never },
        { approve: true },
      ),
    ).toMatchObject({ outcome: "ready", reason: "gate" });
  });

  it("hands over when the rounds are used up and changes are still asked for", () => {
    const settled = settleDecision(
      { decision: "request_changes", summary: "x", issues: [major()] },
      { plan: { mode: "cap_reached", maxRounds: 3, gate: [] } as never },
      { approve: true },
    );
    expect(settled).toMatchObject({ outcome: "escalated", reason: "cap" });
  });

  it("refuses a hand-off that doesn't say why", () => {
    expect(() =>
      settleDecision(
        { decision: "escalate", summary: "x", issues: [] },
        { plan: { mode: "full", gate: [] } as never },
        {
          approve: true,
        },
      ),
    ).toThrow("without saying why");
  });
});

describe("other people's PRs: threads", () => {
  it("resolves its own threads it says are fixed or whose dispute it accepts, and replies with why", async () => {
    const t = setup();
    t.turnOn();
    const own = (id: number, threadId: string) => ({
      id: threadId,
      resolved: false,
      canResolve: true,
      comments: [
        {
          id,
          author: ME,
          body: `📋 x · major\n\n${reviewMarker({ finding: "" })}`,
          createdAt: hourAgo(),
          path: "a.ts",
          line: 1,
        },
        { id: id + 1, author: "alice", body: "Not a bug.", createdAt: new Date().toISOString(), path: "a.ts", line: 1 },
      ],
    });
    const earlier = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    t.setPr({
      reviews: [
        {
          id: 1,
          author: ME,
          state: "CHANGES_REQUESTED",
          body: reviewMarker({ head: A, verdict: "changes", counted: 1, round: 1 }),
          submittedAt: earlier,
          commitOid: A,
        },
      ],
      threads: [
        own(10, "T10"),
        own(20, "T20"),
        { ...own(30, "T30"), comments: [{ ...own(30, "T30").comments[0]!, author: "carol" }] },
      ],
    });
    t.answer({
      decision: "request_changes",
      summary: "One point stands.",
      issues: [major()],
      disputes: [
        { commentId: 10, outcome: "accepted", reply: "Right, the caller checks first." },
        { commentId: 20, outcome: "rejected", reply: "It can be empty after a retry." },
        { commentId: 30, outcome: "accepted" },
      ],
    });
    await t.pass();
    expect(t.requests[0]!.prompt).toContain("Mode: **dispute**");
    expect(t.resolved).toEqual(["T10"]);
    expect(t.replies.map((r) => r.threadId)).toEqual(["T10", "T20"]);
  });
});

describe("other people's PRs: the head moving", () => {
  it("posts nothing when the PR moved on before the review was posted", async () => {
    const t = setup();
    t.turnOn();
    t.setHeads([A, B]);
    await t.pass();
    expect(t.requests).toHaveLength(1);
    expect(t.reviews).toHaveLength(0);
    expect(t.runs()[0]).toMatchObject({ status: "skipped", summary: "PR #42 moved on while it was being reviewed" });
  });

  it("checks the head again before a hand-off comment and the board", async () => {
    const t = setup();
    t.turnOn();
    t.answer({
      decision: "escalate",
      summary: "x",
      issues: [],
      escalation: { reason: "security", why: "Token handling", checklist: [] },
    });
    t.setHeads([A, B]);
    await t.pass();
    expect(t.comments).toHaveLength(0);
    expect(t.s.tasks.summaries({ projectId: t.project.id })).toHaveLength(0);
  });
});

describe("other people's PRs: what is left alone", () => {
  it("leaves a PR a task works on to the task source", async () => {
    const t = setup();
    t.turnOn();
    t.s.tasks.create({
      projectId: t.project.id,
      title: "Thing",
      plan: { phases: [{ title: "Do", steps: [{ title: "it" }] }] },
      links: [{ value: URL42 }],
    });
    await t.pass();
    expect(t.requests).toHaveLength(0);
  });

  it("says Needs setup when on with nobody to review, and reviews nothing", async () => {
    const t = setup();
    t.turnOn({ otherAuthors: "" });
    await t.pass();
    expect(t.requests).toHaveLength(0);
    const row = t.s.autopilot.overview().automations.find((a) => a.key === AUTOPILOT_REVIEW_PRS)!;
    expect(row.needs).toBe("Needs setup: Other people's PRs is on with no authors in: Alpha");
  });

  it("does nothing while the source is off", async () => {
    const t = setup();
    t.turnOn({ otherPrs: false });
    await t.pass();
    expect(t.requests).toHaveLength(0);
  });
});

describe("renderHandoff", () => {
  it("puts every point in the body and tells the author it looks again by itself", () => {
    const body = renderHandoff({
      summary: "Summary.",
      issues: [major(), { ...major(), severity: "minor", fyi: true, title: "Small" }],
      viewer: ME,
      reason: "dependency",
      why: "Adds left-pad",
      checklist: ["package.json"],
      round: 2,
      maxRounds: 3,
      headOid: A,
    });
    expect(body).toContain("_Round 2 of 3, at `aaaaaaa`: 1 major, 1 FYI_");
    expect(body).toContain("### Points");
    expect(body).toContain("### To look at");
    expect(body).toContain("looks at this PR again by itself");
    expect(parseReviewMarker(body)).toEqual({
      event: "escalated",
      head: A,
      reason: "dependency",
      round: "2",
      counted: "1",
    });
  });
});
