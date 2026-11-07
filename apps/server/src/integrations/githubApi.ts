import type { GitHostAccount } from "@repo/contracts";
import { z } from "zod";
import { GhError, type RunGh } from "./gh.ts";
import { GitHostError, type GitHostErrorReason } from "./gitHost.ts";
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

/** Where the REST API for a host lives, as for GraphQL: Enterprise Server serves it under `/api/v3`. */
export function githubRestUrl(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (normalized === "github.com") return "https://api.github.com";
  if (normalized.endsWith(".ghe.com")) return `https://api.${normalized}`;
  return `https://${normalized}/api/v3`;
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

const REASONS: Record<GithubApiErrorKind, GitHostErrorReason> = {
  cli_missing: "missing-tool",
  not_signed_in: "unauthenticated",
  unauthorized: "unauthenticated",
  rate_limited: "rate-limited",
  not_found: "not-found",
  request: "transient",
  response: "failed",
};

/** A GitHub failure whose message is safe to show: GitHub's own words, never a token. */
export class GithubApiError extends GitHostError {
  constructor(
    readonly kind: GithubApiErrorKind,
    host: string,
    message: string,
  ) {
    super(REASONS[kind], host, message);
    this.name = "GithubApiError";
  }
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
export function parseGhAuthStatus(stdout: string): GitHostAccount[] | null {
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
  /**
   * One REST GET, for what GraphQL doesn't serve (a PR's file patches). `path` starts with `/` and may carry a query.
   * Resolves the JSON body. Throws GithubApiError.
   */
  rest(host: string, path: string): Promise<unknown>;
}

export function createGithubApi(deps: { tokens: GithubTokens; fetch?: FetchFn; timeoutMs?: number }): GithubApi {
  const fetchFn: FetchFn = deps.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const send = async (host: string, token: string, body: string | null, restPath?: string): Promise<Response> => {
    try {
      return await fetchFn(
        restPath === undefined ? githubGraphqlUrl(host) : `${githubRestUrl(host)}${restPath}`,
        body === null
          ? {
              method: "GET",
              headers: { authorization: `bearer ${token}`, accept: "application/vnd.github+json" },
              signal: AbortSignal.timeout(timeoutMs),
            }
          : {
              method: "POST",
              headers: {
                authorization: `bearer ${token}`,
                "content-type": "application/json",
                accept: "application/json",
              },
              body,
              signal: AbortSignal.timeout(timeoutMs),
            },
      );
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new GithubApiError(
        "request",
        host,
        timedOut ? `GitHub at ${host} timed out` : `Could not reach GitHub at ${host}`,
      );
    }
  };

  /** Sends with the host's token, asking gh again once when a cached token is refused. */
  const authorized = async (host: string, body: string | null, restPath?: string): Promise<Response> => {
    let { token, cached } = await deps.tokens.get(host);
    let response = await send(host, token, body, restPath);
    // A cached token may have been revoked or switched since; ask gh once more before failing.
    if (response.status === 401 && cached) {
      deps.tokens.clear(host);
      ({ token, cached } = await deps.tokens.get(host));
      response = await send(host, token, body, restPath);
    }
    if (response.status === 401) {
      deps.tokens.clear(host);
      throw new GithubApiError(
        "unauthorized",
        host,
        `GitHub refused the credential for ${host}: run \`gh auth login --hostname ${host}\``,
      );
    }
    return response;
  };

  const request = async (
    rawHost: string,
    query: string,
    variables: Record<string, unknown>,
    partial: boolean,
  ): Promise<{ data: unknown; errors: GraphqlError[] }> => {
    const host = rawHost.toLowerCase();
    const response = await authorized(host, JSON.stringify({ query, variables }));
    const text = await response.text();
    return classifyGraphqlResponse(host, response.status, response.headers, text, partial);
  };

  return {
    graphql: async (host, query, variables = {}) => (await request(host, query, variables, false)).data,
    graphqlBatch: (host, query, variables = {}) => request(host, query, variables, true),
    async rest(rawHost, path) {
      const host = rawHost.toLowerCase();
      const response = await authorized(host, null, path);
      return classifyRestResponse(host, response.status, response.headers, await response.text());
    },
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

/** A REST answer's JSON body, or the GithubApiError its status means. */
export function classifyRestResponse(host: string, status: number, headers: Headers, text: string): unknown {
  let body: unknown = undefined;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: an HTML error page instead of the API's answer.
  }
  const message =
    body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message
      : null;
  if (
    status === 429 ||
    (status === 403 &&
      (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after") || /rate limit/i.test(text)))
  ) {
    throw new GithubApiError("rate_limited", host, `GitHub API rate limit exceeded on ${host}`);
  }
  if (status === 404) {
    throw new GithubApiError(
      "not_found",
      host,
      message ?? "GitHub could not find it, or the signed-in account cannot see it",
    );
  }
  if (status < 200 || status >= 300 || body === undefined) {
    throw new GithubApiError("response", host, message ?? `GitHub at ${host} returned HTTP ${status}`);
  }
  return body;
}
