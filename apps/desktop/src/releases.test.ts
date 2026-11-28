import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReleaseFeed } from "./releases.ts";

const repo = { owner: "acme", repo: "board" };

const entry = (tag: string) => ({
  tag_name: tag,
  name: null,
  body: `## Highlights\n- In ${tag}`,
  draft: false,
  prerelease: false,
  published_at: "2026-11-20T10:00:00Z",
  html_url: `https://github.com/acme/board/releases/tag/${tag}`,
});

const answer = (body: unknown, status = 200) =>
  vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("ReleaseFeed", () => {
  it("reads the repo's releases from the GitHub API, up to the running version", async () => {
    const fetch = answer([entry("v1.5.0"), entry("v1.4.2"), entry("v1.4.0")]);
    const feed = new ReleaseFeed({ repo, currentVersion: "1.4.2", fetch });
    const list = await feed.list();
    expect(list.ok && list.releases.map((r) => r.version)).toEqual(["1.4.2", "1.4.0"]);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/acme/board/releases?per_page=100");
  });

  it("shows every release in a build from source", async () => {
    const feed = new ReleaseFeed({ repo, currentVersion: "0.0.0", fetch: answer([entry("v1.5.0")]) });
    const list = await feed.list();
    expect(list.ok && list.releases.map((r) => r.version)).toEqual(["1.5.0"]);
  });

  it("asks GitHub once per run, even when asked twice at once", async () => {
    const fetch = answer([entry("v1.4.0")]);
    const feed = new ReleaseFeed({ repo, currentVersion: "1.4.2", fetch });
    await Promise.all([feed.list(), feed.list()]);
    await feed.list();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a failure with the release page, and tries again next time", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("net::ERR_INTERNET_DISCONNECTED"))
      .mockResolvedValueOnce(new Response(JSON.stringify([entry("v1.4.0")])));
    const feed = new ReleaseFeed({ repo, currentVersion: "1.4.2", fetch });
    expect(await feed.list()).toEqual({
      ok: false,
      error: "Couldn't reach GitHub.",
      url: "https://github.com/acme/board/releases",
    });
    expect((await feed.list()).ok).toBe(true);
  });

  it("says so when GitHub's rate limit is reached", async () => {
    const feed = new ReleaseFeed({ repo, currentVersion: "1.4.2", fetch: answer({ message: "rate limit" }, 403) });
    expect(await feed.list()).toMatchObject({ ok: false, error: expect.stringMatching(/rate limit/) });
  });

  it("refuses an answer that isn't a list", async () => {
    const feed = new ReleaseFeed({ repo, currentVersion: "1.4.2", fetch: answer({ message: "Not Found" }) });
    expect(await feed.list()).toMatchObject({ ok: false, error: "GitHub's answer wasn't a list of releases." });
  });

  it("has nothing to read without a repo, and never fetches", async () => {
    const fetch = answer([]);
    const feed = new ReleaseFeed({ repo: null, currentVersion: "1.4.2", fetch });
    expect(await feed.list()).toMatchObject({ ok: false, url: null });
    expect(fetch).not.toHaveBeenCalled();
  });
});
