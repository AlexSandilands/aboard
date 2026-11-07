import {
  parseControlCommand,
  parseLogins,
  parsePathPatterns,
  parseReviewMarker,
  prReviewHeader,
  prReviewMarker,
  sensitiveFiles,
  type EscalationReason,
  type RepoPrMode,
} from "@repo/contracts";
import type { RepoPr } from "../../integrations/gitHost.ts";

// Which of other people's PRs Review PRs reviews now, and how (docs/features/autopilot.md#other-peoples-prs). A port
// of the custom "Autopilot PR review" automation's check script: the PR's history is read back from what Autopilot
// posted on it (the hidden markers, old and new alike), so nothing has to be remembered for a PR to be judged.

/** The other-people's-PRs settings, read from Review PRs' config. */
export interface OtherPrsSettings {
  authors: ReadonlySet<string>;
  approve: boolean;
  requireIssue: boolean;
  sensitive: readonly string[];
  quietMinutes: number;
  waitMinutes: number;
  maxRounds: number;
}

export function otherPrsSettings(config: Record<string, unknown>): OtherPrsSettings {
  const num = (key: string, fallback: number) => (typeof config[key] === "number" ? config[key] : fallback);
  return {
    authors: new Set(parseLogins(config.otherAuthors)),
    approve: config.otherApprove === true,
    requireIssue: config.otherRequireIssue !== false,
    sensitive: parsePathPatterns(config.otherSensitivePaths),
    quietMinutes: num("otherQuietMinutes", 10),
    waitMinutes: num("otherWaitMinutes", 60),
    maxRounds: Math.max(1, Math.round(num("otherMaxRounds", 3))),
  };
}

/** The hand-off Autopilot last posted since the latest resume: the comment to edit when the same reason holds again. */
export interface LastHandoff {
  commentId: number;
  nodeId: string;
  url: string;
  head: string;
  reason: EscalationReason | null;
  /** Nothing Autopilot posted came after it. */
  latest: boolean;
}

/** One review to run: the mode and everything the prompt and the posting need. */
export interface RepoPrPlan {
  mode: RepoPrMode;
  /** The commit an earlier approval or hand-off was about (delta and followup). */
  baseHead: string | null;
  /** Rounds used since the latest resume, and the one this review is. */
  roundsUsed: number;
  round: number;
  maxRounds: number;
  /** The latest `/autopilot resume` comment's id, or 0. */
  resumeId: number;
  /** The author's reply that made this a dispute, or 0. */
  replyId: number;
  /** The user resumed Autopilot and it hasn't posted since. */
  resumed: boolean;
  /** Why an approval isn't allowed, empty when it is. */
  gate: string[];
  lastHandoff: LastHandoff | null;
  /** Autopilot's own unresolved threads, by their first comment's id. */
  ownThreads: Array<{ rootId: number; threadId: string; canResolve: boolean; replied: boolean }>;
}

/** Why a PR isn't reviewed now. `ends_wait` codes also take it off Needs you: the user no longer needs to approve it. */
export type SkipCode =
  | "not_open"
  | "author"
  | "stopped"
  | "person_reviewed"
  | "checks"
  | "quiet"
  | "other_reviewer"
  | "reviewed"
  | "waiting_author"
  | "merges_only"
  | "unchanged";

export type Assessment = { kind: "skip"; code: SkipCode; why: string } | { kind: "review"; plan: RepoPrPlan };

/** Skips after which nobody needs to approve the PR any more: it closed, it was stopped, or a person reviewed it. */
export const ENDS_WAIT: ReadonlySet<SkipCode> = new Set(["not_open", "stopped", "person_reviewed"]);

/**
 * What stops Autopilot from posting on the PR at all, read from the PR as it is now: closed or a draft, the user's
 * `/autopilot stop`, or a person's approval or request for changes that still stands. Null when nothing does.
 */
export function standingBlock(pr: RepoPr): { code: SkipCode; why: string } | null {
  if (pr.state !== "open" || pr.draft) return { code: "not_open", why: "not open, or a draft" };
  const me = pr.viewer;
  const controls = pr.comments
    .filter((c) => c.author === me && parseReviewMarker(c.body) === null)
    .flatMap((c) => {
      const command = parseControlCommand(c.body);
      return command ? [{ at: ts(c.createdAt), command }] : [];
    })
    .sort((a, b) => a.at - b.at);
  if (controls.at(-1)?.command === "stop") return { code: "stopped", why: "stopped with /autopilot stop" };
  if (
    pr.latestReviews.some(
      (r) =>
        (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") &&
        r.author !== pr.author &&
        parseReviewMarker(r.body) === null,
    )
  ) {
    return { code: "person_reviewed", why: "a person already reviewed it" };
  }
  return null;
}

const EPOCH = 0;
const ts = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** A post of Autopilot's, by the viewer: its marker, or (an inline comment) the mark it starts with. */
const isOwnPost = (author: string | null, body: string, viewer: string): boolean =>
  author === viewer &&
  (parseReviewMarker(body) !== null ||
    body.trimStart().startsWith(prReviewHeader()) ||
    body.trimStart().startsWith(prReviewMarker()));

const asReason = (value: string | undefined): EscalationReason | null =>
  value === "departure" ||
  value === "dependency" ||
  value === "security" ||
  value === "dispute" ||
  value === "vague" ||
  value === "cap" ||
  value === "gate"
    ? value
    : value === "no_issue"
      ? "gate"
      : null;

/** The approval gate: what stops Autopilot approving, whatever the review finds. */
export function approvalGate(pr: RepoPr, settings: OtherPrsSettings): string[] {
  const gate: string[] = [];
  if (settings.requireIssue && pr.closingIssues.length === 0) gate.push("no linked issue (Closes #n)");
  // Pending only at the post: a check re-run while the agent reviewed. The poll waits for checks before reviewing.
  if (pr.checks.pending.length > 0) gate.push(`required checks still running: ${pr.checks.pending.join(", ")}`);
  if (pr.checks.failing.length > 0) gate.push(`required checks not green: ${pr.checks.failing.join(", ")}`);
  if (pr.checks.missing.length > 0) gate.push(`required checks haven't reported: ${pr.checks.missing.join(", ")}`);
  if (pr.files.total > pr.files.paths.length) gate.push("too many files to check the sensitive paths");
  const hits = sensitiveFiles(pr.files.paths, settings.sensitive);
  if (hits.length > 0) {
    gate.push(`touches sensitive paths: ${hits.slice(0, 20).join(", ")}${hits.length > 20 ? ", …" : ""}`);
  }
  return gate;
}

/**
 * Whether to review the PR now, and how. `unchangedSince(base)` tells whether nothing the author wrote changed from
 * `base` to the head (only merges, or a rebase of the same change); it is asked only when the answer matters.
 */
export async function assessRepoPr(
  pr: RepoPr,
  settings: OtherPrsSettings,
  now: Date,
  unchangedSince: (base: string) => Promise<boolean>,
): Promise<Assessment> {
  const skip = (code: SkipCode, why: string): Assessment => ({ kind: "skip", code, why });
  const me = pr.viewer;
  const author = pr.author;
  if (pr.state !== "open" || pr.draft) return skip("not_open", "not open, or a draft");
  if (!author || author === me || !settings.authors.has(author)) return skip("author", "its author isn't on the list");
  const head = pr.headOid;

  // The user's control comments (theirs, without a marker): the newest one wins.
  const controls = pr.comments
    .filter((c) => c.author === me && parseReviewMarker(c.body) === null)
    .flatMap((c) => {
      const command = parseControlCommand(c.body);
      return command ? [{ at: ts(c.createdAt), command, id: c.id }] : [];
    })
    .sort((a, b) => a.at - b.at);
  if (controls.at(-1)?.command === "stop") return skip("stopped", "stopped with /autopilot stop");
  const resume = controls.findLast((c) => c.command === "resume") ?? null;
  const since = resume?.at ?? EPOCH;

  // Someone (the user by hand included) approved or asked for changes and it still stands: theirs to finish.
  if (
    pr.latestReviews.some(
      (r) =>
        (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") &&
        r.author !== author &&
        parseReviewMarker(r.body) === null,
    )
  ) {
    return skip("person_reviewed", "a person already reviewed it");
  }
  const myLatest = pr.latestReviews.findLast((r) => r.author === me);
  const approvalActive = myLatest?.state === "APPROVED";

  // Everything Autopilot or the user decided since the resume, oldest first: the newest sets the mode.
  type Entry = { at: number; kind: "approve" | "changes" | "escalated"; head: string };
  const history: Entry[] = [];
  let legacyCounted = 0;
  let roundMax = 0;
  const count = (attrs: Record<string, string>) => {
    if (attrs.counted !== "1") return;
    const round = Number(attrs.round);
    if (Number.isInteger(round) && round > 0) roundMax = Math.max(roundMax, round);
    else legacyCounted += 1;
  };
  let ownPosts = 0;
  for (const r of pr.reviews) {
    const attrs = parseReviewMarker(r.body);
    if (!attrs || r.author !== me || !r.submittedAt || ts(r.submittedAt) <= since) continue;
    if (attrs.event !== undefined || attrs.finding !== undefined) continue;
    ownPosts += 1;
    count(attrs);
    history.push({
      at: ts(r.submittedAt),
      kind: attrs.verdict === "approve" ? "approve" : "changes",
      head: attrs.head ?? r.commitOid ?? "",
    });
  }
  let lastHandoff: (LastHandoff & { at: number }) | null = null;
  for (const c of pr.comments) {
    const attrs = parseReviewMarker(c.body);
    if (!attrs || c.author !== me || attrs.event !== "escalated") continue;
    // An edited hand-off (the same reason again) counts from its edit.
    const at = Math.max(ts(c.createdAt), ts(c.editedAt) || 0);
    if (at <= since) continue;
    ownPosts += 1;
    count(attrs);
    history.push({ at, kind: "escalated", head: attrs.head ?? "" });
    if (!lastHandoff || at >= lastHandoff.at) {
      lastHandoff = {
        at,
        commentId: c.id,
        nodeId: c.nodeId,
        url: c.url,
        head: attrs.head ?? "",
        reason: asReason(attrs.reason),
        latest: false,
      };
    }
  }
  // The user's own approval that someone else's push dismissed counts as an approval of the commit they approved.
  for (const d of pr.dismissals) {
    const rv = d.review;
    if (
      d.previousState === "APPROVED" &&
      rv &&
      rv.author === me &&
      parseReviewMarker(rv.body) === null &&
      d.actor !== me &&
      rv.commitOid &&
      rv.submittedAt &&
      ts(rv.submittedAt) > since
    ) {
      history.push({ at: ts(rv.submittedAt), kind: "approve", head: rv.commitOid });
    }
  }
  history.sort((a, b) => a.at - b.at);
  const roundsUsed = Math.max(roundMax, legacyCounted);
  const last = history.at(-1) ?? null;
  if (lastHandoff) lastHandoff.latest = last?.kind === "escalated" && last.at === lastHandoff.at;

  // Wait until the checks have finished, and then for the quiet period after the last one (or the push).
  if (pr.checks.pending.length > 0) return skip("checks", `waiting for checks: ${pr.checks.pending.join(", ")}`);
  const headCommit = pr.commits.find((c) => c.oid === head) ?? pr.commits.at(-1);
  const settled = Math.max(ts(headCommit?.committedDate) || 0, ts(pr.checks.latestAt) || 0);
  if (now.getTime() - settled < settings.quietMinutes * 60_000)
    return skip("quiet", "in the quiet period after a push");

  // Give the author time to answer another reviewer's fresh threads.
  for (const t of pr.threads) {
    const first = t.comments[0];
    if (t.resolved || !first || first.author === me || first.author === author) continue;
    const answered = t.comments.slice(1).some((c) => c.author === author);
    if (!answered && now.getTime() - ts(first.createdAt) < settings.waitMinutes * 60_000) {
      return skip("other_reviewer", "waiting for the author to answer another reviewer");
    }
  }

  const ownThreads = pr.threads.flatMap((t) => {
    const first = t.comments[0];
    if (t.resolved || !first || !isOwnPost(first.author, first.body, me)) return [];
    const replied = last ? t.comments.slice(1).some((c) => c.author === author && ts(c.createdAt) > last.at) : false;
    return [{ rootId: first.id, threadId: t.id, canResolve: t.canResolve, replied }];
  });

  let mode: RepoPrMode;
  let baseHead: string | null = null;
  let replyId = 0;
  if (!last) mode = "full";
  else if (last.head === head) {
    if (last.kind !== "changes") return skip("reviewed", "already reviewed at this commit");
    // A reply from the author on one of Autopilot's open threads, after its last review: a dispute.
    for (const t of pr.threads) {
      const first = t.comments[0];
      if (t.resolved || !first || !isOwnPost(first.author, first.body, me)) continue;
      for (const c of t.comments.slice(1)) {
        if (c.author === author && ts(c.createdAt) > last.at) replyId = Math.max(replyId, c.id);
      }
    }
    if (!replyId) return skip("waiting_author", "waiting for the author");
    mode = "dispute";
  } else if (last.kind === "approve") {
    if (approvalActive && (await unchangedSince(last.head)))
      return skip("merges_only", "only merges since the approval");
    mode = "delta";
    baseHead = last.head;
  } else if (last.kind === "escalated") {
    if (await unchangedSince(last.head))
      return skip("unchanged", "nothing the author wrote changed since the hand-off");
    mode = "followup";
    baseHead = last.head;
  } else mode = "full";
  if (mode !== "delta" && roundsUsed >= settings.maxRounds) mode = "cap_reached";

  return {
    kind: "review",
    plan: {
      mode,
      baseHead,
      roundsUsed,
      round: roundsUsed + 1,
      maxRounds: settings.maxRounds,
      resumeId: resume?.id ?? 0,
      replyId,
      resumed: resume !== null && ownPosts === 0,
      gate: approvalGate(pr, settings),
      lastHandoff: lastHandoff
        ? {
            commentId: lastHandoff.commentId,
            nodeId: lastHandoff.nodeId,
            url: lastHandoff.url,
            head: lastHandoff.head,
            reason: lastHandoff.reason,
            latest: lastHandoff.latest,
          }
        : null,
      ownThreads,
    },
  };
}
