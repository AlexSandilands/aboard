import type { ClassifiedLink, IssueSnapshot, T3ThreadSnapshot, T3ThreadStatus, TaskLink } from "@repo/contracts";

/** What the "Add link" input will create, for the live preview. Null when unrecognised. */
export function describeLinkInput(link: ClassifiedLink | null): { kind: ClassifiedLink["kind"]; label: string } | null {
  if (!link) return null;
  switch (link.kind) {
    case "pr":
      return { kind: "pr", label: link.ref ? `Pull request ${link.ref.repo}#${link.ref.number}` : "Pull request" };
    case "jira":
      return { kind: "jira", label: `Jira issue ${link.key}` };
    case "t3_thread":
      return { kind: "t3_thread", label: "T3 Code thread" };
    case "issue":
      return { kind: "issue", label: `GitHub issue ${link.ref.repo}#${link.ref.number}` };
    case "url":
      return { kind: "url", label: `Link to ${hostnameOf(link.url) ?? link.url}` };
  }
}

/** GitHub's issue colours: green while open, purple once closed. */
export const ISSUE_STATE: Record<IssueSnapshot["state"], { label: string; tone: string }> = {
  open: { label: "Open", tone: "text-emerald-600 dark:text-emerald-300/90" },
  closed: { label: "Closed", tone: "text-violet-600 dark:text-violet-300/90" },
};

export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

/** Browse URL for a Jira link: the stored URL when it is one, else the configured base. */
export function jiraHref(
  link: Extract<TaskLink, { kind: "jira" }>,
  jiraBaseUrl: string | null | undefined,
): string | null {
  if (isWebUrl(link.url)) return link.url;
  const base = jiraBaseUrl?.trim().replace(/\/+$/, "");
  return base ? `${base}/browse/${link.ref.key}` : null;
}

export interface ThreadStatusPresentation {
  label: string;
  colorClass: string;
  dotClass: string;
}

/** Live T3 thread status, coloured like T3's sidebar status pills. Idle shows nothing. */
export function threadStatusPresentation(status: T3ThreadStatus): ThreadStatusPresentation | null {
  switch (status) {
    case "working":
      return {
        label: "Working",
        colorClass: "text-sky-600 dark:text-sky-300/80",
        dotClass: "bg-sky-500 dark:bg-sky-300/80",
      };
    case "waiting":
      return { label: "Waiting", colorClass: "text-muted-foreground", dotClass: "bg-muted-foreground" };
    case "input":
      return {
        label: "Awaiting Input",
        colorClass: "text-indigo-600 dark:text-indigo-300/90",
        dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      };
    case "approval":
      return {
        label: "Pending Approval",
        colorClass: "text-amber-600 dark:text-amber-300/90",
        dotClass: "bg-amber-500 dark:bg-amber-300/90",
      };
    case "failed":
      return {
        label: "Failed",
        colorClass: "text-red-600 dark:text-red-300/90",
        dotClass: "bg-red-500 dark:bg-red-300/90",
      };
    case "done":
      return {
        label: "Completed",
        colorClass: "text-emerald-600 dark:text-emerald-300/90",
        dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      };
    case "idle":
      return null;
  }
}

type ThreadLink = Extract<TaskLink, { kind: "t3_thread" }>;

/** Settled or archived threads are finished with. Without a snapshot we can't tell, so it counts as active. */
export function isActiveThread(snapshot: T3ThreadSnapshot | null): boolean {
  return !snapshot?.settled && !snapshot?.archived;
}

const STATUS_RANK: Record<T3ThreadStatus, number> = {
  approval: 0,
  input: 0,
  failed: 0,
  working: 1,
  waiting: 2,
  done: 3,
  idle: 3,
};

function threadRank(snapshot: T3ThreadSnapshot | null): number {
  if (!snapshot) return 3;
  if (snapshot.archived) return 5;
  if (snapshot.settled) return 4;
  return STATUS_RANK[snapshot.status];
}

const activityMs = (snapshot: T3ThreadSnapshot | null) => {
  const ms = snapshot?.lastActivityAt ? Date.parse(snapshot.lastActivityAt) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * Orders links for display. T3 threads gather at the first thread's position, sorted by what needs
 * the user (attention, working, waiting, finished, then settled and archived), most recent first.
 * Other links keep their order.
 */
export function orderLinks(links: ReadonlyArray<TaskLink>): TaskLink[] {
  const threads = links.filter((link): link is ThreadLink => link.kind === "t3_thread");
  if (threads.length < 2) return [...links];
  const sorted = threads.toSorted(
    (a, b) => threadRank(a.snapshot) - threadRank(b.snapshot) || activityMs(b.snapshot) - activityMs(a.snapshot),
  );
  const first = links.indexOf(threads[0]!);
  const others = links.filter((link) => link.kind !== "t3_thread");
  return [...others.slice(0, first), ...sorted, ...others.slice(first)];
}

/** Model is only worth showing when the task's threads don't all use the same one. */
export function threadModelsDiffer(links: ReadonlyArray<TaskLink>): boolean {
  const models = new Set(
    links.flatMap((link) => (link.kind === "t3_thread" && link.snapshot?.model ? [link.snapshot.model] : [])),
  );
  return models.size > 1;
}

/** Details that tell one linked thread from another, without the (client-ticking) relative time. */
export function threadDetails(snapshot: T3ThreadSnapshot | null, { showModel }: { showModel: boolean }): string[] {
  if (!snapshot) return [];
  return [
    snapshot.archived ? "Archived" : snapshot.settled ? "Settled" : null,
    snapshot.branch ?? null,
    showModel ? (snapshot.model ?? null) : null,
  ].filter((part): part is string => part !== null);
}
