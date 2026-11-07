import { prReviewHeader, reviewMarker } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import type { RepoPr } from "../../integrations/gitHost.ts";
import { approvalGate, assessRepoPr, otherPrsSettings, postedSince, type Assessment } from "./repoPrAssess.ts";

const ME = "owner";
const AUTHOR = "alice";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const NOW = new Date("2026-11-07T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const settings = otherPrsSettings({
  otherAuthors: "Alice, @bob",
  otherApprove: true,
  otherSensitivePaths: ".github/, *.lock, CODEOWNERS",
  otherQuietMinutes: 10,
  otherWaitMinutes: 60,
  otherMaxRounds: 3,
});

let nextId = 1;
const id = () => nextId++;

/** A PR as GitHub has it, quiet for an hour, checks green, closing #5, never reviewed. */
function pr(over: Partial<RepoPr> = {}): RepoPr {
  return {
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    title: "Add the thing",
    author: AUTHOR,
    draft: false,
    state: "open",
    headOid: A,
    headRef: "feat/thing",
    baseRef: "main",
    isCrossRepository: false,
    viewer: ME,
    closingIssues: [5],
    referencingIssues: [],
    files: { total: 1, paths: ["src/thing.ts"] },
    commits: [{ oid: A, committedDate: ago(120), parents: 1 }],
    checks: { pending: [], failing: [], missing: [], latestAt: ago(60) },
    latestReviews: [],
    reviews: [],
    comments: [],
    threads: [],
    dismissals: [],
    ...over,
  };
}

const review = (
  attrs: Record<string, string | number>,
  at: string,
  over: Partial<RepoPr["reviews"][number]> = {},
): RepoPr["reviews"][number] => ({
  id: id(),
  author: ME,
  state: attrs.verdict === "approve" ? "APPROVED" : "CHANGES_REQUESTED",
  body: `${prReviewHeader()}\n\nFine.\n\n${reviewMarker(attrs)}`,
  submittedAt: at,
  commitOid: String(attrs.head),
  ...over,
});

const comment = (body: string, at: string, over: Partial<RepoPr["comments"][number]> = {}) => {
  const n = id();
  return {
    id: n,
    nodeId: `IC_${n}`,
    url: `https://github.com/acme/app/pull/42#issuecomment-${n}`,
    author: ME,
    body,
    createdAt: at,
    editedAt: null,
    ...over,
  };
};

const handoff = (head: string, reason: string, at: string, extra: Record<string, string | number> = {}) =>
  comment(`${prReviewHeader()}\n\nHanded over.\n\n${reviewMarker({ event: "escalated", head, reason, ...extra })}`, at);

const never = () => Promise.reject(new Error("not asked"));
const assess = (p: RepoPr, unchanged: (base: string) => Promise<boolean> = never) =>
  assessRepoPr(p, settings, NOW, unchanged);
const plan = (a: Assessment) => {
  if (a.kind !== "review") throw new Error(`skipped: ${a.why}`);
  return a.plan;
};

describe("other people's PRs: which to review", () => {
  it("reviews a quiet, green PR by a listed author in full", async () => {
    const p = plan(await assess(pr()));
    expect(p).toMatchObject({ mode: "full", round: 1, roundsUsed: 0, gate: [], resumeId: 0, replyId: 0 });
  });

  it("matches authors without case or @, and skips anyone else, drafts and closed PRs", async () => {
    expect((await assess(pr({ author: "bob" }))).kind).toBe("review");
    expect(await assess(pr({ author: "mallory" }))).toMatchObject({ kind: "skip" });
    expect(await assess(pr({ author: ME }))).toMatchObject({ kind: "skip" });
    expect(await assess(pr({ draft: true }))).toMatchObject({ kind: "skip" });
    expect(await assess(pr({ state: "merged" }))).toMatchObject({ kind: "skip" });
  });

  it("leaves a PR a person approved or asked changes on, the user by hand included", async () => {
    for (const author of ["carol", ME]) {
      const a = await assess(pr({ latestReviews: [{ author, state: "APPROVED", body: "LGTM" }] }));
      expect(a).toMatchObject({ kind: "skip", code: "person_reviewed" });
    }
    // Autopilot's own approval isn't a person's.
    const own = await assess(
      pr({ latestReviews: [{ author: ME, state: "COMMENTED", body: reviewMarker({ head: B, verdict: "changes" }) }] }),
    );
    expect(own.kind).toBe("review");
  });

  it("waits for checks to finish, then for the quiet period", async () => {
    expect(await assess(pr({ checks: { pending: ["ci"], failing: [], missing: [], latestAt: null } }))).toMatchObject({
      kind: "skip",
      why: "waiting for checks: ci",
    });
    expect(await assess(pr({ checks: { pending: [], failing: [], missing: [], latestAt: ago(4) } }))).toMatchObject({
      why: "in the quiet period after a push",
    });
    expect(await assess(pr({ commits: [{ oid: A, committedDate: ago(2), parents: 1 }] }))).toMatchObject({
      why: "in the quiet period after a push",
    });
  });

  it("gives the author time to answer another reviewer's fresh thread", async () => {
    const thread = (createdAt: string, replies: RepoPr["threads"][number]["comments"] = []) => ({
      id: "T1",
      resolved: false,
      canResolve: true,
      comments: [{ id: id(), author: "copilot", body: "This races.", createdAt, path: "a.ts", line: 3 }, ...replies],
    });
    expect(await assess(pr({ threads: [thread(ago(30))] }))).toMatchObject({
      why: "waiting for the author to answer another reviewer",
    });
    // Answered, or old enough: go ahead.
    const answered = thread(ago(30), [
      { id: id(), author: AUTHOR, body: "Fixed.", createdAt: ago(20), path: "a.ts", line: 3 },
    ]);
    expect((await assess(pr({ threads: [answered] }))).kind).toBe("review");
    expect((await assess(pr({ threads: [thread(ago(90))] }))).kind).toBe("review");
  });
});

describe("other people's PRs: the mode", () => {
  it("skips a head it already approved or handed over, and a requested-changes head until the author replies", async () => {
    expect(await assess(pr({ reviews: [review({ head: A, verdict: "approve", counted: 1 }, ago(50))] }))).toMatchObject(
      {
        why: "already reviewed at this commit",
      },
    );
    expect(await assess(pr({ comments: [handoff(A, "departure", ago(50))] }))).toMatchObject({
      why: "already reviewed at this commit",
    });
    expect(await assess(pr({ reviews: [review({ head: A, verdict: "changes", counted: 1 }, ago(50))] }))).toMatchObject(
      {
        why: "waiting for the author",
      },
    );
  });

  it("is a dispute when the author replies on one of its open threads", async () => {
    const root = id();
    const reply = id();
    const p = plan(
      await assess(
        pr({
          reviews: [review({ head: A, verdict: "changes", counted: 1, round: 1 }, ago(50))],
          threads: [
            {
              id: "T9",
              resolved: false,
              canResolve: true,
              comments: [
                {
                  id: root,
                  author: ME,
                  body: `📋 x\n\n${reviewMarker({ finding: "" })}`,
                  createdAt: ago(50),
                  path: "a.ts",
                  line: 1,
                },
                {
                  id: reply,
                  author: AUTHOR,
                  body: "It can't be empty here.",
                  createdAt: ago(20),
                  path: "a.ts",
                  line: 1,
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(p).toMatchObject({ mode: "dispute", replyId: reply, round: 2 });
    expect(p.ownThreads).toEqual([{ rootId: root, threadId: "T9", canResolve: true, replied: true }]);
  });

  it("reviews the delta after its approval, unless only merges came in while the approval stands", async () => {
    const approved = review({ head: B, verdict: "approve", counted: 1, round: 1 }, ago(100));
    const base = pr({ reviews: [approved] });
    const p = plan(await assess(base, async (from) => (expect(from).toBe(B), false)));
    expect(p).toMatchObject({ mode: "delta", baseHead: B, round: 2 });
    // Its approval still stands and nothing the author wrote changed: nothing to do.
    const standing = pr({
      reviews: [approved],
      latestReviews: [{ author: ME, state: "APPROVED", body: approved.body }],
    });
    expect(await assess(standing, async () => true)).toMatchObject({ why: "only merges since the approval" });
    // A push dismissed it: re-approve even after merges only, since the PR lost its approval.
    expect((await assess(base, async () => true)).kind).toBe("review");
  });

  it("counts the user's own approval that someone else's push dismissed as an approval of that commit", async () => {
    const p = plan(
      await assess(
        pr({
          dismissals: [
            {
              createdAt: ago(30),
              actor: AUTHOR,
              previousState: "APPROVED",
              review: { author: ME, body: "LGTM", submittedAt: ago(200), commitOid: C },
            },
          ],
        }),
        async () => false,
      ),
    );
    expect(p).toMatchObject({ mode: "delta", baseHead: C, roundsUsed: 0 });
  });

  it("follows up a hand-off once the author pushed real changes, and not after merges only", async () => {
    const h = handoff(B, "departure", ago(100), { round: 1, counted: 1 });
    const p = plan(await assess(pr({ comments: [h] }), async () => false));
    expect(p).toMatchObject({ mode: "followup", baseHead: B, round: 2 });
    expect(p.lastHandoff).toMatchObject({ commentId: h.id, nodeId: h.nodeId, reason: "departure", latest: true });
    expect(await assess(pr({ comments: [h] }), async () => true)).toMatchObject({
      why: "nothing the author wrote changed since the hand-off",
    });
  });

  it("dates an edited hand-off by its edit, so the newer head it names counts", async () => {
    const h = { ...handoff(A, "departure", ago(300), { round: 2, counted: 1 }), editedAt: ago(20) };
    const later = review({ head: B, verdict: "changes", counted: 1, round: 1 }, ago(200));
    expect(await assess(pr({ comments: [h], reviews: [later] }))).toMatchObject({
      why: "already reviewed at this commit",
    });
  });

  it("hands over once the rounds are used up, but still reviews a delta", async () => {
    const reviews = [1, 2, 3].map((round) =>
      review({ head: [B, C, B][round - 1]!, verdict: "changes", counted: 1, round }, ago(400 - round * 50)),
    );
    expect(plan(await assess(pr({ reviews })))).toMatchObject({ mode: "cap_reached", roundsUsed: 3, round: 4 });
    const approvedLast = [
      ...reviews.slice(0, 2),
      review({ head: B, verdict: "approve", counted: 1, round: 3 }, ago(100)),
    ];
    expect(plan(await assess(pr({ reviews: approvedLast }), async () => false))).toMatchObject({ mode: "delta" });
  });

  it("reads the custom automation's markers: counted reviews without a round, hand-offs without a reason", async () => {
    const legacy = [
      review({ head: B, verdict: "changes", counted: 1 }, ago(300)),
      review({ head: C, verdict: "approve", counted: 0 }, ago(250)),
      review({ head: C, verdict: "changes", counted: 1 }, ago(200)),
    ];
    const old = handoff(C, "", ago(150));
    old.body = `Handed over.\n\n<!-- autopilot-review event=escalated head=${C} -->`;
    const p = plan(await assess(pr({ reviews: legacy, comments: [old] }), async () => false));
    // Two counted reviews; the v1 hand-off counts no round, and its missing reason is read as none.
    expect(p).toMatchObject({ mode: "followup", baseHead: C, roundsUsed: 2, round: 3 });
    expect(p.lastHandoff?.reason).toBeNull();
    // v2's no_issue reason is the gate now.
    const v2 = handoff(C, "no_issue", ago(150));
    expect(plan(await assess(pr({ comments: [v2] }), async () => false)).lastHandoff?.reason).toBe("gate");
  });
});

describe("other people's PRs: stop and resume", () => {
  it("stops on the user's /autopilot stop, and starts afresh on a later resume", async () => {
    const stop = comment("/autopilot stop", ago(200));
    expect(await assess(pr({ comments: [stop] }))).toMatchObject({ kind: "skip", code: "stopped" });
    // Someone else's command doesn't count.
    expect((await assess(pr({ comments: [comment("/autopilot stop", ago(200), { author: AUTHOR })] }))).kind).toBe(
      "review",
    );
    const resume = comment("/Autopilot resume please", ago(100));
    const before = handoff(A, "departure", ago(150), { round: 2, counted: 1 });
    const p = plan(await assess(pr({ comments: [stop, before, resume] })));
    expect(p).toMatchObject({ mode: "full", roundsUsed: 0, resumeId: resume.id, resumed: true, lastHandoff: null });
  });
});

describe("other people's PRs: the approval gate", () => {
  it("passes a PR with an issue, green required checks and no sensitive path", () => {
    expect(approvalGate(pr(), settings)).toEqual([]);
  });

  it("names every reason", () => {
    const gate = approvalGate(
      pr({
        closingIssues: [],
        checks: { pending: ["e2e"], failing: ["test"], missing: ["lint"], latestAt: ago(60) },
        files: { total: 150, paths: [".github/workflows/ci.yml", "web/yarn.lock", "src/a.ts", "docs/CODEOWNERS"] },
      }),
      settings,
    );
    expect(gate).toEqual([
      "no linked issue (Closes #n)",
      "required checks still running: e2e",
      "required checks not green: test",
      "required checks haven't reported: lint",
      "too many files to check the sensitive paths",
      "touches sensitive paths: .github/workflows/ci.yml, docs/CODEOWNERS, web/yarn.lock",
    ]);
  });

  it("needs no issue when the setting is off", () => {
    expect(approvalGate(pr({ closingIssues: [] }), { ...settings, requireIssue: false })).toEqual([]);
  });
});

describe("postedSince", () => {
  it("finds a post of Autopilot's at this head after a time, by its marker", () => {
    const since = Date.parse(ago(30));
    const landed = handoff(A, "gate", ago(10));
    expect(postedSince(pr({ comments: [landed] }), A, since)).toBe(true);
    expect(postedSince(pr({ comments: [landed] }), B, since)).toBe(false);
    expect(postedSince(pr({ comments: [handoff(A, "gate", ago(40))] }), A, since)).toBe(false);
    expect(postedSince(pr({ reviews: [review({ head: A, verdict: "approve" }, ago(5))] }), A, since)).toBe(true);
    expect(postedSince(pr({ comments: [{ ...landed, author: AUTHOR }] }), A, since)).toBe(false);
  });
});
