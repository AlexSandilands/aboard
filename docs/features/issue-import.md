# Issue import

Board tasks: #62, #77 (epics), #247 (epic), #249. Verified against Claude Code 2.1.301 and gh 2.96 (October 2026).

Pasting a ticket key or URL of a configured [ticket system](ticket-systems.md) (Jira, Linear, an in-house tracker), or a
GitHub issue URL, as a new task's title creates the task at once and fills in its title, description and labels in the
background. The task is usable straight away; the details arrive a few seconds later.

## How it works

### Starting an import

In the command palette (**New task…**), the title box recognises:

| Pasted text                                 | Row it shows                       |
| ------------------------------------------- | ---------------------------------- |
| `PROJ-123`                                  | Import PROJ-123 from <System name> |
| a ticket URL a system's URL pattern matches | Import PROJ-123 from <System name> |
| `https://<host>/<owner>/<repo>/issues/45`   | Import owner/repo#45 from GitHub   |

`parseImportSource(value, systems)` (`packages/contracts/src/links.ts`) decides, with the key and URL patterns of the
configured systems, the first matching system winning (see [ticket systems](ticket-systems.md#classifying-a-link)). With
no systems configured no key is a ticket. Ordinary titles, pull request URLs and anything no system's pattern matches
(`UTF-8`) are not issues. Only the Backlog flow imports: a task that opens the plan editor is titled by the user.

Submitting sends `sourceUrl` on `POST /api/tasks`. The server (`tasks.create`) parses it, titles the task
with a placeholder (`PROJ-123` or `owner/repo#45`), links the issue, records the import as **pending** in
`task_imports` and returns; the route then starts the background job. For a ticket the record keeps its system as
`system_id`, so editing or reordering the systems later doesn't move it. The MCP tools don't take a `sourceUrl`.
Imported tasks land in Backlog like any task created without a plan, and a source can't be combined with a plan.

### The job

`integrations/issueImport.ts` runs up to three imports at once, in the server process.

- **GitHub.** `gh issue view` reads the issue (`GithubIntegration.fetchIssue`), and its state is stored as
  the `issue` link's snapshot. Claude Code headless (`claude -p`, `--model`, default `haiku`, or a model tier,
  see [Settings](#settings)) then turns it
  into a concise title, a summary and labels. The issue text goes in the prompt, so the run has no tools and
  no MCP servers. If the model can't run (import turned off, CLI missing, a failure), the task gets the
  issue's own title, its body cut to 4000 characters and its GitHub labels, and the import still succeeds.
- **Ticket.** Only the model can read it, through the user's own MCP server for its system, so the run keeps the user's
  MCP configuration (no `--strict-mcp-config`). It runs in the temp folder, not the project's: the project's
  `.mcp.json` and settings belong to the repo, and a repo shouldn't get to start servers or allow tools in a
  run that reads text from outside. So the server has to be one of the user's (`claude mcp add --scope
  user`, or a plugin or connector); a server scoped to one project isn't used. The prompt (`importPrompt`) is the same
  for every system: it names the system and the key, says to read only, and puts the system's `importInstructions`
  (how to read its tickets, what an epic is, how to find its children) in a fenced configuration block, written by the
  user and not by anyone who can edit tickets. If the system lists no import tools, the import fails before running
  with "Add import tools to <system> in Settings → Integrations → Ticket systems". If the model has no tool that works,
  or can't read the ticket, it fails and says why.

Both runs use `--permission-mode dontAsk`, `--tools ""` (no built-in tools, so no files or shell),
`--setting-sources user` (the project's and local settings files, with their allow rules, hooks and MCP servers,
don't apply; the user's do, because sign-in can live there) and `--max-budget-usd`, with the result as
structured output (`{found, reason?, title, description, labels, isEpic?, children?, childTotal?}`; the last three
only for a ticket epic, see [Epics](#epics)).
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
  child) isn't asked, since epics don't nest. Ticket: the prompt asks the run, when the ticket is an epic (as the
  system's instructions define it), to set `isEpic`, list its children as the instructions say, and return the keys of
  the first 50 in `children` and the count of all of them in `childTotal`. It doesn't read the children. Which tool and
  query finds them is the system's business: the Jira preset's instructions carry the `"Epic Link" = KEY` and
  `parent = KEY` searches (merged, Epic Link first; an unknown Epic Link field is ignored), the Linear preset says an
  epic is an issue with sub-issues. A failure the instructions don't say to ignore fails the import.
- **Converting.** `ImportsService.complete` applies the result as usual, then `fillEpic` (same write) turns the
  task into an epic with `tasks.makeEpic`, which logs `became_epic` and re-derives its status from its tasks. It
  refuses a task that has a plan, is in an epic, is archived or closed, or has an Autopilot flag or priority (none of
  which an epic can have, and all of which the user may have set while the import ran): the import still completes,
  and a note on the task says it is an epic that wasn't imported as one. `tasks.create` still refuses an epic with a
  `sourceUrl`; only the import converts. A ticket epic with no children listed stays a task with a note too: an empty
  epic looks the same as one whose children couldn't be searched (import tools without a search tool, instructions that
  don't say how to find children, a failed search), and an empty epic nobody notices is worse than a note.
- **Children.** Each child, at most 50 (`IMPORT_CHILDREN_MAX`), is parsed with `parseImportSource`, for a ticket epic
  against its own system only (the key patterns of two systems can overlap, and a bare key would go to whichever is
  listed first); the child is created with `tasks.create(…, { ticketSystem })` so its link and import record name the
  same system. A child that isn't the same kind of issue as its epic, or that its system doesn't recognise (another
  system's URL, say), is dropped and counted: a ticket epic's list comes from the model, and a GitHub URL in it would
  be read with the user's `gh`. The rest are
  matched against the unarchived tasks in the project linked to the same issue (system and key, or GitHub host, repo
  and number):
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

### Which tools are allowed

Claude Code's allow rules take a glob only after a literal `mcp__<server>__` prefix (a `*` in the server
part is skipped), so "any read-only tool on any server" can't be written, and the board doesn't guess tool names for a
tracker it knows nothing about. The run is allowed only the system's **import tools** (`importTools`, rules like
`mcp__atlassian__getJiraIssue`, as custom automations take them), set per system under **Settings → Integrations →
Ticket systems**. The presets leave them empty, because the server's name is the user's.

`dontAsk` denies what nothing allows, but it does allow whatever the user's own settings already allow, and a
blanket rule such as `mcp__atlassian` there would let an injected request create or comment on a ticket. So
the run also denies, on every connected MCP server and every server an import tool names (even one allowed as a
whole), the tools whose names look like writes: a verb from a list (`create`, `update`, `post`, `set`, `link`,
`move`, `transition`, `comment`, …) at the start of the name or after a word break, in snake, kebab and camel case
(`set_due_date`, `addCommentToIssue`), so `get_…` is never mistaken for `set`. Deny rules win over allow rules
in every mode. A tool an import tool allows by name is never denied. This is a best effort by name, not a sandbox.

The connected servers come from `claude mcp list`, which health-checks every server and takes seconds, so imports that
start together share one listing, kept for five minutes (not when it came back empty or failed). If it fails the import
still runs, and the servers its tools name are denied as above.

The allow and deny rules go in a settings file in a temp folder, passed with `--settings` and deleted after the
run. On the command line they would run past the 8191 characters a Windows `.cmd` shim (an npm-installed
`claude`) accepts once a few servers are connected.

### Untrusted text

Whatever a ticket or issue says is data. The prompt tells the model so, fences the issue in tags with a random name
(so text inside the issue can't close the fence and pass itself off as instructions), and puts every
instruction before it. A GitHub run has no tools at all. A ticket run has the user's MCP servers, limited as
above, and its result is only a title, a description and labels. Nothing a run produces is executed. The system's
instructions are the user's own configuration, fenced the same way and described as such, not as ticket text.

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

### The links

A ticket is linked as a `ticket` link, a GitHub issue URL as an `issue` link (`ref` host, repo and number; `snapshot`
state and title). The snapshot is read once, at import. Nothing polls issue state.

### Backups

[Backups](backup.md) don't carry `task_imports`, so a restored task has no import state (nothing runs again, and
a task that was still pending keeps its placeholder title). They also leave out link snapshots as the pollers'
cache; nothing polls an issue, so a restored `issue` link shows no open/closed badge.

### Settings

| Setting                | Default | What it does                                                          |
| ---------------------- | ------- | --------------------------------------------------------------------- |
| `issueImportEnabled`   | on      | Run the model. Off: GitHub issues import as written, tickets fail     |
| `issueImportModel`     | `haiku` | A `HeadlessModel`: a tier or a model for `claude --model`, see below  |
| `issueImportBudgetUsd` | 0.5     | `claude --max-budget-usd` for one import                              |

A ticket system's `importTools` and `importInstructions` are on the system ([ticket systems](ticket-systems.md#a-system)),
not here. Before ticket systems a Jira tools setting (`issueImportJiraTools`) lived here; it became the `jira` system's
import tools ([upgrading](ticket-systems.md#upgrading-from-the-jira-settings)).

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
- **GitHub through `gh`, tickets through the user's MCP.** The board already depends on `gh` and holds no tracker
  credentials, so the only way to read a ticket is the access the user's Claude Code already has.
- **A system says how; the board doesn't know.** The prompt's instructions, the allowed tools and the epic search come
  from the ticket system's own configuration, so Linear or an in-house tracker imports like Jira. The Jira preset
  carries what used to be hard-coded (the `Epic Link` and `parent` searches) as data, and the board no longer guesses
  tool names: no import tools, no import.
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
| Guess each tracker's read tools by name        | The board knows no tracker; a wrong guess allows the wrong tool, or none that works  |
| Poll imported issues' state                    | Out of scope; the snapshot is a record of what was imported                          |
| One ticket run that also summarises every child | One long run per epic, and a child's failure would fail them all                    |
| Import all of an epic's children, however many | A runaway epic would queue hundreds of runs; 50 covers real epics, the note says more |

## Code map

| File                                         | What it does                                                          |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `packages/contracts/src/links.ts`            | `parseImportSource`, the `issue` link classification                  |
| `packages/contracts/src/ticketSystems.ts`    | `importTools`, `importInstructions` of a system                       |
| `apps/server/src/services/imports.ts`        | Import state: begin, claim, complete, fail, retry; `fillEpic`         |
| `apps/server/src/services/tasks.ts`          | `create` with `sourceUrl`; `makeEpic`                                 |
| `apps/server/src/integrations/issueImport.ts`| The background job                                                    |
| `apps/server/src/integrations/headlessImport.ts` | Prompt, `claude` arguments, output, the write-tool deny rules     |
| `apps/server/src/integrations/claudeCli.ts`  | Running `claude -p` and reading its result, shared with the reviewer  |
| `apps/server/src/integrations/github.ts`     | `fetchIssue`, `fetchSubIssues`                                        |
| `apps/server/src/db/migrations/008_issue_imports.sql` | `task_imports`, and `issue` in `task_links`'s kinds          |
| `apps/web/src/components/command/palette.logic.ts` | `issueImportRow`                                                |
| `apps/web/src/components/task/ImportCallout.tsx`   | Pending and failed states in the panel; an epic's progress      |
| `apps/web/src/components/settings/IssueImportSection.tsx` | The settings                                             |
