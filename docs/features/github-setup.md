# GitHub setup

Board task: #9.

How the GitHub repo is protected and configured, for a project with one maintainer. `main` only changes through
a pull request whose CI is green, and nobody, the admin included, can push to it directly, force-push it or delete
it. No review is required, so a green PR can be merged straight away, by hand, from the board or by Autopilot,
with nothing to bypass. The settings live in the repo and a script applies them.

## How it works

### The `main` ruleset

`.github/rulesets/main.json` targets the default branch:

| Rule                       | Effect                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| Pull request, 0 approvals  | Every change goes through a PR, so CI runs on it first. Squash is the only merge method      |
| Required checks            | `check (ubuntu-latest)`, `check (windows-latest)` and `commitlint` must pass, from GitHub Actions |
| No deletion, no force-push | History on `main` is never rewritten or lost                                                |
| Linear history             | No merge commits                                                                            |
| No bypass actors           | The rules apply to everyone, so nothing gets admin-bypassed                                 |

The checks are tied to the GitHub Actions app (`integration_id` 15368), so a status posted under the same name
by anything else doesn't count. Branches don't have to be up to date with `main` before merging: with one person
merging, PRs rarely overlap, and requiring it would mean a rebase and a full CI run before most merges.

### The release tags ruleset

`.github/rulesets/release-tags.json` covers `v*` tags and the `pacman` tag ([releases](releases.md)). They can be
created, so publishing a release and the first pacman upload still work, but not moved or deleted. A tag that
fails the release's date check has to stay, or the ruleset has to be switched off to delete it (below).

### Repo options

`scripts/github-setup.ts` also sets:

- **Squash merges only**, titled with the PR title and with the commit messages as the body, so `main` gets one
  Conventional commit per PR and keeps `Co-Authored-By` trailers. Autopilot's merges of task PRs into an epic's
  branch follow it: with merge commits off it squashes there too ([Autopilot](autopilot.md)).
- **Auto-merge** allowed, **update branch** offered, **head branches deleted** on merge.
- **Dependabot alerts and security updates** on.

Secret scanning and push protection are on already and aren't managed by the script.

### CI that the rules rely on

- `.github/workflows/ci.yml` runs `pnpm check` and the desktop build on Ubuntu and Windows: the two `check (…)`
  checks.
- `.github/workflows/commitlint.yml` lints the PR's commits and its title: the `commitlint` check. The title is
  what lands on `main`. It's a workflow of its own so that editing a PR's title re-runs it (the `edited` event)
  without re-running CI.
- Every action is pinned to a commit hash, with its version in a comment, so a moved tag can't change what runs.
- `.github/dependabot.yml` opens monthly updates for npm and the actions, minor and patch grouped into one PR per
  ecosystem, with `chore(deps):` and `ci(deps):` titles. `commitlint.config.js` skips Dependabot's commits, whose
  bodies break the footer rules; their PR titles are still linted.
- The `pacman` and `aur` jobs in `release.yml` run in the `release` environment, which holds the signing secrets
  and only deploys from `main` and `v*` tags. A workflow on a PR branch can't read them.

### Applying and changing the settings

```sh
pnpm github:setup -- --dry-run   # what would change
pnpm github:setup                # apply
```

It needs `gh` signed in as a repo admin and reads the repo from `origin`. Rulesets are matched by name: one that
doesn't exist yet is created, one that differs from its file is replaced, and one with no file is left alone with
a note. Running it again changes nothing.

To change a rule, edit the JSON (it's GitHub's ruleset format, as **Settings → Rules → Rulesets → Export** gives
it), merge the PR, then run the script. The `release` environment and its secrets are set up by hand under
**Settings → Environments**: secret values can't be read back, so the script can't move them.

### Renaming a CI job

A required check is matched by name. If a job is renamed, or the matrix changes, the old name stops being
reported and every PR waits for it forever. `pnpm github:check`, part of `pnpm check`, works out the check names
the `pull_request` workflows report (`name (matrix values)` for a matrix job) and fails if a required check isn't
one of them. When it fails, rename the check in `main.json` in the same PR and run `pnpm github:setup` once it
has merged.

### In an emergency

If `main` has to change without a PR (CI itself is broken and the fix can't pass it), switch the ruleset off under
**Settings → Rules → Rulesets → main → Enforcement: Disabled**, push, and run `pnpm github:setup` to switch it
back on. The same goes for deleting a release tag.

## Decisions

- **No required approvals.** GitHub doesn't let a PR's author approve it, so with one maintainer a required
  review can only be met by bypassing it, which makes it a click rather than a check. CI is the reviewer that
  every PR has to get past.
- **No bypass list.** An admin bypass would be needed to merge every PR if a review were required; without one
  there's nothing to bypass, and the rules protect against the admin's own mistakes too. Switching the ruleset off
  is the escape hatch, and it's deliberate enough not to happen by accident.
- **Board and Autopilot merges keep working.** `merge_task_pr` and Autopilot merge only a PR that GitHub reports
  as mergeable and green ([GitHub PRs](github-prs.md#merging)); with no approval required, a green PR is
  `CLEAN`.
- **Squash only.** One commit per PR keeps `main` linear and its history Conventional, which the PR title check
  guarantees. Integration epics squash too: the epic's PR lands on `main` as one commit.
- **Settings in the repo.** The rules are reviewed in a PR like code, and the script brings a fresh fork or a
  reset repo back to the same state.
- **No CODEOWNERS.** It only does something when code-owner review is required, which one person can't give.

## Alternatives considered

| Option                                 | Why not chosen                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Required review with an admin bypass   | Every merge is a bypass, so the review protects nothing and the board can't merge                |
| No protection at all                   | A direct or force push to `main` skips CI or loses history                                       |
| Classic branch protection              | Rulesets do the same, export as JSON, and can cover tags                                         |
| Requiring branches to be up to date    | A rebase and a full CI run before most merges, for conflicts one maintainer rarely has           |
| A merge queue                          | Built for many people merging at once                                                            |
| CodeQL                                 | Slow on every PR for a local app with few untrusted inputs; Dependabot covers dependencies       |
| A settings app (Probot `settings.yml`) | A third-party app with admin rights on the repo, where a script run by hand is enough            |

## Code map

| File                                 | What it does                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `.github/rulesets/main.json`         | The `main` ruleset                                                            |
| `.github/rulesets/release-tags.json` | The release tags ruleset                                                      |
| `scripts/github-setup.ts`            | Applies the rulesets and repo options; `--check` checks required check names |
| `.github/workflows/ci.yml`           | The `check (…)` jobs                                                          |
| `.github/workflows/commitlint.yml`   | The `commitlint` job: commits and PR title                                    |
| `.github/dependabot.yml`             | Dependabot version updates                                                    |
| `commitlint.config.js`               | Commit rules, and skipping Dependabot's commits                               |
