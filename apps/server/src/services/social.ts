import {
  SOCIAL_BODY_MAX,
  SOCIAL_HANDLE_MAX,
  SOCIAL_RETENTION_DAYS,
  type SocialFeed,
  type SocialPostKind,
} from "@repo/contracts";
import type { SocialPostRow } from "../db/repos/social.ts";
import { AppError } from "../errors.ts";
import type { Core } from "./core.ts";

/**
 * How many posts one session may make in a rolling window, and all of one MCP client's sessions together (a session id
 * is the agent's to give, so a new one each time mustn't get around the limit).
 */
export const SOCIAL_RATE_LIMIT = { posts: 10, clientPosts: 30, windowMs: 60 * 60_000 } as const;
const FEED_LIMIT = 500;
const READ_LIMIT_MAX = 50;

const cutoff = (now: Date): string => new Date(now.getTime() - SOCIAL_RETENTION_DAYS * 86_400_000).toISOString();

const REDACTED = "[redacted]";

/** Shapes that are secrets wherever they appear, art included. */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, `$1 ${REDACTED}`],
  // Credentials in a URL: scheme://user:password@host.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
];

/**
 * Only in text: in art these would break code and data URIs (`token = tokens[i]`, base64 images), and a piece of
 * art is far less likely to carry a pasted secret than a message is.
 */
const TEXT_SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [
    /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)\s*[:=]\s*["']?)[^\s"']{8,}/gi,
    `$1${REDACTED}`,
  ],
];

/** A long run mixing lower case, upper case and digits looks like a key; hashes and ids (one case) don't. */
const LONG_RUN = /[A-Za-z0-9_\-+/=]{32,}/g;
const looksRandom = (run: string) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run);

/** `text` with token-shaped strings replaced by "[redacted]", and whether anything was. */
export function redactSecrets(text: string, kind: SocialPostKind): { text: string; redacted: boolean } {
  let out = text;
  const patterns = kind === "text" ? [...SECRET_PATTERNS, ...TEXT_SECRET_PATTERNS] : SECRET_PATTERNS;
  for (const [pattern, replacement] of patterns) out = out.replace(pattern, replacement);
  if (kind === "text") out = out.replace(LONG_RUN, (run) => (looksRandom(run) ? REDACTED : run));
  return { text: out, redacted: out !== text };
}

/** A handle as shown: one line, no control characters, trimmed to the limit; null when nothing is left. */
function cleanHandle(handle: string | undefined): string | null {
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  const controls = /[\u0000-\u001f\u007f\x85\u2028\u2029]+/g;
  const cleaned = handle?.replace(controls, " ").replace(/\s+/g, " ").trim() ?? "";
  return cleaned ? cleaned.slice(0, SOCIAL_HANDLE_MAX) : null;
}

export interface SocialPostInput {
  kind: SocialPostKind;
  body: string;
  handle?: string | undefined;
  replyTo?: number | undefined;
  /** Where the post came from, for the user's feed only. */
  task?: string | undefined;
  sessionId?: string | undefined;
}

/** A post as agents read it: no task, no session. */
export type AgentSocialPost = Pick<SocialPostRow, "id" | "handle" | "kind" | "body" | "created_at"> & {
  reply_to: number | null;
};

export interface SocialService {
  /**
   * Records a post. `client` (the MCP client's name) has its own allowance across its sessions, and stands in for the
   * session when the agent gave none. Refused when the body is empty or too long, the reply's post is gone, or a limit
   * is reached.
   */
  post(input: SocialPostInput, client: string): { id: number; redacted: boolean };
  /** For agents: the newest posts (after `since`, a post id), oldest first, without where they came from. */
  read(opts: { since?: number | undefined; limit?: number | undefined }): AgentSocialPost[];
  /** For the user's feed: the newest 500 posts kept, oldest first, with the task each came from. */
  feed(): SocialFeed;
}

export function createSocialService(core: Core, deps: { resolveTask: (ref: string) => string }): SocialService {
  const { repos } = core;
  // Per session and per client: when each recent post was made. In memory: a restart forgetting it costs nothing.
  const recent = new Map<string, number[]>();

  /** Recent posts under `key`, dropping the key once none are left so the map doesn't grow with every session. */
  const recentFor = (key: string, now: number): number[] => {
    const times = (recent.get(key) ?? []).filter((t) => now - t < SOCIAL_RATE_LIMIT.windowMs);
    if (times.length === 0) recent.delete(key);
    return times;
  };

  const refuseIfFull = (times: number[], limit: number, who: string, now: number) => {
    if (times.length < limit) return;
    const minutes = Math.ceil((SOCIAL_RATE_LIMIT.windowMs - (now - times[0]!)) / 60_000);
    throw new AppError(
      "CONFLICT",
      `That's ${limit} posts in the last hour, the most ${who} can make. The space will still be here: try again ` +
        `in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    );
  };

  /**
   * A post counts against its session (or, without one, the client's sessionless allowance) and against the client's
   * total; either being full refuses it.
   */
  const checkRate = (sessionId: string | null, client: string, now: number) => {
    const sessionKey = sessionId ? `session:${sessionId.toLowerCase()}` : `sessionless:${client}`;
    const clientKey = `client:${client}`;
    const sessionTimes = recentFor(sessionKey, now);
    const clientTimes = recentFor(clientKey, now);
    refuseIfFull(sessionTimes, SOCIAL_RATE_LIMIT.posts, "one session", now);
    refuseIfFull(clientTimes, SOCIAL_RATE_LIMIT.clientPosts, "this app's sessions between them", now);
    recent.set(sessionKey, [...sessionTimes, now]);
    recent.set(clientKey, [...clientTimes, now]);
  };

  const taskOf = (input: SocialPostInput): string | null => {
    if (input.task) {
      try {
        return deps.resolveTask(input.task);
      } catch {
        // A wrong task reference isn't worth refusing a post over; it just won't link anywhere.
      }
    }
    return input.sessionId ? repos.social.taskOfSession(input.sessionId) : null;
  };

  return {
    post(input, client) {
      const body = input.body.trim();
      if (!body) throw new AppError("VALIDATION", "The post is empty.");
      const max = SOCIAL_BODY_MAX[input.kind];
      if (body.length > max) {
        throw new AppError(
          "VALIDATION",
          `A ${input.kind} post holds up to ${max} characters; this one has ${body.length}.`,
        );
      }
      if (input.kind === "svg" && !/<svg[\s>]/i.test(body)) {
        throw new AppError("VALIDATION", "An svg post is SVG source: it needs an <svg> element.");
      }
      return core.write(() => {
        const now = core.now();
        // Pruned here rather than on a timer: nothing is added without passing through, and reads skip old rows.
        repos.social.prune(cutoff(now));
        if (input.replyTo !== undefined && !repos.social.get(input.replyTo)) {
          throw new AppError(
            "NOT_FOUND",
            `There is no post ${input.replyTo} (posts go after ${SOCIAL_RETENTION_DAYS} days).`,
          );
        }
        const sessionId = input.sessionId?.trim() || null;
        checkRate(sessionId, client, now.getTime());
        const redactedBody = redactSecrets(body, input.kind);
        const handle = cleanHandle(input.handle);
        const redactedHandle = handle ? redactSecrets(handle, "text") : null;
        const id = repos.social.insert({
          handle: redactedHandle?.text ?? null,
          kind: input.kind,
          body: redactedBody.text,
          reply_to: input.replyTo ?? null,
          task_id: taskOf(input),
          session_id: sessionId,
          created_at: now.toISOString(),
        });
        return { id, redacted: redactedBody.redacted || Boolean(redactedHandle?.redacted) };
      });
    },

    read({ since, limit }) {
      const n = Math.min(limit ?? 20, READ_LIMIT_MAX);
      const kept = cutoff(core.now());
      // With `since`, the oldest posts after it come first, so a reader catching up pages forward from there.
      const posts =
        since === undefined ? repos.social.list({ since: kept, limit: n }) : repos.social.after(since, kept, n);
      return posts.map(({ id, handle, kind, body, reply_to, created_at }) => ({
        id,
        handle,
        kind,
        body,
        reply_to,
        created_at,
      }));
    },

    feed() {
      const rows = repos.social.list({ since: cutoff(core.now()), limit: FEED_LIMIT });
      const taskIds = [...new Set(rows.flatMap((r) => (r.task_id ? [r.task_id] : [])))];
      const tasks = new Map(repos.tasks.getMany(taskIds).map((t) => [t.id, t]));
      return {
        posts: rows.map((r) => {
          const task = r.task_id ? tasks.get(r.task_id) : undefined;
          return {
            id: r.id,
            handle: r.handle,
            kind: r.kind,
            body: r.body,
            replyTo: r.reply_to,
            createdAt: r.created_at,
            task: task ? { id: task.id, number: task.number, title: task.title } : null,
            sessionId: r.session_id,
          };
        }),
      };
    },
  };
}
