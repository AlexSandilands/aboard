import type { ClassifiedLink, T3ThreadStatus, TaskLink } from "@repo/contracts";

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
    case "url":
      return { kind: "url", label: `Link to ${hostnameOf(link.url) ?? link.url}` };
  }
}

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
