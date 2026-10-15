import type { TaskLink } from "@repo/contracts";
import { isActiveThread, orderLinks } from "~/components/task/links.logic";

/**
 * Links shown on a card: PRs and active T3 threads, in the panel's order. Settled and archived threads
 * stay in the panel only, so they don't take up card space.
 */
export function cardLinks(links: ReadonlyArray<TaskLink>): TaskLink[] {
  return orderLinks(
    links.filter((link) => link.kind === "pr" || (link.kind === "t3_thread" && isActiveThread(link.snapshot))),
  );
}
