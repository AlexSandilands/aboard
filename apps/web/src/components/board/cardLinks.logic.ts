import type { TaskLink } from "@repo/contracts";
import { isActiveThread, orderLinks } from "~/components/task/links.logic";

/**
 * Links shown on a card: PRs, active T3 threads and agent sessions, in the panel's order. Settled and archived
 * threads stay in the panel only, so they don't take up card space. Agent sessions are left off a task with a T3
 * thread, since a thread runs a Claude session underneath and would show twice.
 */
export function cardLinks(links: ReadonlyArray<TaskLink>): TaskLink[] {
  const hasThread = links.some((link) => link.kind === "t3_thread");
  return orderLinks(
    links.filter(
      (link) =>
        link.kind === "pr" ||
        (link.kind === "t3_thread" && isActiveThread(link.snapshot)) ||
        (link.kind === "agent_session" && !hasThread),
    ),
  );
}
