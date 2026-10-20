import type { AgentSessionRef } from "./agentSessions.ts";
import { LinkKind, type IssueRef, type PrRef, type T3ThreadRef } from "./schemas.ts";
import { matchTicketKey, matchTicketUrl, type TicketRef, type TicketSystem } from "./ticketSystems.ts";

export type ClassifiedLink =
  | { kind: "pr"; url: string; ref: PrRef | null }
  | { kind: "ticket"; url: string; ref: TicketRef }
  | { kind: "t3_thread"; url: string; ref: T3ThreadRef }
  | { kind: "issue"; url: string; ref: IssueRef }
  | { kind: "agent_session"; url: string; ref: AgentSessionRef }
  | { kind: "url"; url: string };

// Any host, since GitHub Enterprise lives on its own domains. The server decides which hosts to poll.
const GITHUB_PR = /^https?:\/\/([^/\s?#@]+)\/([^/\s?#]+\/[^/\s?#]+)\/pull\/(\d+)(?:[/?#]|$)/i;
const GITHUB_ISSUE = /^https?:\/\/([^/\s?#@]+)\/([^/\s?#]+\/[^/\s?#]+)\/issues\/(\d+)(?:[/?#]|$)/i;
const ADO_PR = /^https?:\/\/[^/\s]*(dev\.azure\.com|visualstudio\.com)\/.+\/pullrequest\/(\d+)/i;
const BITBUCKET_PR = /^https?:\/\/bitbucket\.org\/([^/\s]+\/[^/\s]+)\/pull-requests\/(\d+)/i;
const T3_DEEP_LINK = /^t3code(?:-[a-z]+)?:\/\/threads\/([^/\s]+)\/([^/?#\s]+)/i;

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
 * Infers link kind from user/agent input: GitHub-style PR URLs on any host (`/<owner>/<repo>/pull/<n>`),
 * ADO/Bitbucket PR URLs, GitHub issue URLs (`.../issues/<n>`), t3code:// thread deep links, then the configured
 * ticket systems' URLs and keys, otherwise a plain URL.
 * With `t3` (the detected T3 server), bare thread ids and that server's browser URLs are thread links too.
 */
export function classifyLink(
  value: string,
  opts: { ticketSystems?: readonly TicketSystem[] | null; t3?: T3Target | null } = {},
): ClassifiedLink | null {
  const input = value.trim();
  if (!input) return null;
  const systems = opts.ticketSystems ?? [];

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

  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
  const ticketUrl = isUrl ? matchTicketUrl(input, systems) : null;
  if (ticketUrl) return { kind: "ticket", url: input, ref: ticketUrl };
  // A bare key is stored as written, not as its template filled in: the page is worked out from the system when the
  // link is shown, so fixing a system's template later fixes the links made before.
  const ticketKey = isUrl ? null : matchTicketKey(input, systems);
  if (ticketKey) return { kind: "ticket", url: ticketKey.key, ref: ticketKey };

  if (isUrl) return { kind: "url", url: input };
  return null;
}

export function isLinkKind(value: string): value is LinkKind {
  return LinkKind.options.includes(value as LinkKind);
}

/** An issue a task can be created from: what to link, and the title to show until its details are fetched. */
export type IssueSource =
  | { kind: "ticket"; ref: TicketRef; url: string; placeholder: string }
  | { kind: "issue"; ref: IssueRef; url: string; placeholder: string };

/**
 * Recognises text that is a ticket of a configured system (a bare key or one of its URLs) or a GitHub issue URL,
 * and nothing else: a PR URL, other links and ordinary titles are null.
 */
export function parseIssueSource(
  value: string,
  opts: { ticketSystems?: readonly TicketSystem[] | null } = {},
): IssueSource | null {
  const input = value.trim();
  if (!input || /\s/.test(input)) return null;
  const link = classifyLink(input, opts);
  if (link?.kind === "issue") {
    return { kind: "issue", ref: link.ref, url: link.url, placeholder: `${link.ref.repo}#${link.ref.number}` };
  }
  if (link?.kind === "ticket") return { kind: "ticket", ref: link.ref, url: link.url, placeholder: link.ref.key };
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
