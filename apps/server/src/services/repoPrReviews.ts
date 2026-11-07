import type { RepoPrReviewState } from "../db/repos/repoPrReviews.ts";
import type { Core } from "./core.ts";
import type { NotificationsService } from "./notifications.ts";

export type { RepoPrReviewState };

/**
 * What Review PRs last did on other people's PRs (docs/features/autopilot.md#other-peoples-prs): the hand-off comment
 * to edit, the manual task, and the clean PRs waiting for the user's approval, which Needs you lists.
 */
export interface RepoPrReviewsService {
  get(host: string, repo: string, number: number): RepoPrReviewState | null;
  inRepo(host: string, repo: string): RepoPrReviewState[];
  /** Clean PRs waiting for the user's approval, oldest first. */
  ready(): RepoPrReviewState[];
  /** Saves the PR's state, replacing what was there. */
  record(state: RepoPrReviewState): void;
  /** Lifts the PR off Needs you (and marks its notice read); false when it wasn't on it. */
  clearReady(host: string, repo: string, number: number): boolean;
  /** Forgets the PR's manual task. */
  clearTask(host: string, repo: string, number: number): void;
}

/** The notification's dedupe key prefix for a PR ready for approval, so lifting it marks the notice read. */
export const readyNoticeKey = (host: string, repo: string, number: number): string =>
  `pr-ready:${host}/${repo}#${number}:`;

export function createRepoPrReviewsService(
  core: Core,
  deps: { notifications: NotificationsService },
): RepoPrReviewsService {
  const { repos } = core;
  return {
    get: (host, repo, number) => repos.repoPrReviews.get(host, repo, number),
    inRepo: (host, repo) => repos.repoPrReviews.inRepo(host, repo),
    ready: () => repos.repoPrReviews.ready(),
    record(state) {
      core.write((fx) => {
        repos.repoPrReviews.upsert(state);
        fx.autopilot();
      });
    },
    clearReady(host, repo, number) {
      return core.write((fx) => {
        const cleared = repos.repoPrReviews.clearReady(host, repo, number, core.now().toISOString());
        if (cleared) {
          deps.notifications.resolve({ keyPrefix: readyNoticeKey(host, repo, number) });
          fx.autopilot();
        }
        return cleared;
      });
    },
    clearTask(host, repo, number) {
      core.write(() => {
        repos.repoPrReviews.clearTask(host, repo, number, core.now().toISOString());
      });
    },
  };
}
