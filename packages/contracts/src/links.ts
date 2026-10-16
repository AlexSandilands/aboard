import type { IssueRef, LinkKind, PrRef, T3ThreadRef } from "./schemas.ts";

export type ClassifiedLink =
  | { kind: "pr"; url: string; ref: PrRef | null }
  | { kind: "jira"; url: string; key: string }
  | { kind: "t3_thread"; url: string; ref: T3ThreadRef }
  | { kind: "issue"; url: string; ref: IssueRef }
  | { kind: "url"; url: string };

const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
// Any host, since GitHub Enterprise lives on its own domains. The server decides which hosts to poll.
const GITHUB_PR = /^https?:\/\/([^/\s?#@]+)\/([^/\s?#]+\/[^/\s?#]+)\/pull\/(\d+)(?:[/?#]|$)/i;
const GITHUB_ISSUE = /^https?:\/\/([^/\s?#@]+)\/([^/\s?#]+\/[^/\s?#]+)\/issues\/(\d+)(?:[/?#]|$)/i;
const ADO_PR = /^https?:\/\/[^/\s]*(dev\.azure\.com|visualstudio\.com)\/.+\/pullrequest\/(\d+)/i;
const BITBUCKET_PR = /^https?:\/\/bitbucket\.org\/([^/\s]+\/[^/\s]+)\/pull-requests\/(\d+)/i;
const T3_DEEP_LINK = /^t3code(?:-[a-z]+)?:\/\/threads\/([^/\s]+)\/([^/?#\s]+)/i;
const JIRA_BROWSE = /\/browse\/([A-Z][A-Z0-9_]+-\d+)(?:[/?#]|$)/;

/**
 * Infers link kind from user/agent input: GitHub-style PR URLs on any host (`/<owner>/<repo>/pull/<n>`),
 * ADO/Bitbucket PR URLs, GitHub issue URLs (`.../issues/<n>`), Jira keys or /browse/ URLs, t3code:// thread
 * deep links, otherwise a plain URL.
 */
export function classifyLink(value: string, opts: { jiraBaseUrl?: string | null } = {}): ClassifiedLink | null {
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

  if (ADO_PR.test(input) || BITBUCKET_PR.test(input)) {
    return { kind: "pr", url: input, ref: null };
  }
  const gh = GITHUB_PR.exec(input);
  if (gh) {
    return { kind: "pr", url: input, ref: { host: gh[1]!.toLowerCase(), repo: gh[2]!, number: Number(gh[3]) } };
  }

  const issue = GITHUB_ISSUE.exec(input);
  if (issue) {
    return {
      kind: "issue",
      url: input,
      ref: { host: issue[1]!.toLowerCase(), repo: issue[2]!, number: Number(issue[3]) },
    };
  }

  const jiraUrl = JIRA_BROWSE.exec(input);
  if (jiraUrl && /^https?:\/\//i.test(input)) {
    return { kind: "jira", url: input, key: jiraUrl[1]! };
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return { kind: "url", url: input };
  return null;
}

// Uppercase only: lowercase "utf-8" or "abc-123" in prose is rarely an issue key. Lookarounds keep
// "ISO-8601-1" and "foo_ABC-1" from matching part-way, while "/browse/ABC-1" and "(ABC-1)." still do.
const JIRA_KEY_IN_TEXT = /(?<![A-Za-z0-9_-])[A-Z][A-Z0-9_]+-\d+(?![A-Za-z0-9_]|-\d)/g;

/** Prefixes of standards, encodings and identifiers that look like issue keys. */
const NOT_JIRA_PROJECTS = new Set([
  "AES",
  "CVE",
  "CWE",
  "ECMA",
  "GPT",
  "HMAC",
  "HTTP",
  "IEC",
  "IEEE",
  "ISO",
  "MD",
  "RFC",
  "RSA",
  "SHA",
  "TLS",
  "UTF",
  "WCAG",
]);

/** Jira keys (PROJ-123) mentioned in free text, de-duplicated in order of appearance. */
export function findJiraKeys(text: string | null | undefined): string[] {
  const keys: string[] = [];
  for (const match of text?.matchAll(JIRA_KEY_IN_TEXT) ?? []) {
    const key = match[0];
    const project = key.slice(0, key.lastIndexOf("-"));
    if (!NOT_JIRA_PROJECTS.has(project) && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function isLinkKind(value: string): value is LinkKind {
  return value === "pr" || value === "jira" || value === "t3_thread" || value === "issue" || value === "url";
}

/** An issue a task can be created from: what to link, and the title to show until its details are fetched. */
export type IssueSource =
  | { kind: "jira"; key: string; url: string; placeholder: string }
  | { kind: "issue"; ref: IssueRef; url: string; placeholder: string };

/**
 * Recognises text that is a Jira issue (a bare key like `PROJ-123` or a `/browse/PROJ-123` URL) or a GitHub issue
 * URL, and nothing else: a PR URL, other links and ordinary titles are null. Standards that look like keys
 * ("UTF-8") are not Jira keys.
 */
export function parseIssueSource(value: string, opts: { jiraBaseUrl?: string | null } = {}): IssueSource | null {
  const input = value.trim();
  if (!input || /\s/.test(input)) return null;
  const link = classifyLink(input, opts);
  if (link?.kind === "issue") {
    return { kind: "issue", ref: link.ref, url: link.url, placeholder: `${link.ref.repo}#${link.ref.number}` };
  }
  if (link?.kind === "jira" && !NOT_JIRA_PROJECTS.has(link.key.slice(0, link.key.lastIndexOf("-")))) {
    return { kind: "jira", key: link.key, url: link.url, placeholder: link.key };
  }
  return null;
}

/** Deep link that opens a thread in the T3 Code desktop app. */
export function t3DesktopThreadUrl(ref: T3ThreadRef): string {
  return `t3code://threads/${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.threadId)}`;
}

/** URL that opens a thread in a browser already paired with the T3 server at `origin`. */
export function t3BrowserThreadUrl(origin: string, ref: T3ThreadRef): string {
  return `${origin.replace(/\/+$/, "")}/${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.threadId)}`;
}
