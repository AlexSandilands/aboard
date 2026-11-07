import { describe, expect, it } from "vitest";
import { createGhTokens, createGithubApi, githubRestUrl, GithubApiError } from "./githubApi.ts";
import { diffPages, packPages, pageDiff, pickPage, type HostPrFile } from "./gitHost.ts";
import { createGithubReads } from "./githubReads.ts";
import type { FetchFn } from "./t3.ts";

const ref = { host: "github.com", repo: "acme/widgets", number: 7 };

/** A unified diff of `n` added lines. */
const patchOf = (n: number, prefix = "line") =>
  [`@@ -0,0 +1,${n} @@`, ...Array.from({ length: n }, (_, i) => `+${prefix} ${i + 1}`)].join("\n");

const fileJson = (name: string, lines: number, extra: Record<string, unknown> = {}) => ({
  filename: name,
  status: "modified",
  additions: lines,
  deletions: 0,
  patch: patchOf(lines, name),
  ...extra,
});

/** A fake REST API: answers by path (without the paging query), slicing list answers into GitHub's pages. */
function fakeRest(routes: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    calls,
    api: {
      rest: async (host: string, path: string) => {
        calls.push(`${host}${path}`);
        const [base, query = ""] = path.split("?");
        const answer = routes[base!];
        if (answer === undefined) throw new GithubApiError("not_found", host, "Not Found");
        if (!Array.isArray(answer)) return answer;
        const params = new URLSearchParams(query);
        const per = Number(params.get("per_page") ?? 30);
        const page = Number(params.get("page") ?? 1);
        return answer.slice((page - 1) * per, page * per);
      },
    },
  };
}

describe("githubRestUrl", () => {
  it("maps github.com, GHE.com and Enterprise Server hosts", () => {
    expect(githubRestUrl("GitHub.com")).toBe("https://api.github.com");
    expect(githubRestUrl("example.ghe.com")).toBe("https://api.example.ghe.com");
    expect(githubRestUrl("git.example.org")).toBe("https://git.example.org/api/v3");
  });
});

describe("GithubApi.rest", () => {
  it("GETs with the gh token and maps refusals to GithubApiError", async () => {
    const seen: { url: string; method: string | undefined; auth: string | null }[] = [];
    const fetch: FetchFn = async (url, init = {}) => {
      seen.push({ url, method: init.method, auth: new Headers(init.headers).get("authorization") });
      if (url.endsWith("/missing")) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      if (url.endsWith("/limited"))
        return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const tokens = createGhTokens({ runGh: async () => "secret-ish\n" });
    const api = createGithubApi({ tokens, fetch });
    expect(await api.rest("git.example.org", "/repos/a/b")).toEqual({ ok: true });
    expect(seen[0]).toEqual({
      url: "https://git.example.org/api/v3/repos/a/b",
      method: "GET",
      auth: "bearer secret-ish",
    });
    await expect(api.rest("github.com", "/missing")).rejects.toMatchObject({ kind: "not_found" });
    await expect(api.rest("github.com", "/limited")).rejects.toMatchObject({ kind: "rate_limited" });
  });
});

describe("createGithubHost", () => {
  it("reads a PR's meta, mapping merged and draft", async () => {
    const { api } = fakeRest({
      "/repos/acme/widgets/pulls/7": {
        number: 7,
        html_url: "https://github.com/acme/widgets/pull/7",
        title: "Add widgets",
        body: null,
        state: "closed",
        merged: true,
        draft: false,
        user: { login: "octo" },
        base: { ref: "main" },
        head: { ref: "feat/widgets", sha: "abc123" },
        additions: 10,
        deletions: 2,
        changed_files: 3,
      },
    });
    expect(await createGithubReads(api).getPr(ref)).toEqual({
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      title: "Add widgets",
      body: "",
      state: "merged",
      draft: false,
      author: "octo",
      baseRef: "main",
      headRef: "feat/widgets",
      headSha: "abc123",
      additions: 10,
      deletions: 2,
      changedFiles: 3,
    });
  });

  it("lists every file across GitHub's pages, with renames and missing patches", async () => {
    const files = [
      ...Array.from({ length: 230 }, (_, i) => fileJson(`src/f${i}.ts`, 3)),
      fileJson("img/logo.png", 0, { status: "added", patch: undefined }),
      fileJson("src/new.ts", 1, { status: "renamed", previous_filename: "src/old.ts" }),
    ];
    const { api, calls } = fakeRest({ "/repos/acme/widgets/pulls/7/files": files });
    const listed = await createGithubReads(api).listFiles(ref);
    expect(listed).toHaveLength(232);
    expect(calls).toEqual([1, 2, 3].map((p) => `github.com/repos/acme/widgets/pulls/7/files?per_page=100&page=${p}`));
    expect(listed[230]).toMatchObject({ path: "img/logo.png", status: "added", patch: null });
    expect(listed[231]).toMatchObject({ path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" });
  });

  it("reads a large multi-file diff in full, page by page", async () => {
    // 12 files of 300 added lines: far more than one page holds.
    const files = Array.from({ length: 12 }, (_, i) => fileJson(`src/big${i}.ts`, 300));
    const { api } = fakeRest({ "/repos/acme/widgets/pulls/7/files": files });
    const host = createGithubReads(api);
    const first = await host.getDiff(ref, null, 1);
    expect(first.pages).toBeGreaterThan(5);
    const all: string[] = [first.text];
    for (let page = 2; page <= first.pages; page += 1) all.push((await host.getDiff(ref, null, page)).text);
    const text = all.join("\n");
    // Every added line of every file is on some page.
    for (let f = 0; f < 12; f += 1) {
      for (const n of [1, 150, 300]) expect(text).toContain(`+src/big${f}.ts ${n}\n`);
    }
    await expect(host.getDiff(ref, null, first.pages + 1)).rejects.toThrow(`has ${first.pages} pages`);
  });

  it("reads one file's diff on its own pages, and refuses a file the PR doesn't change", async () => {
    const files = [fileJson("src/a.ts", 5), fileJson("src/huge.ts", 1000)];
    const { api } = fakeRest({ "/repos/acme/widgets/pulls/7/files": files });
    const host = createGithubReads(api);
    const one = await host.getDiff(ref, "src/a.ts", 1);
    expect(one).toMatchObject({ path: "src/a.ts", page: 1, pages: 1 });
    expect(one.text).toContain("+src/a.ts 5");
    expect(one.text).not.toContain("src/huge.ts");
    const huge = await host.getDiff(ref, "src/huge.ts", 2);
    expect(huge.pages).toBe(3);
    // A continuation page says which file it is.
    expect(huge.text.split("\n")[0]).toBe("diff --git a/src/huge.ts b/src/huge.ts (modified, +1000 -0) (continued)");
    await expect(host.getDiff(ref, "../etc/passwd", 1)).rejects.toThrow("isn't changed in this pull request");
  });

  it("merges conversation comments, review bodies and inline comments, oldest first", async () => {
    const { api } = fakeRest({
      "/repos/acme/widgets/issues/7/comments": [
        { id: 3, user: { login: "a" }, body: "LGTM?", created_at: "2026-01-03T00:00:00Z" },
      ],
      "/repos/acme/widgets/pulls/7/reviews": [
        { id: 10, user: { login: "bot" }, body: "Round 1", state: "COMMENTED", submitted_at: "2026-01-01T00:00:00Z" },
        // Only carries inline comments: left out.
        { id: 11, user: { login: "bot" }, body: "", state: "COMMENTED", submitted_at: "2026-01-02T00:00:00Z" },
      ],
      "/repos/acme/widgets/pulls/7/comments": [
        {
          id: 20,
          user: { login: "bot" },
          body: "nit",
          created_at: "2026-01-02T00:00:00Z",
          path: "src/a.ts",
          line: null,
          original_line: 4,
          pull_request_review_id: 11,
        },
      ],
    });
    const comments = await createGithubReads(api).getComments(ref);
    expect(comments.map((c) => [c.kind, c.id])).toEqual([
      ["review", 10],
      ["inline", 20],
      ["conversation", 3],
    ]);
    expect(comments[1]).toMatchObject({ path: "src/a.ts", line: 4, reviewId: 11, inReplyTo: null });
  });

  it("reads an issue with its labels", async () => {
    const { api } = fakeRest({
      "/repos/acme/widgets/issues/7": {
        number: 7,
        html_url: "https://github.com/acme/widgets/issues/7",
        title: "Broken",
        body: "It broke",
        state: "open",
        user: { login: "octo" },
        labels: [{ name: "bug" }, "p1"],
      },
    });
    expect(await createGithubReads(api).getIssue(ref)).toMatchObject({
      title: "Broken",
      state: "open",
      labels: ["bug", "p1"],
    });
  });

  it("says when GitHub's answer isn't the documented shape", async () => {
    const { api } = fakeRest({ "/repos/acme/widgets/pulls/7": { nope: true } });
    await expect(createGithubReads(api).getPr(ref)).rejects.toThrow("wasn't in the expected shape");
  });
});

describe("paging", () => {
  const file = (path: string, lines: number, patch: string | null = patchOf(lines, path)): HostPrFile => ({
    path,
    previousPath: null,
    status: "modified",
    additions: lines,
    deletions: 0,
    patch,
  });

  it("keeps a block that fits a page whole instead of splitting it", () => {
    const pages = packPages([{ lines: ["a", "b", "c"] }, { lines: ["d", "e", "f"] }, { lines: ["g"] }], {
      lines: 4,
      chars: 1000,
    });
    expect(pages).toEqual(["a\nb\nc", "d\ne\nf\ng"]);
  });

  it("respects the character limit and cuts a line longer than a page", () => {
    const long = "x".repeat(5000);
    const pages = packPages([{ lines: ["short", long] }], { lines: 100, chars: 1000 });
    expect(pages.every((p) => p.length <= 1000)).toBe(true);
    expect(pages.join("\n")).toContain("[line cut at 500 of 5000 characters]");
  });

  it("names a file the host serves no diff for", () => {
    const pages = diffPages([file("bin/tool", 0, null)], null);
    expect(pages[0]).toContain("No diff served for this file");
  });

  it("finds a renamed file by its old path too", () => {
    const renamed = { ...file("src/new.ts", 2), previousPath: "src/old.ts", status: "renamed" as const };
    expect(pageDiff([renamed], "src/old.ts", 1).text).toContain("diff --git a/src/old.ts b/src/new.ts");
  });

  it("refuses a page out of range or not a whole number", () => {
    expect(() => pickPage(["a"], 0, "The diff")).toThrow("The diff has 1 page; page 0 doesn't exist");
    expect(() => pickPage(["a", "b"], 1.5, "The diff")).toThrow("has 2 pages");
    expect(pickPage([], 1, "The diff")).toEqual({ page: 1, pages: 1, text: "" });
  });
});
