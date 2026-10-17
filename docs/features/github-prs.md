# GitHub PRs

PR links on GitHub and GitHub Enterprise show their live state on the card (open, draft, merged, closed,
checks, review, conflicts), and problems surface under **Needs attention**. A task in Review can merge
its PR, or turn on auto-merge, from the board. The board calls GitHub's GraphQL API with the token the
user's `gh` CLI holds, so it needs no token of its own
([ADR 0006](../decisions/0006-github-graphql-via-gh-token.md)).

## How it works

### Links

`link` (MCP) or **Add link** (panel) classifies a value (`packages/contracts/src/links.ts`). Any
`https://<host>/<owner>/<repo>/pull/<n>` URL becomes a `pr` link with `ref = {host, repo, number}`, so
Enterprise PRs parse like github.com ones. Azure DevOps and Bitbucket PR URLs are `pr` links with no
ref: shown, never polled.

Migration `008_enterprise_pr_links` (a code migration in `db/codeMigrations.ts`, since SQLite can't
parse URLs) gave a ref to links stored before this, as plain URLs or ref-less PRs.

### Hosts and sign-in

- The poller only asks hosts that are GitHub: github.com, `*.ghe.com`, a host with a `github` DNS label
  (`github.example.com`), or any host `gh` is signed in to. A link to `/a/b/pull/1` on some other site
  is never sent anywhere.
- And only hosts `gh` is signed in to, since that's where its token is sent. `gh auth status --json
  hosts` is read every 10 minutes and shown per host in Settings. A `gh` too old for `--json` falls
  back to the exit code of `gh auth status`, which can't name hosts, so only github.com is used then.
- The token is `gh auth token --hostname <host>`, kept in memory for five minutes (`githubApi.ts`).
  A 401 on a cached token asks `gh` once more before failing.

### Polling

`apps/server/src/integrations/github.ts`:

- Every 2 minutes, `pr` links on polled hosts are grouped by host and repo, and each group is read
  with one aliased query (`pollQuery`: `pr0`, `pr1`, … with numbers as variables), at most 25 PRs a
  query and 4 queries at a time.
- A PR GitHub can't find comes back as an error on its alias; the rest of the batch is stored, and
  the error is logged once per link. A rate limit or a refused token stops that host for the rest of
  the poll and is logged once per host.
- Skipped when **Poll PR status** is off in Settings, or `gh` is missing or signed out everywhere.
- **Refresh** on a link (`POST /api/links/:id/refresh`) reads it now and reports why it can't (`gh`
  missing, not signed in to that host, GitHub's error).

### The snapshot

`mapPrSnapshot` turns a PR and its repository into a `PrSnapshot`:

| Field              | Values                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `state`            | `merged`, `closed`, `draft`, `open`                                                                |
| `checks`           | From the head commit's status check rollup: `failing` if any check failed, errored, timed out, was cancelled or needs action; else `pending` if any is running; else `passing`; `none` without checks |
| `reviewDecision`   | `approved`, `changes_requested`, `review_required`, or none                                        |
| `mergeable`        | `mergeable`, `conflicting`, `unknown`                                                              |
| `autoMerge`        | The method auto-merge will use, or null when it's off                                             |
| `mergeMethods`     | The repo's allowed methods (`merge`, `squash`, `rebase`)                                           |
| `autoMergeAllowed` | Whether the repo allows auto-merge                                                                 |
| `canMerge`         | The signed-in account has `WRITE`, `MAINTAIN` or `ADMIN` on the repo                               |
| `headOid`          | The head commit, checked again before merging                                                      |
| `isCrossRepository` | Whether the head branch is in a fork; Autopilot's PR review skips those                           |
| `reviews`          | The last 20 submitted reviews, oldest first: `id` (databaseId), `author`, `state`, `submittedAt`, `own` (`viewerDidAuthor`), `trusted` |
| `reviewComments`   | Comments on the last 30 review threads that aren't resolved (the last 5 of each), oldest first: `id`, `author`, `createdAt`, `reviewId`, `own`, `trusted` |

`trusted` means the author is an `OWNER`, `MEMBER` or `COLLABORATOR` of the repository. Bodies aren't read: the
fix automation only needs who wrote what when, and Autopilot's own inline comments can be long.

The last eight are optional, so snapshots stored by the old `gh pr view` poller still parse (and offer
no merge until the next poll). `links.setSnapshot` stores the snapshot, and publishes the card only
when it changed.

### Reviews by Autopilot

The poller's snapshot (`state`, `headRef`, `headOid`, `isCrossRepository`) is what the **Review PRs** automation
reads: it reviews an open (or, if asked, draft) PR once per head commit. `postReview` posts the result with the
`gh` token as one review with `event: COMMENT` (`addPullRequestReview`), after checking the PR's live head is the
commit that was reviewed; inline comments GitHub refuses (a line outside the diff) go into the body. See
[Autopilot](autopilot.md#automations).

**Fix PRs** reads `checks`, `mergeable`, `reviewDecision`, `reviews` and `reviewComments` to decide when a PR needs
fixing, and leaves out what `own` marks: Autopilot posts under the same login.

### Attention

An open or draft PR puts the task under **Needs attention** when checks fail (error), changes are
requested, or it conflicts (warnings). Merged and closed PRs never do.

### Merging

`prMergeAction(taskStatus, snapshot)` in `packages/contracts/src/merge.ts` picks the control, the same
order as T3 Code's PR panel. Only a task in **Review** whose PR the account can merge gets one:

1. merged, closed or draft: none;
2. conflicting: none;
3. auto-merge on: an **Auto-merge on** badge, and **Disable auto-merge** in the link's menu;
4. checks not passing, and the repo allows auto-merge: **Enable auto-merge**;
5. otherwise: **Merge**.

The panel's PR row shows the button; the card shows a merge icon next to the PR chip. While the PR has something to fix
the slot is Fix in → instead, and Merge is in the row's menu ([below](#fixing-a-pr-by-hand)). Both open
`MergePrDialog`, where the method can be changed. It offers the method last picked for the repo
(`useMergeMethods`, in local storage), else squash, merge, rebase, whichever the repo allows.

`POST /api/links/:id/merge` with `{action: "merge" | "auto" | "disable_auto", method}`:

- Refused before reaching GitHub when the task isn't in Review, the link has no snapshot, the account
  can't merge, or the repo doesn't allow the method.
- Reads the PR fresh: node id, head, `mergeStateStatus`, `isMergeQueueEnabled`. If the head moved
  since the snapshot, it stops with a conflict and refreshes the link, so the user sees the new
  commits before merging them.
- Then `mergePullRequest` with `expectedHeadOid`, or `enablePullRequestAutoMerge` when a merge queue
  is on or auto-merge was asked for and the PR can't merge right away (anything but `CLEAN`,
  `HAS_HOOKS`, `UNSTABLE`). `disable_auto` calls `disablePullRequestAutoMerge`.
- GitHub's error is shown as is. The branch is never deleted.
- Then the link is refreshed. A merged PR then finishes the task the usual way (below).

Merging is UI only: there's no MCP tool for it.

### Fixing a PR by hand

Board task: #78. The PR row has one action slot (`prRowSlot` in `packages/contracts/src/prFix.ts`), in the panel and on
the card. `prProblems(snapshot)` says what is wrong: failing checks, a conflict, changes requested; and only for an open
or draft PR in the base repository (`isCrossRepository` is false) with a `headRef` and `headOid`, as Fix PRs does.

| The PR has                                  | The slot (panel row; card chip)          | In the row's ⌄ menu (the card chip's menu)   |
| ------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| nothing to fix                              | Merge, as above (`prMergeAction`)        |                                              |
| a problem                                   | **Fix in →** (a menu: the targets below) | the Merge or Enable auto-merge that gave way |
| a problem, Fix PRs on for the task, running | **Autopilot is fixing**                  | Fix in →, and that Merge                     |
| a problem, Fix PRs on for the task, gave up | **Autopilot gave up**                    | Fix in →, and that Merge                     |

No Fix in → on a Done task (Autopilot skips them too), an epic (its sessions start from its tasks) or a link with no
repository and number. **Fix PRs on for the task** is its resolution at the task's epic, project or board
(`useAutopilotScope`, `useAutopilotEpicScope`), read only while the PR has a problem. **Running** is a `fix_prs` run for
this link (`fixRunKeyPrefix`, from the task's runs) that is queued or running, or that handed the fix to a T3 thread, a
new one or a nudge into the task's own, which is still working: those runs end at once, so `t3RunWorking` (shared with
Fix PRs, in `packages/contracts/src/runThreads.ts`) reads the thread. **Gave up** is the task's Needs attention reason `fixGaveUpPrefix(n)`. The board can't tell
"Autopilot is about to fix it" from "Autopilot has done all it will" without redoing the automation's check in the
browser, so in those states Fix in → stays the primary action.

**Fix in →** offers **T3 Code thread…** (as in the hand-off menu), **Claude Code session…** and **Copilot CLI session…**,
each opening its launch dialog with `fixLinkId` set (`useDialogs().openT3Launch(taskId, fixLinkId)`,
`openSessionLaunch(taskId, harness, fixLinkId)`), and **Copy fix prompt**. The dialogs read `GET /api/links/:id/fix`:

- `manualFix` (`autopilot/automations/fixPrs.ts`) builds Fix PRs' prompt (`fixPrompt` with `manual: true`) for every
  problem the PR has now, whoever raised it and whether or not Autopilot has tried it. Review comments and Autopilot's
  own review aren't listed: the user points the agent at those. Changes requested read the newest trusted review, or tell
  the agent to find it with `gh pr view --comments` when there is none. The scope's **Fix skill** is followed, as for
  Autopilot's attempts. The response also carries the PR's `branch`, `headOid`, `number` and `problems`. It is a 400 for a
  PR with nothing to fix, as `prProblems` says.
- The prompt differs from Autopilot's for a user who is watching: no "Autopilot sent you" or attempt count, the agent may
  ask instead of stopping, replies carry no Autopilot marker (the reply file is `fix-reply.md`), the agent is told the
  board linked the session, and the push is `git push origin HEAD:<branch>` since the worktree's own branch is a new one.
  The safety rules are the same: never force-push, never push to the default branch, never merge, conflicts by merge.
- **CLI sessions** use the workspace `{mode: "pr_branch", branch}` ([agent sessions](agent-sessions.md#starting-a-session)):
  a worktree on origin's copy of the PR's branch, like Fix PRs' headless runs. The dialog has no "where" choice and needs a
  git repository. The session is labelled "Fixing the PR of #N" and linked to the task.
- **Fix PRs doesn't know about these sessions.** Its check defers only to its own runs and to the T3 threads they started
  (`t3RunWorking`). If a session you started pushes and the checks fail again at the new head while Fix PRs is on, it may
  start an attempt of its own on the same branch. Turn Fix PRs off for the task, or Pause all, while you work by hand.
- **T3 threads** start in a new worktree from `origin/<branch>` (the dialog's initial choice, as for an integration epic's
  branch). The dialog never starts a fix in your checkout or an existing worktree (the launch is blocked), since the
  prompt has the agent fast-forward its branch to the PR's when the worktree lacks the head commit. It warns when T3 lists
  no ref for the PR's branch (the worktree then starts from the default branch). The thread is linked to the task.

### Finishing on merge

When a task in Review has every polled PR finished and at least one merged, it moves to Done as actor
`github`. This happens when a poll (or a merge) sees the last PR finish, and when a task enters Review
with its PRs already finished. PRs that aren't polled and were never fetched (other sites, or GitHub hosts `gh` isn't signed in
to) never hold it back, except on github.com, which always counts (`holdsTasks`): while `gh`'s status is
still unknown, one merge mustn't finish a task whose other PR is open.

## Decisions

- **GraphQL with `gh`'s token, not `gh pr view`.** Batching, Enterprise hosts and merging with an
  expected head need the API. See [ADR 0006](../decisions/0006-github-graphql-via-gh-token.md).
- **No token setting.** The board uses whichever account `gh` is signed in with per host. Supporting
  a pasted token would mean storing one.
- **Merge only from Review.** A task gets merged once its work is done and reviewed; offering it
  earlier would skip the plan and the local review.
- **Always confirm.** A merge can't be undone from the board, so every merge goes through the dialog,
  from the card too.
- **No branch deletion.** GitHub's repo setting can delete branches on merge; the board doesn't add
  its own.
- **Other hosts are links only.** Azure DevOps and Bitbucket PRs are recognised so they show as PRs, but
  aren't polled.

## Code map

| File                                                     | What it does                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------- |
| `apps/server/src/integrations/githubApi.ts`              | API URLs, `gh` tokens, auth status, GraphQL with error and rate-limit handling |
| `apps/server/src/integrations/github.ts`                 | Hosts, polling, `mapPrSnapshot`, `refresh`, `merge`             |
| `apps/server/src/integrations/gh.ts`                     | Running `gh`                                                    |
| `apps/server/src/integrations/index.ts`                  | Starts the integrations, `refreshLink`, `mergePr`               |
| `apps/server/src/services/links.ts`                      | Adding links, `setSnapshot`, `completeOnMerge`                  |
| `apps/server/src/db/codeMigrations.ts`                   | Re-classifying stored PR links                                  |
| `apps/server/src/test/fakeGithub.ts`                     | Fake `gh` and GraphQL API for tests                             |
| `packages/contracts/src/links.ts`                        | URL and key classification                                      |
| `packages/contracts/src/merge.ts`                        | `prMergeAction`, `pickMergeMethod`, `MergePrInput`              |
| `packages/contracts/src/derive.ts`                       | `deriveAttention`                                               |
| `apps/web/src/components/board/CardLinks.tsx`, `task/LinksSection.tsx` | PR chips and merge controls on the card and in the panel |
| `apps/web/src/components/merge/MergePrDialog.tsx`        | The merge dialog                                                |
| `packages/contracts/src/prFix.ts`                        | `prProblems`, `prRowSlot`, `PrFixInfo`                          |
| `apps/web/src/components/handoff/FixPrMenu.tsx`          | The slot hook (`usePrSlot`) and the Fix in → menu items         |
| `apps/web/src/components/handoff/fixPr.logic.ts`         | `prAutopilotState`: Fix PRs' state for the slot                 |
| `apps/server/src/autopilot/automations/fixPrs.ts`        | `manualFix` and `fixPrompt`, which Fix PRs and Fix in → share   |
| `apps/web/src/components/settings/IntegrationsSections.tsx` | The GitHub section in Settings → Integrations                |
