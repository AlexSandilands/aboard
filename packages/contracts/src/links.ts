import type { LinkKind, PrRef, T3ThreadRef } from "./schemas.ts";

export type ClassifiedLink =
  | { kind: "pr"; url: string; ref: PrRef | null }
  | { kind: "jira"; url: string; key: string }
  | { kind: "t3_thread"; url: string; ref: T3ThreadRef }
  | { kind: "url"; url: string };

const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const GITHUB_PR = /^https?:\/\/(github\.com)\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i;
const ADO_PR = /^https?:\/\/[^/\s]*(dev\.azure\.com|visualstudio\.com)\/.+\/pullrequest\/(\d+)/i;
const BITBUCKET_PR = /^https?:\/\/bitbucket\.org\/([^/\s]+\/[^/\s]+)\/pull-requests\/(\d+)/i;
const T3_DEEP_LINK = /^t3code(?:-[a-z]+)?:\/\/threads\/([^/\s]+)\/([^/?#\s]+)/i;
const JIRA_BROWSE = /\/browse\/([A-Z][A-Z0-9_]+-\d+)(?:[/?#]|$)/;

/**
 * Infers link kind from user/agent input: GitHub/ADO/Bitbucket PR URLs, Jira keys or
 * /browse/ URLs, t3code:// thread deep links, otherwise a plain URL.
 */
export function classifyLink(
  value: string,
  opts: { jiraBaseUrl?: string | null } = {},
): ClassifiedLink | null {
  const input = value.trim();
  if (!input) return null;

  if (JIRA_KEY.test(input)) {
    const base = opts.jiraBaseUrl?.replace(/\/+$/, "");
    return { kind: "jira", key: input, url: base ? `${base}/browse/${input}` : input };
  }

  const t3 = T3_DEEP_LINK.exec(input);
  if (t3) {
    return {
      kind: "t3_thread",
      url: input,
      ref: { environmentId: decodeURIComponent(t3[1]!), threadId: decodeURIComponent(t3[2]!) },
    };
  }

  const gh = GITHUB_PR.exec(input);
  if (gh) {
    return { kind: "pr", url: input, ref: { host: gh[1]!.toLowerCase(), repo: gh[2]!, number: Number(gh[3]) } };
  }
  if (ADO_PR.test(input) || BITBUCKET_PR.test(input)) {
    return { kind: "pr", url: input, ref: null };
  }

  const jiraUrl = JIRA_BROWSE.exec(input);
  if (jiraUrl && /^https?:\/\//i.test(input)) {
    return { kind: "jira", url: input, key: jiraUrl[1]! };
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return { kind: "url", url: input };
  return null;
}

export function isLinkKind(value: string): value is LinkKind {
  return value === "pr" || value === "jira" || value === "t3_thread" || value === "url";
}

/** Deep link that opens a thread in the T3 Code desktop app. */
export function t3DesktopThreadUrl(ref: T3ThreadRef): string {
  return `t3code://threads/${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.threadId)}`;
}

/** URL that opens a thread in a browser already paired with the T3 server at `origin`. */
export function t3BrowserThreadUrl(origin: string, ref: T3ThreadRef): string {
  return `${origin.replace(/\/+$/, "")}/${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.threadId)}`;
}
