import { isListedBot } from "./repoPrReview.ts";
import type { PrSnapshot } from "./schemas.ts";

// A PR's review threads nobody answered, from what the poll reads (no bodies): what get_task's PR line shows and what
// makes a green PR stalled for Orchestrate. Kept apart from prFix.ts, which autopilot.ts can't import (merge.ts reads
// schemas.ts, which reads autopilot.ts).

/** An unresolved review thread nobody answered: its newest comment is someone else's. */
export interface UnansweredThread {
  /** GitHub's node id. */
  id: string;
  /** Who wrote the newest comment; "" for a deleted account, null when the snapshot predates it being read. */
  author: string | null;
  /** That author has repository access, or is on Fix PRs' "Trusted bot reviewers" (`trustedBots`). */
  trusted: boolean;
}

/**
 * The PR's unresolved review threads whose newest comment isn't the signed-in account's. Autopilot posts as the user,
 * so a thread it answered ("fixed" or "declined") ends with the user's comment and isn't counted, nor is one the user
 * answered by hand. `trustedBots` is Fix PRs' list, parsed (`parseBotLogins`): review bots installed as apps are often
 * marked as having no access.
 */
export function unansweredThreads(
  snapshot: PrSnapshot | null | undefined,
  trustedBots: readonly string[] = [],
): UnansweredThread[] {
  return (snapshot?.reviewThreads ?? []).flatMap((t): UnansweredThread[] =>
    t.ownLast
      ? []
      : [
          {
            id: t.id,
            author: t.lastAuthor ?? null,
            trusted: t.lastTrusted === true || isListedBot(t.lastAuthor, trustedBots),
          },
        ],
  );
}

/**
 * A PR that is green and mergeable but not approved, with review threads nobody answered: nothing on the PR row is red,
 * yet it won't move until someone deals with the threads. Orchestrate looks at such a PR (`orchestrateNeedsLooking`)
 * whether or not its task may be merged by Autopilot.
 */
export const isStalledPr = (snapshot: PrSnapshot | null | undefined): boolean =>
  !!snapshot &&
  snapshot.state === "open" &&
  snapshot.checks === "passing" &&
  snapshot.mergeable === "mergeable" &&
  snapshot.reviewDecision !== "approved" &&
  unansweredThreads(snapshot).length > 0;

/** Why a PR waiting for an approving review may not get one: its unresolved review threads, as `approvalBlock` reads them. */
export interface ApprovalBlock {
  /** Unresolved review threads. */
  threads: number;
  /** Of those, the ones whose newest comment is someone else's: waiting on a reply. */
  waiting: number;
  /** Of those, the ones the signed-in account answered last (Autopilot fixed or declined the point): waiting on the reviewer. */
  answered: number;
  /** Who spoke last on the waiting threads, once each, in thread order; "" for a deleted account. */
  authors: string[];
}

/**
 * Why an open PR that needs an approving review hasn't got one, from its unresolved review threads: a reviewer bot
 * usually won't approve while they are open. Null for a PR that isn't waiting for an approval. A snapshot stored
 * before the threads were read gives only their count.
 */
export function approvalBlock(snapshot: PrSnapshot | null | undefined): ApprovalBlock | null {
  if (!snapshot || snapshot.state !== "open" || snapshot.reviewDecision !== "review_required") return null;
  const threads = snapshot.reviewThreads;
  if (!threads) return { threads: snapshot.unresolvedThreads ?? 0, waiting: 0, answered: 0, authors: [] };
  const waiting = threads.filter((t) => !t.ownLast);
  const authors = [...new Set(waiting.flatMap((t) => (t.lastAuthor == null ? [] : [t.lastAuthor])))];
  return { threads: threads.length, waiting: waiting.length, answered: threads.length - waiting.length, authors };
}

/** How many authors `approvalBlockReason` names before "and N more". */
const SHOWN_AUTHORS = 3;

/**
 * The threads holding an approval back, in words, or null when there are none: "2 unresolved review threads
 * (@coderabbitai, @bob) may be holding it back: 1 waiting on a reply, 1 answered and waiting on the reviewer".
 */
export function approvalBlockReason(block: ApprovalBlock | null): string | null {
  if (!block || block.threads === 0) return null;
  const names = block.authors.map((a) => (a ? `@${a}` : "a deleted account"));
  const shown = names.slice(0, SHOWN_AUTHORS).join(", ");
  const more = names.length - SHOWN_AUTHORS;
  const who = names.length === 0 ? "" : ` (${more > 0 ? `${shown} and ${more} more` : shown})`;
  const parts = [
    block.waiting > 0 ? `${block.waiting} waiting on a reply` : "",
    block.answered > 0 ? `${block.answered} answered and waiting on the reviewer` : "",
  ].filter(Boolean);
  const count = `${block.threads} unresolved review thread${block.threads === 1 ? "" : "s"}`;
  return `${count}${who} may be holding it back${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`;
}

/**
 * The review line for a PR waiting on an approval, as the board shows it: "Needs approval", or "Needs approval · " and
 * the reason (`approvalBlockReason`). Null for a PR that isn't waiting for one.
 */
export function approvalBlockText(snapshot: PrSnapshot | null | undefined): string | null {
  const block = approvalBlock(snapshot);
  if (!block) return null;
  const reason = approvalBlockReason(block);
  return reason ? `Needs approval · ${reason}` : "Needs approval";
}
