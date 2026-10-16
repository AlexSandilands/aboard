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

/** T3 thread ids are UUIDs, or `thread:…` composites of them. */
const T3_THREAD_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|thread:[^\s/?#]+)$/i;

/** The T3 server this board found, as far as links need it. */
export interface T3Target {
  environmentId: string | null;
  origin: string | null;
}

/** Whether a value is a bare T3 thread id, as T3's "Copy thread ID" produces. */
export function isT3ThreadId(value: string): boolean {
  return T3_THREAD_ID.test(value.trim());
}

const safeDecode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/**
 * A thread named without its environment: a bare thread id, or a browser URL of the detected T3
 * (`<origin>/<environmentId>/<threadId>`). Both need `t3` to supply what the value lacks, so this is null
 * without it. Deep links carry their own environment and are handled by `classifyLink`.
 */
export function parseT3ThreadInput(value: string, t3: T3Target | null | undefined): T3ThreadRef | null {
  const input = value.trim();
  const environmentId = t3?.environmentId;
  if (!environmentId) return null;
  // T3 mints lower-case UUIDs; a retyped or upper-cased one must still match exactly.
  if (T3_THREAD_ID.test(input))
    return { environmentId, threadId: input.startsWith("thread:") ? input : input.toLowerCase() };
  const origin = t3.origin?.replace(/\/+$/, "");
  if (!origin || !input.toLowerCase().startsWith(`${origin.toLowerCase()}/`)) return null;
  const path = input.slice(origin.length + 1).replace(/[?#].*$/, "");
  const [env, thread, ...rest] = path.split("/");
  // The environment segment must match too, or any page of the T3 app would turn into a thread link.
  if (!env || !thread || rest.some(Boolean) || safeDecode(env) !== environmentId) return null;
  return { environmentId, threadId: safeDecode(thread) };
}

/**
 * Infers link kind from user/agent input: GitHub/ADO/Bitbucket PR URLs, Jira keys or
 * /browse/ URLs, t3code:// thread deep links, otherwise a plain URL. With `t3` (the detected T3 server),
 * bare thread ids and that server's browser URLs are thread links too.
 */
export function classifyLink(
  value: string,
  opts: { jiraBaseUrl?: string | null; t3?: T3Target | null } = {},
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

  const t3Ref = parseT3ThreadInput(input, opts.t3);
  if (t3Ref) return { kind: "t3_thread", url: t3DesktopThreadUrl(t3Ref), ref: t3Ref };

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
