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

- A tick every 20 seconds picks the `pr` links that are due (`prIsDue`, `integrations/prPolling.ts`), groups them
  by host and repo, and reads each group with one aliased query (`pollQuery`: `pr0`, `pr1`, … with numbers as
  variables), at most 25 PRs a query and 4 queries at a time. A link is due once its tier's interval has passed since
  `syncedAt` (a little early, so a tick doesn't just miss it). Each cycle that sends queries logs how many PRs and
  queries it used (`debug`).
- **Tiers** (`prTier`), by how likely the PR is to change:

  | Tier | Every | PRs |
  | ---- | ----- | --- |
  | hot  | 20 s  | never read; checks `pending` or optional checks running; linked or updated on GitHub (`updatedAt`) in the last 10 minutes; its task's panel is open |
  | warm | 2 min | other open and draft PRs |
  | cold | 30 min | merged and closed PRs, whoever is looking |

- **Right away.** A PR link added over REST or MCP is read at once (`prLinked` → `pollLink`, which honours **Poll PR
  status**). When a task panel opens, and every 20 s while it stays open and visible, the web calls
  `POST /api/tasks/:id/view` (`useTaskView`): the server reads the task's PR links that were last read more than 15 s ago
  and treats the task as open for 40 s, so its PRs are hot even if they're otherwise warm.
- **Back-off.** A PR GitHub can't find, or a host that answered with a rate limit or a refused token, is left alone
  for the warm interval (2 minutes) rather than asked again every tick.
- A PR GitHub can't find comes back as an error on its alias; the rest of the batch is stored, and
  the error is logged once per link. A rate limit or a refused token stops that host for the rest of
  the poll and is logged once per host.
- Skipped when **Poll PR status** is off in Settings, or `gh` is missing or signed out everywhere.
- **Refresh** on a link (`POST /api/links/:id/refresh`) reads it now and reports why it can't (`gh`
  missing, not signed in to that host, GitHub's error). The PR row in the task panel has it as an always-visible icon
  beside "checked 23s ago" (`checkedAgoLabel`, from the link's `syncedAt`).

### The snapshot

`mapPrSnapshot` turns a PR and its repository into a `PrSnapshot`:

| Field              | Values                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `state`            | `merged`, `closed`, `draft`, `open`                                                                |
| `checks`           | From the head commit's status check rollup, counting only the checks the base branch requires for this PR (`isRequired(pullRequestNumber:)`), as GitHub's merge box does; with none required, every check counts. `failing` if one failed, errored, timed out, was cancelled or needs action; else `pending` if one is running or expected; else `passing`; `none` without checks |
| `optionalChecks`   | When some checks are required: how many of the others are `pending` and `failing`, so an optional workflow that is still queued doesn't hold `checks` at pending. Absent when there are none |
| `mergeState`       | GitHub's `mergeStateStatus`, lowercased (`clean`, `unstable`, `has_hooks`, `blocked`, `behind`, `dirty`, `draft`, `unknown`) |
| `reviewDecision`   | `approved`, `changes_requested`, `review_required`, or none                                        |
| `mergeable`        | `mergeable`, `conflicting`, `unknown`                                                              |
| `autoMerge`        | The method auto-merge will use, or null when it's off                                             |
| `mergeMethods`     | The repo's allowed methods (`merge`, `squash`, `rebase`)                                           |
| `autoMergeAllowed` | Whether the repo allows auto-merge                                                                 |
| `canMerge`         | The signed-in account has `WRITE`, `MAINTAIN` or `ADMIN` on the repo                               |
| `headOid`          | The head commit, checked again before merging                                                      |
| `isCrossRepository` | Whether the head branch is in a fork; Autopilot's PR review skips those                           |
| `reviews`          | The last 20 submitted reviews, oldest first: `id` (databaseId), `author`, `state`, `submittedAt`, `own` (`viewerDidAuthor`), `trusted` |
| `reviewComments`   | Comments on the last 100 review threads that aren't resolved and that Autopilot didn't answer last (the last 5 of each), oldest first: `id`, `author`, `createdAt`, `reviewId`, `own`, `trusted` |
| `reviewThreads`    | Those threads that aren't resolved: `id` (node id), `canResolve`, `rootCommentId` and `rootReviewId` (the first comment and its review), `reply` and `fixedIn` (whether the newest comment is Autopilot's reply: `fixed` in a commit, `declined`, `other`, or null) |
| `unresolvedThreads` | How many of the threads read aren't resolved                                                     |

`trusted` means the author is an `OWNER`, `MEMBER` or `COLLABORATOR` of the repository. Bodies aren't read, except
each thread's newest one (`latest: comments(last: 1)`), and that only to match Autopilot's marked reply
(`parseAutopilotReply`): it never goes into a prompt or the snapshot.

`optionalChecks`, `mergeState` and the last ten are optional, so snapshots stored by the old `gh pr view` poller still parse (and offer
no merge until the next poll). `links.setSnapshot` stores the snapshot, and publishes the card only
when it changed.

### Reviews by Autopilot

The poller's snapshot (`state`, `headRef`, `headOid`, `isCrossRepository`) is what the **Review PRs** automation
reads: it reviews an open (or, if asked, draft) PR once per head commit. `postReview` posts the result with the
`gh` token as one review with `event: COMMENT` (`addPullRequestReview`), after checking the PR's live head is the
commit that was reviewed; inline comments GitHub refuses (a line outside the diff) go into the body. When GitHub
answers a post with an error, `postReview` looks for the review among the account's own at that head
(`findPostedReview`, starting with the review header) before reporting the failure, so a review that landed counts as
posted. Its errors read "GitHub couldn't post the review: …" and keep their kind, which `isTransientGithubError` (also
used by the epic merge) reads to tell what is worth another try. See
[Autopilot](autopilot.md#automations).

**Fix PRs** reads `checks`, `mergeable`, `reviewDecision`, `reviews` and `reviewComments` to decide when a PR needs
fixing, and leaves out what `own` marks: Autopilot posts under the same login. It reads `reviewThreads` to resolve the
threads it replied it fixed, with `reviewThreads(ref)` (the threads and the PR's newest 100 commits, read fresh) and
`resolveReviewThread`; Review PRs resolves its own threads a later round confirms fixed the same way.

A repository can require every conversation resolved before a merge. When GitHub says the PR is blocked and it has
unresolved threads, the merge gate, merge_task_pr's refusals and the refusal at merge time say "N unresolved review
conversations", apart from a missing approval.

### Attention

An open or draft PR puts the task under **Needs attention** when checks fail (error), changes are
requested, or it conflicts (warnings). "Checks fail" is the `checks` verdict, so a failing optional check
(`optionalChecks`) doesn't raise it when others are required; nor does it hold back Autopilot's merges or start Fix PRs. Merged and closed PRs never do.

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

Merging is UI only, with one exception for agents: [`merge_task_pr`](#merge_task_pr).

### merge_task_pr

The MCP tool `merge_task_pr(task, method?)` lets an agent (the orchestrator of an epic, say) merge a task's PR into
the default branch, for tasks the user allowed to be merged that way ([ADR 0008](../decisions/0008-autopilot-engine.md)).

- **The flag.** `tasks.auto_merge`: null (Default) and 0 (Off) refuse, 1 (On) allows. Set in the REST task update
  (`autoMerge`) or by an agent with `create_task` / `add_to_backlog` / `update_task` (`autoMerge: "default" | "on" | "off"`),
  only once the user has said so. The server can't tell an agent from the user, so an agent could set On unasked; it is
  trusted like the Autopilot flag, and the gate below limits the harm ([ADR 0008](../decisions/0008-autopilot-engine.md)). Epics can't have it. The task detail shows `Auto-merge:` when set, and the task panel's Automation section sets it.
- **Refused** (a `VALIDATION` error with the reason, `mergeTaskPr` in `integrations/mergeTaskPr.ts`) for an epic, a
  task without the flag On, a task in an epic delivered through an integration branch (Autopilot merges those), a
  task with no PR, or more than one, not merged or closed, a PR from a fork, and whenever `notMergeable`
  ([Autopilot's gate](autopilot.md#merge-into-epic-branch)) gives a reason: not in Review, PR not open or a draft,
  local review going or blocking/major findings open, a Review PRs or Fix PRs run going, Review PRs (when on) not
  clean at the head, changes requested, checks not passing (or none for 10 minutes), not cleanly mergeable, GitHub saying it is blocked (a required check not reported yet) unless only a review is missing. Also when
  an approving review is still required, the account can't merge, or the repo doesn't allow the method asked for.
- **Merging.** `GithubIntegration.mergeIntoDefaultBranch` reads the PR fresh, runs `checkAutopilotMergeTarget` with
  `into: "default"` (the base must be GitHub's default branch, and still the one the snapshot showed), stops with a
  `CONFLICT` and refreshes the link if the head moved, refuses unless GitHub's `mergeStateStatus` is `CLEAN`,
  `HAS_HOOKS` or `UNSTABLE` (so an admin's account never merges past a branch rule such as a required approval), then calls `mergePullRequest` with `expectedHeadOid` and the
  method (asked for, else `pickMergeMethod`'s squash, merge, rebase). The link is refreshed, which finishes the task
  ([below](#finishing-on-merge)); if the refresh failed the tool moves it to Done itself. It notes the merge on the task.

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
| `apps/server/src/integrations/prPolling.ts`              | `prTier`, `prIsDue`: how often each PR is read                  |
| `apps/server/src/integrations/gh.ts`                     | Running `gh`                                                    |
| `apps/server/src/integrations/index.ts`                  | Starts the integrations, `refreshLink`, `mergePr`, `mergeTaskPr` |
| `apps/server/src/integrations/mergeTaskPr.ts`            | `merge_task_pr`'s checks and merge into the default branch      |
| `apps/server/src/autopilot/mergeGate.ts`                 | `notMergeable`, the gate shared with Merge into epic branch     |
| `apps/server/src/mcp/tools/merge.ts`                     | The `merge_task_pr` tool                                        |
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
