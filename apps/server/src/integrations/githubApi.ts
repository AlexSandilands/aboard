import type { GithubHostStatus } from "@repo/contracts";
import { z } from "zod";
import { GhError, type RunGh } from "./gh.ts";
import type { FetchFn } from "./t3.ts";

const REQUEST_TIMEOUT_MS = 30_000;
/** How long a token is reused before `gh` is asked again, so a `gh auth switch` applies soon. */
const TOKEN_TTL_MS = 5 * 60_000;

/**
 * Where the GraphQL API for a host lives. github.com and GHE.com data residency serve it from an
 * `api.` subdomain; GitHub Enterprise Server serves it under `/api` on the instance itself.
 */
export function githubGraphqlUrl(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (normalized === "github.com") return "https://api.github.com/graphql";
  if (normalized.endsWith(".ghe.com")) return `https://api.${normalized}/graphql`;
  return `https://${normalized}/api/graphql`;
}

export type GithubApiErrorKind =
  /** `gh` is not installed. */
  | "cli_missing"
  /** `gh` holds no login for the host. */
  | "not_signed_in"
  /** GitHub refused the token (401). */
  | "unauthorized"
  | "rate_limited"
  | "not_found"
  /** The request never got an answer: network, timeout. */
  | "request"
  /** GitHub answered with a failure, usually a GraphQL `errors` list. */
  | "response";

/** A GitHub failure whose message is safe to show: GitHub's own words, never a token. */
export class GithubApiError extends Error {
  constructor(
    readonly kind: GithubApiErrorKind,
    readonly host: string,
    message: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

/**
 * Failures another try may get past: GitHub itself failing ("an internal error occurred, please try again", `HTTP 5xx`
 * as the client reports it), the network, a timeout, a rate limit. Anything else (a refusal, a missing PR) won't change.
 */
const TRANSIENT_FAILURE =
  /try again|internal error|timed? ?out|econn|fetch failed|socket|rate limit|unavailable|\bHTTP 5\d\d\b/i;

export function isTransientGithubError(error: unknown): boolean {
  if (error instanceof GithubApiError && (error.kind === "request" || error.kind === "rate_limited")) return true;
  return TRANSIENT_FAILURE.test(error instanceof Error ? error.message : String(error));
}

// ── Tokens ───────────────────────────────────────────────────────────────

export interface GithubTokens {
  /** The token `gh` holds for the host. Never log it or send it to the web app. */
  get(host: string): Promise<{ token: string; cached: boolean }>;
  /** Forgets the host's token, after GitHub refused it. */
  clear(host: string): void;
}

/** Asks `gh auth token --hostname <host>` and keeps the answer in memory for a few minutes. */
export function createGhTokens(deps: { runGh: RunGh; now?: () => number }): GithubTokens {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { token: string; expiresAt: number }>();
  return {
    async get(host) {
      const key = host.toLowerCase();
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) return { token: hit.token, cached: true };
      let stdout: string;
      try {
        stdout = await deps.runGh(["auth", "token", "--hostname", key], {
          timeoutMs: 15_000,
        });
      } catch (error) {
        if (error instanceof GhError && error.notFound) {
          throw new GithubApiError("cli_missing", key, "GitHub CLI (gh) is not installed");
        }
        throw new GithubApiError(
          "not_signed_in",
          key,
          `Not signed in to ${key}: run \`gh auth login --hostname ${key}\``,
        );
      }
      const token = stdout.trim();
      if (!token) {
        throw new GithubApiError(
          "not_signed_in",
          key,
          `Not signed in to ${key}: run \`gh auth login --hostname ${key}\``,
        );
      }
      cache.set(key, { token, expiresAt: now() + TOKEN_TTL_MS });
      return { token, cached: false };
    },
    clear(host) {
      cache.delete(host.toLowerCase());
    },
  };
}

// ── Auth status ──────────────────────────────────────────────────────────

const AuthStatusJson = z.object({
  hosts: z.record(
    z.string(),
    z.array(
      z
        .object({
          state: z.string(),
          active: z.boolean().optional(),
          host: z.string().optional(),
          login: z.string().optional(),
        })
        .loose(),
    ),
  ),
});

/**
 * Parses `gh auth status --json hosts` into one entry per host: its active (or first signed-in)
 * account. Null when the output isn't that shape, as from a `gh` too old for `--json`.
 */
export function parseGhAuthStatus(stdout: string): GithubHostStatus[] | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = AuthStatusJson.safeParse(json);
  if (!parsed.success) return null;
  return Object.entries(parsed.data.hosts).map(([host, accounts]) => {
    const signedIn = accounts.filter((a) => a.state === "success");
    const account = signedIn.find((a) => a.active) ?? signedIn[0] ?? accounts[0];
    return {
      host: host.toLowerCase(),
      login: account?.login ?? null,
      authenticated: signedIn.length > 0,
    };
  });
}

// ── GraphQL ──────────────────────────────────────────────────────────────

const GraphqlBody = z
  .object({
    data: z.unknown().optional(),
    errors: z
      .array(
        z
          .object({
            type: z.string().optional(),
            message: z.string().optional(),
            path: z.array(z.union([z.string(), z.number()])).optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

/** One entry of a GraphQL `errors` list. `path` names the field that failed, such as an alias. */
export interface GraphqlError {
  type?: string | undefined;
  message?: string | undefined;
  path?: Array<string | number> | undefined;
}

export interface GithubApi {
  /** Sends one GraphQL document to the host and resolves its `data`. Throws GithubApiError. */
  graphql(host: string, query: string, variables?: Record<string, unknown>): Promise<unknown>;
  /**
   * Like `graphql`, but a batch of aliased fields can partly fail: GitHub answers the rest in `data`
   * and lists the failures in `errors`. Throws only when nothing came back, or on a rate limit.
   */
  graphqlBatch(
    host: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{ data: unknown; errors: GraphqlError[] }>;
}

export function createGithubApi(deps: { tokens: GithubTokens; fetch?: FetchFn; timeoutMs?: number }): GithubApi {
  const fetchFn: FetchFn = deps.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const send = async (host: string, token: string, body: string): Promise<Response> => {
    try {
      return await fetchFn(githubGraphqlUrl(host), {
        method: "POST",
        headers: {
          authorization: `bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new GithubApiError(
        "request",
        host,
        timedOut ? `GitHub at ${host} timed out` : `Could not reach GitHub at ${host}`,
      );
    }
  };

  const request = async (
    rawHost: string,
    query: string,
    variables: Record<string, unknown>,
    partial: boolean,
  ): Promise<{ data: unknown; errors: GraphqlError[] }> => {
    const host = rawHost.toLowerCase();
    const body = JSON.stringify({ query, variables });
    let { token, cached } = await deps.tokens.get(host);
    let response = await send(host, token, body);
    // A cached token may have been revoked or switched since; ask gh once more before failing.
    if (response.status === 401 && cached) {
      deps.tokens.clear(host);
      ({ token, cached } = await deps.tokens.get(host));
      response = await send(host, token, body);
    }
    if (response.status === 401) {
      deps.tokens.clear(host);
      throw new GithubApiError(
        "unauthorized",
        host,
        `GitHub refused the credential for ${host}: run \`gh auth login --hostname ${host}\``,
      );
    }
    const text = await response.text();
    return classifyGraphqlResponse(host, response.status, response.headers, text, partial);
  };

  return {
    graphql: async (host, query, variables = {}) => (await request(host, query, variables, false)).data,
    graphqlBatch: (host, query, variables = {}) => request(host, query, variables, true),
  };
}

/**
 * GitHub reports a failed GraphQL document with HTTP 200 and an `errors` list, so the body is read
 * for errors as well as the status. With `partial`, data that came back alongside errors is returned
 * with them, for batches whose items fail one by one.
 */
export function classifyGraphqlResponse(
  host: string,
  status: number,
  headers: Headers,
  text: string,
  partial = false,
): { data: unknown; errors: GraphqlError[] } {
  let body: z.infer<typeof GraphqlBody> | null = null;
  try {
    const parsed = GraphqlBody.safeParse(JSON.parse(text));
    if (parsed.success) body = parsed.data;
  } catch {
    // Not JSON: an HTML error page instead of the API's answer.
  }
  const errors = body?.errors && body.errors.length > 0 ? body.errors : null;
  const messages = errors?.flatMap((e) => (e.message ? [e.message] : [])) ?? [];
  const remainingZero = headers.get("x-ratelimit-remaining") === "0";
  if (
    status === 429 ||
    (status === 403 && (remainingZero || headers.has("retry-after") || /rate limit/i.test(text))) ||
    (errors && (remainingZero || errors.some((e) => e.type === "RATE_LIMITED"))) ||
    messages.some((m) => /rate limit (already )?exceeded/i.test(m))
  ) {
    throw new GithubApiError("rate_limited", host, `GitHub API rate limit exceeded on ${host}`);
  }
  const hasData = body?.data !== undefined && body.data !== null;
  if (partial && hasData && status >= 200 && status < 300) return { data: body!.data, errors: errors ?? [] };
  if (status === 404 || (errors && errors.every((e) => e.type === "NOT_FOUND"))) {
    throw new GithubApiError(
      "not_found",
      host,
      messages[0] ?? "GitHub could not find it, or the signed-in account cannot see it",
    );
  }
  if (errors) {
    throw new GithubApiError("response", host, messages.length > 0 ? messages.join("; ") : "GitHub returned an error");
  }
  if (status < 200 || status >= 300 || !body) {
    throw new GithubApiError("response", host, `GitHub at ${host} returned HTTP ${status}`);
  }
  return { data: body.data, errors: [] };
}
