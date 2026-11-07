# 0014 Git hosts sit behind a GitHost registry

Status: Accepted

## Context

Everything the board does on a git host was GitHub code called directly: the PR poller, merges and auto-merge,
`merge_task_pr`, Autopilot's reviews, thread resolution and epic PRs, issue import, the fix-PR prompt's `gh` commands,
the backup repo setup and the Settings status. [0013](0013-board-served-run-tools.md) put the reads headless runs make
behind a `GitHost` interface, but only those. Users also work on GitLab, Bitbucket and Gitea/Forgejo, and adding one of
those meant touching every one of these places.

The board's own rules don't depend on the host: which PRs to poll and how often, backing off a failing PR or host,
the merge guards (Autopilot only into an epic's branch, `merge_task_pr` only into the default branch, at the checked
head), the merge gate and early-PR logic, which read only the `PrSnapshot`.

## Decision

- **A definition per host kind** in `packages/contracts/src/gitHosts.ts`: its name, its main site, what it calls a pull
  request, the CLI it borrows a sign-in from (name, label, login command), and `claimsHost()`, which hosts are its own
  by name. Pure, so the server and the web app share it. Only `github` exists.
- **A `GitHost` per kind on the server** (`apps/server/src/integrations/gitHost.ts`): its status, which hosts it
  serves and reaches, the reads, `readSnapshots`, merges (`merge`, `mergeTarget`, `mergeAt`), reviews and threads,
  `ensurePr`, `setPrBody`, sub-issues, `createRepo` and `agentHints` (the CLI commands a fix prompt gives an agent),
  plus `capabilities` for what it can't do. GitHub's is `githubHost.ts`, over [0006](0006-github-graphql-via-gh-token.md)'s
  GraphQL and REST with `gh`'s token.
- **A `GitHosts` registry** (`gitHosts.ts`) picks the kind for a host: the first that claims it by name, else the first
  whose CLI is signed in to it. A host no kind serves gets none: its PR links show without live state and can't be
  merged.
- **The board's rules stay host-neutral**: the poller (`prPoller.ts`), the merges and their guards (`prMerge.ts`),
  issue import, Autopilot's actions (`ctx.gitHosts`) and the run tools reach a host only through the registry.
- **One error type**, `GitHostError`, with a reason (`missing-tool`, `unauthenticated`, `rate-limited`, `not-found`,
  `transient`, `failed`). Its message never carries a credential. `isTransientHostError` and `isHostWideError` are
  what callers branch on.
- **A host's snapshot judges each check by its newest run**, as GitHub's merge box does, and only required checks
  decide `checks` when any is required. `readSnapshots`'s doc says so for the next host.
- **Only `integrations/github*.ts` touch GitHub**: nothing else imports `gh.ts`, `githubApi.ts` or the GraphQL code.
  `apps/server/src/integrations/gitHostBoundary.test.ts` fails otherwise.

## Consequences

- Another host is a definition, a `GitHost`, an entry in `createGitHosts([...])`, and its sign-in shown in Settings.
  The poller, merges, Autopilot and prompts need no change, as long as the host can fill a `PrSnapshot`.
- `/api/integrations/status` returns `gitHosts: GitHostStatus[]` (with the CLI's version) instead of `github`, and the
  backup setup info names a host kind instead of `gh`.
- What agents read is worded from the definition, so it stays exactly GitHub's text while GitHub is the only kind.
  Static tool descriptions that name `gh` (`merge_task_pr`'s) are left until a second kind exists.
- The `githubPolling` setting and the `integrations.github.*` Settings ids keep their names; a second kind decides
  whether polling becomes per kind.
- Issue import reads issues and sub-issues over REST with the CLI's token, like the run tools, rather than with
  `gh issue view` and `gh api --jq`.
