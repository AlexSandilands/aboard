import { describe, expect, it } from "vitest";
import { GhError, type RunGh } from "./gh.ts";
import {
  classifyGraphqlResponse,
  createGhTokens,
  createGithubApi,
  GithubApiError,
  githubGraphqlUrl,
  parseGhAuthStatus,
} from "./githubApi.ts";
import type { FetchFn } from "./t3.ts";

// Built at runtime so no token-shaped literal sits in the source.
const fakeToken = (n: number) => ["fake", "credential", String(n)].join("-");

function fakeGh(tokens: string[]) {
  const calls: string[][] = [];
  const runGh: RunGh = async (args) => {
    calls.push(args);
    const next = tokens.shift();
    if (next === undefined) throw new GhError("no oauth token found", false);
    return `${next}\n`;
  };
  return { runGh, calls };
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; auth: string | null; body: unknown }[] = [];
  const fetch: FetchFn = async (url, init = {}) => {
    calls.push({
      url,
      auth: new Headers(init.headers).get("authorization"),
      body: JSON.parse(init.body as string),
    });
    return handler(url, init);
  };
  return { fetch, calls };
}

const caught = async (promise: Promise<unknown>): Promise<GithubApiError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GithubApiError) return error;
    throw error;
  }
  throw new Error("expected a GithubApiError");
};

describe("githubGraphqlUrl", () => {
  it("maps github.com, GHE.com and Enterprise Server hosts", () => {
    expect(githubGraphqlUrl("github.com")).toBe("https://api.github.com/graphql");
    expect(githubGraphqlUrl("GitHub.com")).toBe("https://api.github.com/graphql");
    expect(githubGraphqlUrl("example.ghe.com")).toBe("https://api.example.ghe.com/graphql");
    expect(githubGraphqlUrl("git.example.org")).toBe("https://git.example.org/api/graphql");
  });
});

describe("createGhTokens", () => {
  it("asks gh per host, caches for a few minutes, and forgets on clear", async () => {
    let now = 0;
    const gh = fakeGh([fakeToken(1), fakeToken(2), fakeToken(3)]);
    const tokens = createGhTokens({ runGh: gh.runGh, now: () => now });
    expect(await tokens.get("GitHub.com")).toEqual({ token: fakeToken(1), cached: false });
    expect(await tokens.get("github.com")).toEqual({ token: fakeToken(1), cached: true });
    expect(gh.calls).toEqual([["auth", "token", "--hostname", "github.com"]]);
    now = 6 * 60_000;
    expect(await tokens.get("github.com")).toEqual({ token: fakeToken(2), cached: false });
    tokens.clear("github.com");
    expect(await tokens.get("github.com")).toEqual({ token: fakeToken(3), cached: false });
  });

  it("reports a host with no login, and gh missing", async () => {
    const signedOut = createGhTokens({ runGh: fakeGh([]).runGh });
    expect(await caught(signedOut.get("ghe.example.com"))).toMatchObject({
      kind: "not_signed_in",
      message: expect.stringContaining("gh auth login --hostname ghe.example.com"),
    });
    const missing = createGhTokens({
      runGh: async () => {
        throw new GhError("gh CLI not found", true);
      },
    });
    expect(await caught(missing.get("github.com"))).toMatchObject({ kind: "cli_missing" });
    const empty = createGhTokens({ runGh: fakeGh(["  "]).runGh });
    expect(await caught(empty.get("github.com"))).toMatchObject({ kind: "not_signed_in" });
  });
});

describe("parseGhAuthStatus", () => {
  it("reports each host's active or first signed-in account", () => {
    const stdout = JSON.stringify({
      hosts: {
        "github.com": [
          { state: "success", active: false, host: "github.com", login: "old" },
          { state: "success", active: true, host: "github.com", login: "me" },
        ],
        "GHE.Example.com": [{ state: "error", active: true, host: "ghe.example.com", login: "work", error: "bad token" }],
      },
    });
    expect(parseGhAuthStatus(stdout)).toEqual([
      { host: "github.com", login: "me", authenticated: true },
      { host: "ghe.example.com", login: "work", authenticated: false },
    ]);
  });

  it("returns null for output that isn't the JSON shape", () => {
    expect(parseGhAuthStatus("github.com\n  ✓ Logged in to github.com")).toBeNull();
    expect(parseGhAuthStatus(JSON.stringify({ nope: 1 }))).toBeNull();
    expect(parseGhAuthStatus("")).toBeNull();
  });
});

describe("createGithubApi", () => {
  it("posts the query with the host's token and returns data", async () => {
    const net = fakeFetch(() => Response.json({ data: { viewer: { login: "me" } } }));
    const api = createGithubApi({ tokens: createGhTokens({ runGh: fakeGh([fakeToken(7)]).runGh }), fetch: net.fetch });
    expect(await api.graphql("ghe.example.com", "query Q($a: Int!) { x }", { a: 1 })).toEqual({ viewer: { login: "me" } });
    expect(net.calls).toEqual([
      {
        url: "https://ghe.example.com/api/graphql",
        auth: `bearer ${fakeToken(7)}`,
        body: { query: "query Q($a: Int!) { x }", variables: { a: 1 } },
      },
    ]);
  });

  it("fails at once when a fresh token is refused", async () => {
    let calls = 0;
    const gh = fakeGh([fakeToken(1), fakeToken(2)]);
    const net = fakeFetch((_url, init) => {
      calls += 1;
      const auth = new Headers(init.headers).get("authorization");
      return auth === `bearer ${fakeToken(2)}`
        ? Response.json({ data: { ok: true } })
        : new Response("", { status: 401 });
    });
    const api = createGithubApi({ tokens: createGhTokens({ runGh: gh.runGh }), fetch: net.fetch });
    // The first request has a fresh token: a 401 for it is final.
    expect(await caught(api.graphql("github.com", "q"))).toMatchObject({ kind: "unauthorized" });
    expect(await api.graphql("github.com", "q")).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("retries a refused cached token with a fresh one", async () => {
    const gh = fakeGh([fakeToken(1), fakeToken(2)]);
    let refuse = false;
    const net = fakeFetch((_url, init) => {
      const auth = new Headers(init.headers).get("authorization");
      if (refuse && auth === `bearer ${fakeToken(1)}`) return new Response("", { status: 401 });
      return Response.json({ data: { auth } });
    });
    const api = createGithubApi({ tokens: createGhTokens({ runGh: gh.runGh }), fetch: net.fetch });
    await api.graphql("github.com", "q");
    refuse = true;
    expect(await api.graphql("github.com", "q")).toEqual({ auth: `bearer ${fakeToken(2)}` });
  });

  it("turns a network failure into a request error", async () => {
    const api = createGithubApi({
      tokens: createGhTokens({ runGh: fakeGh([fakeToken(1)]).runGh }),
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await caught(api.graphql("github.com", "q"))).toMatchObject({ kind: "request" });
  });

  it("returns partial data with its errors for a batch", async () => {
    const api = createGithubApi({
      tokens: createGhTokens({ runGh: fakeGh([fakeToken(1)]).runGh }),
      fetch: async () =>
        Response.json({
          data: { repository: { pr0: { title: "ok" }, pr1: null } },
          errors: [{ type: "NOT_FOUND", path: ["repository", "pr1"], message: "Could not resolve" }],
        }),
    });
    expect(await api.graphqlBatch("github.com", "q")).toEqual({
      data: { repository: { pr0: { title: "ok" }, pr1: null } },
      errors: [{ type: "NOT_FOUND", path: ["repository", "pr1"], message: "Could not resolve" }],
    });
  });
});

describe("classifyGraphqlResponse", () => {
  const headers = (init: Record<string, string> = {}) => new Headers(init);
  const kindOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      return error instanceof GithubApiError ? error.kind : "other";
    }
    return "ok";
  };

  it("detects rate limits", () => {
    expect(kindOf(() => classifyGraphqlResponse("github.com", 429, headers(), ""))).toBe("rate_limited");
    expect(
      kindOf(() => classifyGraphqlResponse("github.com", 403, headers({ "x-ratelimit-remaining": "0" }), "{}")),
    ).toBe("rate_limited");
    expect(kindOf(() => classifyGraphqlResponse("github.com", 403, headers(), "secondary rate limit"))).toBe(
      "rate_limited",
    );
    expect(
      kindOf(() =>
        classifyGraphqlResponse("github.com", 200, headers(), JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] })),
      ),
    ).toBe("rate_limited");
    expect(
      kindOf(() =>
        classifyGraphqlResponse(
          "github.com",
          200,
          headers(),
          JSON.stringify({ errors: [{ message: "API rate limit already exceeded for user" }] }),
        ),
      ),
    ).toBe("rate_limited");
  });

  it("treats a GraphQL errors list as a failure with GitHub's message", () => {
    const body = JSON.stringify({ data: null, errors: [{ message: "Head branch was modified" }] });
    expect(() => classifyGraphqlResponse("github.com", 200, headers(), body)).toThrow("Head branch was modified");
    expect(
      kindOf(() =>
        classifyGraphqlResponse("github.com", 200, headers(), JSON.stringify({ errors: [{ type: "NOT_FOUND" }] })),
      ),
    ).toBe("not_found");
    expect(kindOf(() => classifyGraphqlResponse("github.com", 502, headers(), "<html>"))).toBe("response");
    expect(classifyGraphqlResponse("github.com", 200, headers(), JSON.stringify({ data: { a: 1 } }))).toEqual({
      data: { a: 1 },
      errors: [],
    });
  });
});
