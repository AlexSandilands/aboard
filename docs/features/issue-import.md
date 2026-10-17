# Issue import

Board task: #62. Verified against Claude Code 2.1.301 and gh 2.96 (October 2026).

Pasting a Jira key or URL, or a GitHub issue URL, as a new task's title creates the task at once and fills
in its title, description and labels in the background. The task is usable straight away; the details
arrive a few seconds later.

## How it works

### Starting an import

In the command palette (**New task…**), the title box recognises:

| Pasted text                                   | Row it shows                    |
| --------------------------------------------- | ------------------------------- |
| `PROJ-123`                                    | Import PROJ-123 from Jira       |
| `https://<jira host>/browse/PROJ-123`         | Import PROJ-123 from Jira       |
| `https://<host>/<owner>/<repo>/issues/45`     | Import owner/repo#45 from GitHub |

`parseIssueSource` (`packages/contracts/src/links.ts`) decides. Ordinary titles, pull request URLs and
standards that look like keys (`UTF-8`) are not issues. Only the Backlog flow imports: a task that opens
the plan editor is titled by the user.

Submitting sends `sourceUrl` on `POST /api/tasks`. The server (`tasks.create`) parses it, titles the task
with a placeholder (`PROJ-123` or `owner/repo#45`), links the issue, records the import as **pending** in
`task_imports` and returns; the route then starts the background job. The MCP tools don't take a
`sourceUrl`. Imported tasks land in Backlog like any task created without a plan, and a source can't be
combined with a plan.

### The job

`integrations/issueImport.ts` runs up to three imports at once, in the server process.

- **GitHub.** `gh issue view` reads the issue (`GithubIntegration.fetchIssue`), and its state is stored as
  the `issue` link's snapshot. Claude Code headless (`claude -p`, `--model`, default `haiku`) then turns it
  into a concise title, a summary and labels. The issue text goes in the prompt, so the run has no tools and
  no MCP servers. If the model can't run (import turned off, CLI missing, a failure), the task gets the
  issue's own title, its body cut to 4000 characters and its GitHub labels, and the import still succeeds.
- **Jira.** Only the model can read it, through the user's own Jira MCP server, so the run keeps the user's
  MCP configuration (no `--strict-mcp-config`). It runs in the temp folder, not the project's: the project's
  `.mcp.json` and settings belong to the repo, and a repo shouldn't get to start servers or allow tools in a
  run that reads text from outside. So the Jira server has to be one of the user's (`claude mcp add --scope
  user`, or a plugin or connector); a server scoped to one project isn't used. If there is no Jira tool, or the
  model can't read the issue, the import fails and says why.

Both runs use `--permission-mode dontAsk`, `--tools ""` (no built-in tools, so no files or shell),
`--setting-sources user` (the project's and local settings files, with their allow rules, hooks and MCP servers,
don't apply; the user's do, because sign-in can live there) and `--max-budget-usd`, with the result as
structured output (`{found, reason?, title, description, labels}`).
`found: false` is how the model reports an issue it couldn't read. The CLI path is the board reviewer's
(`headlessReviewCli`).

The result is applied by `ImportsService.complete`: the title is replaced only while it is still the
placeholder and the description only while it is empty, so anything the user typed in the meantime stands.
Labels are normalised with `normalizeLabel`, the ones that don't survive are dropped, they are added to the
task's own, and the total is capped at 10. The prompt lists the labels already on the board so the model
reuses them.

### Which Jira tools are allowed

Claude Code's allow rules take a glob only after a literal `mcp__<server>__` prefix (a `*` in the server
part is skipped), so "any read-only Jira tool on any server" can't be written. The board does this instead:

- If **Settings → Tasks → New tasks → Jira tools** lists rules, those are allowed as written.
- Otherwise it runs `claude mcp list`, takes the connected servers and allows `get_jira_issue`,
  `getJiraIssue` and `jira_get_issue` on each. Those are the single-issue reads of the servers we know of.
  A rule for a tool a server lacks does nothing. The list takes seconds, so imports that start together share
  one, and it is kept for five minutes (not when it came back empty).
- With no connected server the import fails with "No Jira tool available" rather than running a model that
  can't read anything.

`dontAsk` denies what nothing allows, but it does allow whatever the user's own settings already allow, and a
blanket rule such as `mcp__atlassian` there would let an injected request create or comment on an issue. So
the run also denies, on every connected MCP server and every server a Jira rule names (even one allowed as a
whole), the tools whose names look like writes: a verb from a list (`create`, `update`, `post`, `set`, `link`,
`move`, `transition`, `comment`, …) at the start of the name or after a word break, in snake, kebab and camel case
(`set_due_date`, `addCommentToIssue`), so `get_…` is never mistaken for `set`. Deny rules win over allow rules
in every mode. A tool a Jira rule allows by name is never denied. This is a best effort by name, not a
sandbox.

The allow and deny rules go in a settings file in a temp folder, passed with `--settings` and deleted after the
run. On the command line they would run past the 8191 characters a Windows `.cmd` shim (an npm-installed
`claude`) accepts once a few servers are connected.

### Untrusted text

Whatever an issue says is data. The prompt tells the model so, fences the issue in tags with a random name
(so text inside the issue can't close the fence and pass itself off as instructions), and puts every
instruction before it. A GitHub run has no tools at all. A Jira run has the user's MCP servers, limited as
above, and its result is only a title, a description and labels. Nothing a run produces is executed.

### States

`task_imports` holds one row per imported task: `pending`, `failed` (with the reason) or `done`. It stays
after success so the task still says where it came from.

- **Pending.** The card and the panel header show "Fetching details…", and the panel a callout. A run is
  counted when it starts (`claim`), so an import interrupted by restarts is picked up again at startup
  (`resumeImports`, whether or not the pollers run) and gives up after three runs. One left pending with
  nothing running it (its task was archived over a restart) can be started again with the callout's Retry,
  which a running import ignores.
- **Failed.** The card shows the warning icon, from the `import_failed` attention reason, which also lists
  the task under "Needs attention". The panel says why and has **Retry** (`POST /api/tasks/:id/import/retry`,
  which puts it back to pending with a fresh count; a finished import answers 409). The placeholder task stays
  usable.
- **Done.** Nothing shows; the activity log has an `imported` entry by actor `import`.

### The `issue` link

A GitHub issue URL is classified as an `issue` link (`ref` host, repo and number; `snapshot` state and
title). The snapshot is read once, at import. Nothing polls issue state.

### Backups

[Backups](backup.md) don't carry `task_imports`, so a restored task has no import state (nothing runs again, and
a task that was still pending keeps its placeholder title). They also leave out link snapshots as the pollers'
cache; nothing polls an issue, so a restored `issue` link shows no open/closed badge.

### Settings

| Setting                | Default | What it does                                                                |
| ---------------------- | ------- | --------------------------------------------------------------------------- |
| `issueImportEnabled`   | on      | Run the model. Off: GitHub issues import as written, Jira issues fail       |
| `issueImportModel`     | `haiku` | `claude --model`                                                            |
| `issueImportBudgetUsd` | 0.5     | `claude --max-budget-usd` for one import                                    |
| `issueImportJiraTools` | none    | Jira tools a run may call; empty looks for the common ones on each server   |

## Decisions

- **Create first, fill in later.** A paste is never slower than typing a title, and a failed import costs
  nothing but a warning. The cost is a placeholder title for a few seconds.
- **State in a table, not memory.** A restart mid-import doesn't lose it, and the card can say why one failed.
- **GitHub through `gh`, Jira through the user's MCP.** The board already depends on `gh` and holds no Jira
  credentials, so the only way to read a Jira issue is the Jira access the user's Claude Code already has.
- **A rewrite never overwrites the user.** `complete` only fills what is still the placeholder or empty.

## Alternatives considered

| Option                                         | Why not chosen                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| Fetch first, create the task when it arrives   | A paste would block for seconds, and a failure would lose the paste                  |
| Jira REST with a stored API token              | The board would hold a credential, and Jira Cloud and Server differ in auth          |
| `mcp__*__get_jira_issue` as one allow rule     | Claude Code skips an allow rule with a glob in the server part                       |
| Poll imported issues' state                    | Out of scope; the snapshot is a record of what was imported                          |

## Code map

| File                                         | What it does                                                          |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `packages/contracts/src/links.ts`            | `parseIssueSource`, the `issue` link classification                   |
| `apps/server/src/services/imports.ts`        | Import state: begin, claim, complete, fail, retry                     |
| `apps/server/src/services/tasks.ts`          | `create` with `sourceUrl`                                             |
| `apps/server/src/integrations/issueImport.ts`| The background job                                                    |
| `apps/server/src/integrations/headlessImport.ts` | Prompt, `claude` arguments, output, finding Jira tools            |
| `apps/server/src/integrations/claudeCli.ts`  | Running `claude -p` and reading its result, shared with the reviewer  |
| `apps/server/src/integrations/github.ts`     | `fetchIssue`                                                          |
| `apps/server/src/db/migrations/008_issue_imports.sql` | `task_imports`, and `issue` in `task_links`'s kinds          |
| `apps/web/src/components/command/palette.logic.ts` | `issueImportRow`                                                |
| `apps/web/src/components/task/ImportCallout.tsx`   | Pending and failed states in the panel                          |
| `apps/web/src/components/settings/IssueImportSection.tsx` | The settings                                             |
