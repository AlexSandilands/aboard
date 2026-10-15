# GitHub PRs

PR links on GitHub show their live state on the card (open, draft, merged, closed, checks, review,
conflicts), and problems surface under **Needs attention**. The board asks the `gh` CLI, so it uses the
user's own GitHub login and needs no token of its own.

## How it works

### Links

`link` (MCP) or **Add link** (panel) classifies a value (`packages/contracts/src/links.ts`). A GitHub PR
URL becomes a `pr` link with `ref = {host, repo, number}`. Azure DevOps and Bitbucket PR URLs are `pr`
links with no ref: shown, never polled.

### Polling

`apps/server/src/integrations/github.ts`:

- Every 2 minutes, for `pr` links on `github.com`:
  `gh pr view <url> --json number,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup,headRefName,updatedAt`,
  four at a time, one run at a time.
- Skipped when **Poll PR status** is off in Settings, or `gh` is missing or not signed in. `gh --version`
  and `gh auth status` are checked every 10 minutes and shown in Settings.
- `gh` runs through `execFile` with no shell, with a 30-second timeout. A repeated error is logged once
  per link.
- **Refresh** on a link (`POST /api/links/:id/refresh`) polls it now and reports why it can't.

### The snapshot

`mapPrSnapshot` turns `gh`'s JSON into a `PrSnapshot`:

| Field            | Values                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `state`          | `merged`, `closed`, `draft`, `open`                                                                |
| `checks`         | `failing` if any check failed, errored, timed out, was cancelled or needs action; else `pending` if any is running; else `passing`; `none` without checks |
| `reviewDecision` | `approved`, `changes_requested`, `review_required`, or none                                        |
| `mergeable`      | `mergeable`, `conflicting`, `unknown`                                                              |

`links.setSnapshot` stores it, and publishes the card only when the snapshot changed.

### Attention

An open or draft PR puts the task under **Needs attention** when checks fail (error), changes are
requested, or it conflicts (warnings). Merged and closed PRs never do.

### Finishing on merge

When a task in Review has every polled PR finished and at least one merged, it moves to Done as actor
`github`. This happens when a poll sees the last PR finish, and when a task enters Review with its PRs
already finished. Unpolled PRs (other hosts) never hold it back.

## Decisions

- **`gh`, not the GitHub API.** No token to store or scope; it uses the account the user's `gh` is
  signed in to. The cost is a dependency on an installed CLI and 2-minute freshness. GitHub Enterprise
  hosts aren't supported: the link parser and the poller only accept `github.com`.
- **Other hosts are links only.** Azure DevOps and Bitbucket PRs are recognised so they show as PRs, but
  aren't polled.

## Code map

| File                                         | What it does                                                    |
| -------------------------------------------- | --------------------------------------------------------------- |
| `apps/server/src/integrations/github.ts`     | Status checks, polling, `fetchSnapshot`, `mapPrSnapshot`        |
| `apps/server/src/integrations/index.ts`      | Starts the integrations, `refreshLink`                          |
| `apps/server/src/services/links.ts`          | Adding links, `setSnapshot`, `completeOnMerge`                  |
| `packages/contracts/src/links.ts`            | URL and key classification                                     |
| `packages/contracts/src/derive.ts`           | `deriveAttention`                                               |
| `apps/web/src/components/board/CardLinks.tsx`, `task/LinksSection.tsx` | PR chips on the card and in the panel  |
| `apps/web/src/components/settings/AppSettingsDialog.tsx` | The GitHub section in Settings                      |
