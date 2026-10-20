# Issue import

Board tasks: #62, #77 (epics). Verified against Claude Code 2.1.301 and gh 2.96 (October 2026).

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
  the `issue` link's snapshot. Claude Code headless (`claude -p`, `--model`, default `haiku`, or a model tier,
  see [Settings](#settings)) then turns it
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
structured output (`{found, reason?, title, description, labels, isEpic?, children?, childTotal?}`; the last three
only for a Jira epic, see [Epics](#epics)).
`found: false` is how the model reports an issue it couldn't read. The CLI path is the board reviewer's
(`headlessReviewCli`).

The result is applied by `ImportsService.complete`: the title is replaced only while it is still the
placeholder and the description only while it is empty, so anything the user typed in the meantime stands.
Labels are normalised with `normalizeLabel`, the ones that don't survive are dropped, they are added to the
task's own, and the total is capped at 10. The prompt lists the labels already on the board so the model
reuses them.

### Epics

An issue that is an epic becomes one on the board, and its children become its tasks.

- **Finding out.** GitHub: after `gh issue view`, the board reads the issue's sub-issues with
  `gh api --paginate repos/{o}/{r}/issues/{n}/sub_issues --jq '.[].html_url'` (`fetchSubIssues`); an issue with any
  is an epic. A failed read is logged and the issue imports as a task. A task already in an epic (an epic's own
  child) isn't asked, since epics don't nest. Jira: the prompt asks the run, when the issue's
  type is Epic or its hierarchy level is 1, to set `isEpic`, run two searches, `"Epic Link" = KEY` (the epic's
  issues in company-managed projects; a failure because the field is unknown in the project, as in team-managed projects, is ignored; any other failure fails the import) and
  `parent = KEY` (its sub-tasks), merge the keys without duplicates with the Epic Link results first, and return the
  first 50 in `children` and the count of the whole union in `childTotal`. It doesn't read the children.
- **Converting.** `ImportsService.complete` applies the result as usual, then `fillEpic` (same write) turns the
  task into an epic with `tasks.makeEpic`, which logs `became_epic` and re-derives its status from its tasks. It
  refuses a task that has a plan, is in an epic, is archived or closed, or has an Autopilot flag or priority (none of
  which an epic can have, and all of which the user may have set while the import ran): the import still completes,
  and a note on the task says it is an epic that wasn't imported as one. `tasks.create` still refuses an epic with a
  `sourceUrl`; only the import converts. A Jira epic with no children listed stays a task with a note too: an empty
  epic looks the same as one whose children couldn't be searched (a tools list in Settings without a search tool,
  a search tool by another name, a failed search), and an empty epic nobody notices is worse than a note.
- **Children.** Each child, at most 50 (`IMPORT_CHILDREN_MAX`), is parsed with `parseIssueSource` (a child that
  isn't the same kind of issue as its epic is dropped and counted: a Jira epic's list comes from the model, and a
  GitHub URL in it would be read with the user's `gh`), then matched against the unarchived tasks in the project linked
  to the same issue (Jira key, or GitHub host, repo and number):
  - none, or only archived ones: a new task in the epic with the child as its `sourceUrl`, created by `import`;
  - a loose task: it moves into the epic (`tasks.update(epicId)`), keeping its title and plan;
  - a task already in another epic, or an epic: it stays put, and the epic's note names it.
- **Their imports.** `complete` returns the new tasks (`childImports`), and the job queues them behind whatever is
  waiting, three at a time like any import. A child that fails is a failed import on that task; the epic stays. A
  child that has sub-issues of its own is already in an epic, so it stays a task (epics don't nest).
- **The note.** One note by `import` on the epic says what didn't simply become a new task: children that moved in,
  ones left in another epic, skipped keys, and the total when the issue has more than 50.

The panel's import callout shows "Importing the epic's tasks: 12 of 30" while any child import is pending
(`epicImportProgress`). The board needs nothing new: the epic's `task.upserted` carries `kind: "epic"`, so the card
becomes a band, and each child's upsert puts it in the band.

### Which Jira tools are allowed

Claude Code's allow rules take a glob only after a literal `mcp__<server>__` prefix (a `*` in the server
part is skipped), so "any read-only Jira tool on any server" can't be written. The board does this instead:

- If **Settings → Tasks → New tasks → Jira tools** lists rules, those are allowed as written.
- Otherwise it runs `claude mcp list`, takes the connected servers and allows `get_jira_issue`,
  `getJiraIssue` and `jira_get_issue` on each, the single-issue reads of the servers we know of, and their JQL
  searches `search_jira`, `searchJiraIssuesUsingJql` and `jira_search`, which find an epic's children. None of
  these names looks like a write.
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
| `issueImportModel`     | `haiku` | A `HeadlessModel`: a tier or a model for `claude --model`, see below        |
| `issueImportBudgetUsd` | 0.5     | `claude --max-budget-usd` for one import                                    |
| `issueImportJiraTools` | none    | Jira tools a run may call; empty looks for the common ones on each server   |

`issueImportModel` is a `HeadlessModel` (`packages/contracts/src/headlessModel.ts`): `{ tier }` or `{ model }`.
A bare string, which is how it was saved before tiers were an option, parses as `{ model }`, and the settings
service normalizes a stored string on read (a value that is neither falls back to `haiku`). A tier runs the
`claude-code` model of that tier in Settings → Model tiers (`resolveHeadlessModel`), at that tier's effort
(`resolveHeadlessEffort`, as `--effort`; a typed model has none); a tier with none leaves
`--model` off, so the CLI's own default runs. The picker (`HeadlessModelRow`) says which of the two it will be and
links to the tier. The board reviewer's model (`headlessReviewModel`, see
[local review](local-review.md#the-board-reviewer)) is the same type.

## Decisions

- **Create first, fill in later.** A paste is never slower than typing a title, and a failed import costs
  nothing but a warning. The cost is a placeholder title for a few seconds.
- **State in a table, not memory.** A restart mid-import doesn't lose it, and the card can say why one failed.
- **GitHub through `gh`, Jira through the user's MCP.** The board already depends on `gh` and holds no Jira
  credentials, so the only way to read a Jira issue is the Jira access the user's Claude Code already has.
- **A rewrite never overwrites the user.** `complete` only fills what is still the placeholder or empty.
- **An epic is detected, not chosen.** Pasting an epic gives an epic with no extra step; a task the user has
  already shaped (a plan, an epic, a flag) is left a task, with a note.
- **Children are full imports.** Each child gets its own run and its own title, summary and labels, through the same
  queue, rather than a list of bare keys the user has to fill in.
- **No duplicates.** A child already on the board in the project joins the epic instead of being created again.

## Alternatives considered

| Option                                         | Why not chosen                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| Fetch first, create the task when it arrives   | A paste would block for seconds, and a failure would lose the paste                  |
| Jira REST with a stored API token              | The board would hold a credential, and Jira Cloud and Server differ in auth          |
| `mcp__*__get_jira_issue` as one allow rule     | Claude Code skips an allow rule with a glob in the server part                       |
| Poll imported issues' state                    | Out of scope; the snapshot is a record of what was imported                          |
| One Jira run that also summarises every child  | One long run per epic, and a child's failure would fail them all                     |
| Import all of an epic's children, however many | A runaway epic would queue hundreds of runs; 50 covers real epics, the note says more |

## Code map

| File                                         | What it does                                                          |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `packages/contracts/src/links.ts`            | `parseIssueSource`, the `issue` link classification                   |
| `apps/server/src/services/imports.ts`        | Import state: begin, claim, complete, fail, retry; `fillEpic`         |
| `apps/server/src/services/tasks.ts`          | `create` with `sourceUrl`; `makeEpic`                                 |
| `apps/server/src/integrations/issueImport.ts`| The background job                                                    |
| `apps/server/src/integrations/headlessImport.ts` | Prompt, `claude` arguments, output, finding Jira tools            |
| `apps/server/src/integrations/claudeCli.ts`  | Running `claude -p` and reading its result, shared with the reviewer  |
| `apps/server/src/integrations/github.ts`     | `fetchIssue`, `fetchSubIssues`                                        |
| `apps/server/src/db/migrations/008_issue_imports.sql` | `task_imports`, and `issue` in `task_links`'s kinds          |
| `apps/web/src/components/command/palette.logic.ts` | `issueImportRow`                                                |
| `apps/web/src/components/task/ImportCallout.tsx`   | Pending and failed states in the panel; an epic's progress      |
| `apps/web/src/components/settings/IssueImportSection.tsx` | The settings                                             |
