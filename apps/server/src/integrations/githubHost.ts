import type { PrRef } from "@repo/contracts";
import { z } from "zod";
import { pageDiff, type GitHost, type HostComment, type HostPrFile } from "./gitHost.ts";
import type { GithubApi } from "./githubApi.ts";

// GitHost for GitHub: REST reads with the user's gh token (ADR 0006), through githubApi.ts. REST rather than GraphQL
// because only REST serves a PR's per-file patches, and its comment ids are the ones review threads are matched by.

/** GitHub serves at most 100 items a page. */
const PER_PAGE = 100;
/** GitHub lists at most 3000 files of a PR; past that many pages of anything, a PR is read no further. */
const MAX_PAGES = 30;

const User = z.object({ login: z.string() }).loose().nullable().optional();

const PullJson = z
  .object({
    number: z.number(),
    html_url: z.string(),
    title: z.string(),
    body: z.string().nullable().optional(),
    state: z.string(),
    draft: z.boolean().optional(),
    merged: z.boolean().optional(),
    merged_at: z.string().nullable().optional(),
    user: User,
    base: z.object({ ref: z.string() }).loose(),
    head: z.object({ ref: z.string(), sha: z.string() }).loose(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
    changed_files: z.number().optional(),
  })
  .loose();

const FileJson = z
  .object({
    filename: z.string(),
    previous_filename: z.string().optional(),
    status: z.string(),
    additions: z.number(),
    deletions: z.number(),
    patch: z.string().optional(),
  })
  .loose();

const CommentJson = z
  .object({
    id: z.number(),
    user: User,
    body: z.string().nullable().optional(),
    created_at: z.string().optional(),
    submitted_at: z.string().nullable().optional(),
    html_url: z.string().optional(),
    state: z.string().optional(),
    path: z.string().optional(),
    line: z.number().nullable().optional(),
    original_line: z.number().nullable().optional(),
    in_reply_to_id: z.number().optional(),
    pull_request_review_id: z.number().nullable().optional(),
  })
  .loose();

const IssueJson = z
  .object({
    number: z.number(),
    html_url: z.string(),
    title: z.string(),
    body: z.string().nullable().optional(),
    state: z.string(),
    user: User,
    labels: z.array(z.union([z.string(), z.object({ name: z.string().optional() }).loose()])).optional(),
  })
  .loose();

const FILE_STATUSES = new Set<HostPrFile["status"]>([
  "added",
  "modified",
  "removed",
  "renamed",
  "copied",
  "changed",
  "unchanged",
]);

/** What GitHub answered was not what its API documents. */
const unexpected = (what: string) => new Error(`GitHub's answer for ${what} wasn't in the expected shape`);

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw unexpected(what);
  return parsed.data;
}

const repoPath = (ref: { repo: string }) =>
  ref.repo
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

export function createGithubHost(api: Pick<GithubApi, "rest">): GitHost {
  /** Every page of a list endpoint, up to MAX_PAGES. */
  const all = async <T>(host: string, path: string, schema: z.ZodType<T>, what: string): Promise<T[]> => {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const sep = path.includes("?") ? "&" : "?";
      const body = await api.rest(host, `${path}${sep}per_page=${PER_PAGE}&page=${page}`);
      const items = parse(z.array(schema), body, what);
      out.push(...items);
      if (items.length < PER_PAGE) break;
    }
    return out;
  };

  const listFiles = async (ref: PrRef): Promise<HostPrFile[]> => {
    const files = await all(ref.host, `/repos/${repoPath(ref)}/pulls/${ref.number}/files`, FileJson, "the PR's files");
    return files.map((f) => ({
      path: f.filename,
      previousPath: f.previous_filename ?? null,
      status: FILE_STATUSES.has(f.status as HostPrFile["status"]) ? (f.status as HostPrFile["status"]) : "changed",
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch ?? null,
    }));
  };

  return {
    async getPr(ref) {
      const pr = parse(PullJson, await api.rest(ref.host, `/repos/${repoPath(ref)}/pulls/${ref.number}`), "the PR");
      return {
        number: pr.number,
        url: pr.html_url,
        title: pr.title,
        body: pr.body ?? "",
        state: pr.merged || pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open",
        draft: pr.draft ?? false,
        author: pr.user?.login ?? null,
        baseRef: pr.base.ref,
        headRef: pr.head.ref,
        headSha: pr.head.sha,
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        changedFiles: pr.changed_files ?? 0,
      };
    },
    listFiles,
    async getDiff(ref, path, page) {
      return pageDiff(await listFiles(ref), path, page);
    },
    async getComments(ref) {
      const base = `/repos/${repoPath(ref)}`;
      const [conversation, reviews, inline] = await Promise.all([
        all(ref.host, `${base}/issues/${ref.number}/comments`, CommentJson, "the PR's comments"),
        all(ref.host, `${base}/pulls/${ref.number}/reviews`, CommentJson, "the PR's reviews"),
        all(ref.host, `${base}/pulls/${ref.number}/comments`, CommentJson, "the PR's review comments"),
      ]);
      const common = (c: z.infer<typeof CommentJson>) => ({
        id: c.id,
        author: c.user?.login ?? null,
        body: c.body ?? "",
        createdAt: c.created_at ?? c.submitted_at ?? "",
        url: c.html_url ?? null,
      });
      const out: HostComment[] = [
        ...conversation.map((c): HostComment => ({ ...common(c), kind: "conversation" })),
        // A review with no body of its own only carries inline comments, which are listed themselves.
        ...reviews
          .filter((r) => (r.body ?? "").trim() !== "" || (r.state !== undefined && r.state !== "COMMENTED"))
          .map((r): HostComment => ({ ...common(r), kind: "review", state: r.state ?? null })),
        ...inline.map((c): HostComment => ({
          ...common(c),
          kind: "inline",
          path: c.path ?? null,
          line: c.line ?? c.original_line ?? null,
          inReplyTo: c.in_reply_to_id ?? null,
          reviewId: c.pull_request_review_id ?? null,
        })),
      ];
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
    },
    async getIssue(ref) {
      const issue = parse(
        IssueJson,
        await api.rest(ref.host, `/repos/${repoPath(ref)}/issues/${ref.number}`),
        "the issue",
      );
      return {
        number: issue.number,
        url: issue.html_url,
        title: issue.title,
        body: issue.body ?? "",
        state: issue.state === "closed" ? "closed" : "open",
        labels: (issue.labels ?? []).flatMap((l) => (typeof l === "string" ? [l] : l.name ? [l.name] : [])),
        author: issue.user?.login ?? null,
      };
    },
  };
}
