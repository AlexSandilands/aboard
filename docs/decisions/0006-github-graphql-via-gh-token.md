# 0006 GitHub through its GraphQL API, with the token `gh` holds

Status: Accepted

## Context

The board polled PRs with `gh pr view`, one process per PR, which suited reading state and kept the
board free of tokens. Merging from the board needs more than that:

- a fresh read of the PR's node id, head commit and merge-queue state just before the merge;
- the `mergePullRequest` and `enablePullRequestAutoMerge` mutations, with `expectedHeadOid` so a push
  since the last poll can't be merged unseen;
- the repo's allowed merge methods and the viewer's permission, to decide whether to offer a button.

`gh pr merge` covers some of this, but not the expected head, and its output is meant for people.
Users also link PRs on GitHub Enterprise hosts, which `gh pr view <url>` handles only when told the
host, and one process per PR doesn't scale to many repos.

T3 Code solved the same problem by calling GitHub's API itself, with the token `gh` hands over.

## Decision

- The server calls GitHub's GraphQL API with `fetch` (`apps/server/src/integrations/githubApi.ts`).
  github.com uses `api.github.com/graphql`, `*.ghe.com` hosts use `api.<host>/graphql`, and any other
  host uses `https://<host>/api/graphql`.
- The token comes from `gh auth token --hostname <host>`, run with `GH_PROMPT_DISABLED=1`. The board
  never stores it, logs it or sends it to the browser. It keeps it in memory for five minutes per
  host, and asks `gh` again once when GitHub refuses a cached one.
- Sign-in status is `gh auth status --json hosts`, per host.
- A GraphQL `errors` list is a failure even with HTTP 200, except in a batch, where the PRs that
  answered are kept and the rest logged. Rate limits are a 429, a 403 with no requests remaining or
  a retry-after header, or a `RATE_LIMITED` error. A rate-limited host is skipped for the rest of that poll.
- `gh` stays a dependency: without it, or without a login for the host, PR links are shown but not
  polled or merged.

## Consequences

- One request reads up to 25 PRs of a repo, so polling cost grows with repos, not PRs.
- GitHub Enterprise works wherever `gh` is signed in, with no extra configuration.
- The board can't use a token `gh` doesn't have: no Settings field or env var for one. Adding one
  means deciding where it's stored and how it's kept out of logs and the web app.
- GraphQL field names are now part of the code. The poll and merge queries live in
  `integrations/github.ts`, and the fake in `src/test/fakeGithub.ts` must answer them.
- Tests never put a token-shaped string in the source; fakes build them at runtime.
