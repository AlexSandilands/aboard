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
