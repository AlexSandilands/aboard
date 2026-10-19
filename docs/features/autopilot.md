# Autopilot

Board tasks: #79 (engine core), #85 (runners), #88 (Unstick stale tasks), #90 (digest), #94 (start planned tasks), #95
(PR review), #97 (custom automations), in epic #101; #123 (Merge into epic branch); #135 (sharing custom automations).

Autopilot lets the board act on its own: a catalogue of automations, each switched on or off per epic, per project or
for the whole board, that watch the board and act when something needs doing. The engine is deterministic code in
the server. It never calls an LLM itself; an automation whose action needs one starts an agent through a runner.
The rules every automation lives under are in [ADR 0008](../decisions/0008-autopilot-engine.md).

This doc covers the engine, the runners, the per-task flag, the automations that have landed (below) and the
settings UI. The digest's header button and panel are in [board-layout.md](board-layout.md#digest-of-what-changed). The rest of the catalogue is each its own task in the epic.

## How it works

### Switches and scopes

Each automation has a mode at each scope: **Inherit**, **On** or **Off**. The most specific scope that isn't
Inherit wins: epic over project over board. With nothing set anywhere, an automation is off.

The board is the top scope, so Inherit there would only fall back to that default, which is the same as Off. The
board's switch therefore offers **On** and **Off** only (`BOARD_MODES`); no row reads as Off, and picking Off saves
`inherit`, which drops the row unless it still holds config. The server still accepts all three modes at every
scope, so the API and old rows are unchanged. Projects and epics keep Inherit / On / Off.

| Board | Project | Epic    | Effective      |
| ----- | ------- | ------- | -------------- |
| —     | —       | —       | Off (default)  |
| On    | Inherit | Inherit | On (board)     |
| On    | Off     | Inherit | Off (project)  |
| Off   | On      | Inherit | On (project)   |
| Off   | Off     | On      | On (epic)      |
| On    | On      | Off     | Off (epic)     |

An epic's setting covers only the tasks in it (`parent_id`). A task with no epic skips that level, and so does a
task whose epic is archived: an archived epic no longer counts (unarchive it and its rows apply again). The epic
card itself isn't "in" an epic, so it follows its project, except as a candidate that is the epic card itself
(today only Auto-archive's), which the engine resolves on the epic.

An automation says whether an epic can switch it with `epicScope` (default true; `describeAutomation` sends it to the
UI). Set it false when its candidates are never tasks in an epic: Recurring tasks (per project, no task) and the Digest
do. For those the epic's popover leaves the automation out, the
epic button's state ignores it, the epic's scope entries don't list it, `PUT` of an epic switch for it is a
`VALIDATION` error, and an epic row left over from before the flag was set is ignored (`resolve` and
`projectsWithEpicOn` skip the epic level).

Each automation also has config (a skill, a budget, a number of days). Config keys merge the same way, board
first, then project, then epic, over the automation's defaults, whatever the modes: a project can tune an
automation the board switches on, and an epic can tune one for its tasks. `resolveAutopilot` in `packages/contracts/src/autopilot.ts` is the rule, and
`describeInherited` gives the UI its "Inherit (On from board)" label.

Rows live in `autopilot_settings`, keyed by scope and automation. The board scope has an empty `scope_id`. The
service reads or sets an epic scope only for an epic in the project it is given (`NOT_FOUND` otherwise: another
project's epic, a plain task, an id that doesn't exist). Deleting a project (or an epic) deletes its rows, through
triggers, since `scope_id` can't carry a foreign key.

The engine resolves per task: `resolve(automation, projectId, epicId)` in `services/autopilot.ts`. A pass looks at
a project where the automation is on, and also where one of its unarchived epics switches it on
(`projectsWithEpicOn`), since the project itself may be off. A `check` sees the whole project there, and the engine
drops every candidate whose task doesn't resolve to on, using the task's own epic. So `check` gets the *project's*
config, while `act` gets the task's effective config, epic keys included; a config key that changes what a `check`
finds can't be tuned per epic.

### Engine settings and pause

Engine-wide settings are one `autopilotEngine` key in the `settings` table, and Pause all is
`autopilotPaused`:

| Setting                | Default         | Meaning                                                              |
| ---------------------- | --------------- | -------------------------------------------------------------------- |
| `maxConcurrent`        | 1               | Autopilot's open agent runs at once (not a machine-wide limit)       |
| `dailyRunCap`          | none            | Agent runs started per local day                                    |
| `dailySpendCapUsd`     | none            | What agent runs created today may cost before no more start          |
| `quietHours`           | off, 22:00–07:00 | No agent runs start in the window (local time; may wrap midnight; equal ends are no window) |
| `dryRun`               | off             | Record what would run, and do nothing                                |
| `prReviewRounds`       | 3               | Rounds the PR review automation runs per PR                          |
| `prFixThreshold`       | major           | The lowest finding severity the PR automations ask an agent to fix   |
| `worktreeRetentionDays` | 7              | Days a finished headless run's worktree is kept when its PR hasn't merged |

Quiet hours and the caps only hold back automations with `needsAgent`; board-only actions (archiving a card)
go ahead. **Pause all** stops every new run; runs already going finish. Backups carry the engine settings but not
the pause, so a restore never lifts it.

### A pass

The engine (`apps/server/src/autopilot/engine.ts`) runs a pass a second after a burst of board events, every
60 seconds, and when Autopilot settings change. PR and T3 thread snapshots reach it as `task.upserted` events,
so they need no hook of their own. Events published while the engine itself writes start no pass. A pass:

1. Stops if paused.
2. For each automation, works out the projects where it's on or has an epic it's on for (and whether it's on for
   the board itself) and skips it if it's on nowhere.
3. Calls the automation's `check`, which returns candidates: a dedupe key, a one-line summary, and usually a
   task.
4. Drops candidates outside the scopes it's on in (per task: its epic, then its project), and candidates whose
   dedupe key already has a run.
5. In dry-run, records a `skipped` run with "Would …" as its summary and moves on.
6. For agent automations, holds the candidate in quiet hours, at the concurrency cap or at a daily cap. Held
   candidates aren't recorded, so a later pass picks them up. A candidate with `startsNoAgent` (Fix PRs giving up)
   isn't held: it starts no agent, so the caps and quiet hours don't apply to it, and it counts toward neither the daily run cap nor the concurrency count.
7. Records a `queued` run, marks it `running`, and calls the action. Agent actions, and automations marked
   `background` (custom shell commands and scripts), go on in the background; other board-only actions are awaited, one
   after another.

The engine never retries a run by itself: once a dedupe key has a run, whatever its outcome, that candidate is done. A
key that should act again changes (`review:pr:<headSha>`, `start:<taskId>:<statusChangedAt>`).

**Retrying by hand.** A real run that ended `failed` or `skipped` can be handed back to the engine
(`AutopilotService.retry`): the Autopilot section's **Retry** on the run, `POST /api/autopilot/runs/:id/retry`, or
the MCP tool `retry_autopilot_run(task, automation?)` (the task's newest such run, optionally of one automation by key
or title). A run the same automation has made a real run since (on the same task, or for a task-less run in the
same project) is superseded (`isSupersededRun`): the service refuses it with a `CONFLICT` and the panel shows no Retry on
it, since retrying would redo nothing yet drop it from the rounds and attempts. The run stays as history, but its dedupe key is retired to `retried:<runId>:<old key>` (`RETRIED_PREFIX`,
`canRetryRun` in contracts) and its attention flag is lifted, and the task logs an `autopilot_run` entry with status
`retried` under the caller. The old key is free, so the next pass acts on it again if `check` still finds the work,
under the switches, pause, quiet hours and caps as usual: retrying lifts no limit, which is why agents may call it.
Automations that count runs by key (Review PRs' rounds, Fix PRs' attempts, Merge into epic branch's tries) no longer
count the retried one. This replaces pushing an empty commit to get a new head reviewed after a board restart failed
the review. Dry-run runs are deduped
apart from real ones (the unique key is automation, dedupe key and `dry_run`), so turning dry-run off doesn't
hide work it only previewed.

### Runs

`autopilot_runs` holds one row per run: `queued → running → succeeded | failed | skipped`. The runner fills in
`runner`, `session_id`, `thread_url`, `worktree_path` and `cost_usd`. An action can leave a structured result in
`output_json` (`ActionResult.output`, `AutopilotRun.output`) for a later automation to read; Review PRs leaves its
verdict there. A custom automation's shell or script action fills in `exit_code` and `detail` (the output's tail); a dry run
of a custom automation keeps in `detail` what it would have run (`Candidate.preview`). Runs are history, so backups
leave them out.

- A task's runs log `autopilot_run` activity under the actor `autopilot`: when it starts, when it ends, and
  once for a dry-run preview.
- Every change to a run publishes `autopilot.changed` with the pause state and the runs in flight; the board
  snapshot carries the same `autopilot` object, so lanes, epic bands and cards can show what's running. Each run
  in flight carries its task's `epicId`, read from the task when the status is built (it isn't stored on the run).
- An action that throws fails its run and flags it **needs attention**. The server ends runs a restart left
  `queued` or `running` as failed ("The board restarted while this run was going") at startup, whether or not the
  pollers run (`recover`). A **Review PRs or Fix PRs** run is **retried once**: it is retired like a hand retry (key
  `retried:<runId>:<key>`, no flag, no inbox notification) and the task logs an `autopilot_run` entry with status
  `retried` and reason `restart`, so the engine redoes the work on its next pass and the run no longer counts as a
  Review PRs round or a Fix PRs attempt. Every other automation is flagged as before: a Start planned or
  Orchestrate run may have launched an agent, so redoing it could launch a second one. (A Fix PRs run killed after
  its agent pushed can likewise leave the redo with a second session; the engine re-checks the PR first and the
  attempt cap still applies.) Retries stop at one: a run
  whose work a restart already cut short (a retired run of the same automation and key that ended with that error)
  is flagged instead, so a run that itself restarts the board can't loop. A run a finished run of its automation
  has superseded is flagged too (runs stranded together don't supersede each other). Retired restart runs still
  count as restarts in `board_activity`. A restart that lands in the instant between GitHub accepting a review and
  the run recording it can make the redo post a second review; the check for a landed review only covers a post that
  returned an error, not one the process was killed during. In dev, `pnpm dev` and `pnpm sandbox` run the
  server under `tsx watch`, which restarts on edits but not on a file being read: `node --watch` also restarts
  on an NTFS last-access change, so an agent merely reading a server file would restart the board.

### Run history

The Run history page (`/settings/autopilot/runs/$automation`, `RunHistory`) lists every run of one automation, newest
first, or of all of them with `all`. Orchestrate's area, a custom automation's editor and the Automations heading link to
it. It is for reading what scheduled agents did, since their runs have no task panel, and for clearing out old runs.

- **The list.** `GET /api/autopilot/runs/history` (`ListAutopilotRunsQuery`, `AutopilotRunPage` in
  `packages/contracts/src/autopilotRunHistory.ts`) takes `automation` (a key or `all`) and optionally `projectId`,
  `since` (included) and `until` (excluded) as ISO times on `created_at`, `q`, `cursor` and `limit` (default 50,
  at most 100). `q` is a case-insensitive text search over the run id, its project's title, its summary, the
  summary and handover of a scheduled agent's answer and, for a query that is just `#N`, the task with that number
  (`%` and `_` are taken literally). A bad time, cursor or limit is a `VALIDATION` error. The old
  `GET /api/autopilot/runs` is unchanged for its callers.
- **Paging.** Keyset, on (`created_at`, `id`) newest first, so runs made while someone scrolls never shift a page.
  `nextCursor` is an opaque base64url of the last row's pair, null on the last page. Migration 034 indexes
  (`automation`, `created_at`, `id`). The page uses an infinite query (`useAutopilotRunHistory`) loading the next page
  as the end of the list comes into view. `autopilot.changed` refetches it, and a refetch takes each cursor from the page
  before it, so a new run moves the pages along instead of dropping a run between two.
- **Filters in the URL.** Search params `project`, `range` (`24h`, `7d`, `30d` or `custom`), `since` and `until`
  (local calendar days, both included, only with `custom`) and `q` (`RunHistorySearch`, `runHistoryFilter` in
  `runHistory.logic.ts`), so a filtered page can be linked to. A preset counts from when it was chosen.
- **Deleting, by hand only.** Nothing deletes runs by itself: there is no retention setting and no sweep. The page
  can delete the ticked runs, or every run the filters match (**Delete all matching…**, which with no filter is the
  automation's whole history, so with a time range it clears, say, everything before a date).
  `POST /api/autopilot/runs/delete` takes `{ ids }` (at most 500, `RUN_DELETE_IDS_MAX`; the page stops ticking there) or `{ filter }` (the same filter as the list, without paging) and
  `preview`. A preview counts and deletes nothing, which is what the confirm dialog shows before it asks; a real delete
  weighs the runs again and removes them in one transaction, then publishes `autopilot.changed`. The reply is
  `{ preview, deleted, kept, keptReasons }`. Runs aren't in backups ([backup.md](backup.md)), so there is no way back,
  and the dialog says so.
- **What is always kept.** Runs are more than history: the engine reads them. A delete leaves a run alone, with the
  first of these as the reason, when it is: **queued or running**; one whose **worktree is still on disk** (the
  worktree cleanup finds worktrees through the row); **on a task that isn't done or archived**, since dedupe keys
  (`hasRun`), Review PRs rounds, Fix PRs attempts, Merge into epic branch tries and the attention flag read the task's
  runs; a **custom or Auto-archive run on a task** (their dedupe keys follow the task's own state, so without the run Auto-archive would archive a task someone unarchived, and a custom trigger that still holds would fire again); the **latest succeeded answer of a scheduled agent** in its project (`lastScheduledAnswer`, what the next run is
  handed); or **less than a day old** (`RUN_DELETE_MIN_AGE_MS`), so deleting a just-finished run can't free a slot's
  dedupe key (Orchestrate would run the slot again) or make a notice repeat. The other automations are safe without their old runs: Recurring tasks has its cursor, the Digest and Start planned follow state that has moved on, and Review PRs, Fix PRs and Merge into epic branch key on a PR head or sit on tasks that are open while it matters. Everything else, including every older run
  of a Done task, can go. `keptReasons` has each reason with its count (`KEPT_REASON_TEXT`).

### Needs attention

A flagged run puts an `autopilot` attention reason on its task, with the run's error. It isn't cleared by a
write: `autopilotRuns.attentionFor` stops reporting it once the task changes status after the run, or a later
real run of the same automation on the task succeeds.

**Dismissing.** The user can also lift a flag they have dealt with, with **Dismiss** in the Autopilot section of the
task panel (a notice with the flag's message, shown while the task carries the `autopilot` reason; `dismissableRun` in
`autopilot.logic.ts`) or `POST /api/autopilot/runs/:id/dismiss` (`AutopilotService.dismiss`). Unlike retry it redoes
nothing: the run stays as it was (`failed` or `skipped`, `needs_attention` still 1, dedupe key kept, so the engine
doesn't act on it again) and only gets `dismissed_at` (migration 032). `attentionFor` and `latestFlaggedAt` skip runs
with it set. The service dismisses every flagged run of the task, so an older flag doesn't surface in the dismissed
one's place; a run flagged afterwards raises the flag again. It refuses a run that isn't flagged or whose flag no
longer stands (`CONFLICT`), does nothing for one already dismissed, logs an `autopilot_run` entry with status `dismissed` under the user's actor, and publishes
`autopilot.changed` and the task so open boards refresh. REST only, no MCP tool: it is the user saying they dealt with it.
Backups leave runs out, so the column is not in the dump.

"After" is decided by stored times, so a status change never ties with a flag: `statusChangeTime` in
`services/tasks.ts` stores a time a millisecond past the task's latest flagged run when the move would otherwise
land in the same millisecond. A flag raised after a move stands, except in the rare case the move had to step
past an earlier flag in that very millisecond.

### The per-task flag

`tasks.autopilot` is a nullable integer like `auto_review`: null is **Default**, 1 is **On** and 0 is **Off**.
Default never auto-starts a task; only On does, so an automation that starts work (Start planned tasks) checks
for `task.autopilot === true` on top of its scope being on. The flag does nothing by itself.

- The user sets it in the task panel's Automation section. Agents set it with `autopilot: "default" | "on" | "off"`
  on `update_task`, `create_task` and `add_to_backlog`, and only after the user has said so. A change is logged
  as an `updated` activity entry naming `autopilot`.
- After `set_plan` or `create_task`, when Start planned tasks resolves On for the task (its epic, project or the board)
  and the flag is Default, the result says **Autopilot flag not set** and tells the agent to ask the user (`autopilotFlagHint`).
  Without the automation switched on there is nothing to opt into, so there's no hint.
- Backups carry the column (the dump is `SELECT *` and the restore inserts by column name); a dump from before
  the column restores with every task at Default.
- Agents can flag tasks but still can't change any Autopilot setting.

### Manual tasks

A manual task (`task.manual`, see [task-lifecycle.md](task-lifecycle.md#manual-tasks)) is for a person, so the
automations that act on tasks pass it over: Start planned tasks (`notStartable`; `workingAgents` still counts a
thread that is working on a task turned manual mid-run, since nothing stops that agent), Remind me about stuck tasks, Review PRs, Fix PRs, and Orchestrate (`orchestrateNeedsLooking` ignores it, and
its prompt tells the agent to leave manual tasks alone). Unblock dependents still fires when a manual blocker
finishes, since the task it unblocks is code; Auto-archive still tidies it away once Done.

### API

REST only, for the UI. There is no MCP tool, so agents can't switch Autopilot on, lift its limits or unpause it. The
one exception is `retry_autopilot_run`, which only frees a run's work for the engine to judge again.

| Route                                           | Does                                                   |
| ----------------------------------------------- | ------------------------------------------------------ |
| `GET /api/autopilot`                            | Pause, engine settings and the catalogue (with each automation's field descriptors and defaults) |
| `PATCH /api/autopilot/engine`                   | Updates engine settings; `quietHours` may be partial   |
| `POST /api/autopilot/pause`, `/resume`          | Pause all, and back                                    |
| `GET /api/autopilot/board`, `/projects/:id`, `/projects/:id/epics/:epicId` | Each automation at that scope: its own mode and config, and what it resolves to (an epic's through its project and the board) |
| `PUT /api/autopilot/board/:automation`, `/projects/:id/:automation`, `/projects/:id/epics/:epicId/:automation` | Sets mode and/or config; Inherit with no config removes the row |
| `GET /api/autopilot/runs?taskId=` or `?projectId=` | Runs, newest first (`limit`, default 50)            |
| `GET /api/autopilot/runs/history`               | One automation's runs (or `automation=all`), filtered, a page at a time (see [Run history](#run-history)) |
| `POST /api/autopilot/runs/delete`               | Deletes runs by hand, or with `preview` counts what would go (see [Run history](#run-history)) |
| `POST /api/autopilot/runs/:id/retry`            | Retries a failed or skipped run (see [A pass](#a-pass)) |
| `POST /api/autopilot/runs/:id/dismiss`          | Dismisses a flagged run's attention flag (see [Needs attention](#needs-attention)) |
| `GET /api/autopilot/orchestrate/:projectId`     | Orchestrate in one project: next slot, what holds it, Run now, the latest run |
| `POST /api/autopilot/orchestrate/:projectId/run` | Orchestrate's Run now (202), or 409 with why it can't start |

### Automations

**Auto-archive Done** (`auto_archive`, #91; `automations/autoArchive.ts`). Needs no agent and is off until switched
on. Archives (never deletes) a task that has been in Done for more than `days` days (default 14, minimum 1, set
per scope), logged as `archived` plus the note "Archived by Autopilot after N days in Done" under the actor
`autopilot`. It skips tasks in an epic (archiving them one by one would leave the epic with none counted and send it
back to Backlog), except Done tasks whose epic is already archived, which count as loose (epics archived before
they took their Done tasks along left those behind), and tasks with an open, draft or not-yet-polled PR. The dedupe key is
`archive:<taskId>:<statusChangedAt>`, so a manual unarchive sticks until the task leaves Done and comes back.

A **finished epic** is archived with its tasks instead: an epic that isn't archived, is in Done (so every unarchived
task is Done, closed or not), has been there for more than `days` days (its `statusChangedAt`) and has no open, draft
or not-yet-polled PR on it or on any of those tasks. The setting is resolved on the epic (epic, then project, then
board; `epicScope: true`, so the epic's popover offers it, with its own days), and an epic that is switched on
archives even while its project is off. The action is `tasks.archiveFinishedEpic`: one write that archives each
unarchived task and then the epic, as `autopilot`, without re-deriving the epic's status in between (going through
`update` would drop it to Backlog when the last task leaves its roll-up). It logs `archived` on each and the note
"Archived by Autopilot with its N tasks after D days in Done" on the epic. Tasks already archived stay as they were.
The dedupe key is `archive-epic:<epicId>:<statusChangedAt>`, so unarchiving the epic by hand sticks until it leaves
Done and comes back. The engine resolves a candidate that is an epic on the epic itself; a dry run says "Would
archive #N with its K tasks after D days in Done". Unarchiving such a task, or reopening it, unarchives its epic
([epics.md](epics.md#joining-and-leaving)).

**Unblock dependents** (`unblock_dependents`, #92; `automations/unblockDependents.ts`). Needs no agent and is off until
switched on, with no settings. When the last unfinished blocker of a task reaches Done (or is closed as completed or
duplicate), it logs a note "Unblocked: #N finished" on the dependent and sends an `autopilot_notice` notification.
A partially unblocked dependent waits. It starts nothing: a flagged Planned dependent just becomes eligible for Start
planned tasks on the next tick. It only reports blockers that finished in the last 24 hours, so switching it on doesn't announce old work. The scope is the dependent's project. The dedupe key is
`unblock:<dependentId>:<latest blocker statusChangedAt>`, so reopening a blocker and finishing it again notifies
again, while two blockers finishing together give one notification.

**Remind me about stuck tasks** (`unstick`, #88; `automations/unstick.ts`; first called "Unstick stale tasks", and
the key stayed). Needs no agent and is off until switched on. It is a reminder to the user and acts on nothing:
getting stalled work moving again is Orchestrate's job (below). It is still worth having beside it, because
Orchestrate leaves a task that is waiting on the user alone, and a thread stuck waiting holds a concurrency slot
for Start planned tasks. It is also the free option for someone who doesn't run Orchestrate (no agent, no caps, no
quiet hours). Watches tasks In Progress for two things, each reported once:

- **Quiet**: no activity for `staleHours` (default 24). Activity is any activity entry not written by `autopilot`
  (its own notes and run entries don't count), or the move into In Progress. Puts "Stale: no activity for 26h" under
  Needs attention, which clears on the next activity by anyone else (or when the task changes status). The dedupe
  key is `stale:<taskId>:<lastActivityAt>`.
- **Waiting**: the task's latest T3 thread has waited on input or approval for `waitingMinutes` (default 30), by
  the snapshot's `lastActivityAt`. The thread already shows its own Needs attention reason, so only the run and the
  notification are added. The dedupe key is `waiting:<threadLinkId>:<lastActivityAt>`.

Either way it logs a note under `autopilot` and sends an `autopilot_notice`. It used to be able to post a nudge into
the thread (`nudge`, `nudgeMessage`); that went to Orchestrate. A row that still holds those keys is not an error:
`setScope` ignores stored keys the automation no longer declares and drops them on the next save, so the forms,
which send a scope's whole config back, keep working. A key that was never stored is still a `VALIDATION` error.

**Recurring tasks** (`recurring`, #89; `automations/recurring.ts`). Needs no agent and is off until switched on
per project. Makes a task from a template on a schedule; the rules are rows in `autopilot_recurring` (below), and
this automation's own switch decides whether a project's rules run. It has no config of its own.

- A rule has a name, a template (board-wide or the project's, with a title pattern), a schedule, whether its tasks
  carry the Autopilot flag (On), and an enabled switch. The schedule is `weekly` (weekdays and a time) or `every`
  (N days from a start date, at a time), in the server's local time (`nextDue` and `latestDue` in
  `packages/contracts/src/recurring.ts`). Slots are found by calendar day, so a DST change never shifts them: a
  time the clock skips runs an hour later, a repeated one runs the first time.
- `check` returns, per enabled rule, the latest slot after the rule's cursor `last_due_at` that is due. Only the
  latest: after downtime of the board there is one catch-up task, not one per missed slot. The dedupe key is
  `recurring:<ruleId>:<slot>`. The cursor and the key hold the slot as a local wall-clock stamp
  (`2026-10-12T09:00:00`, `localStamp`), not an instant, so a machine that moves to another time zone doesn't see a
  handled slot as new.
- `act` creates the task through `services.tasks.create` with the template: Planned when the template has a plan,
  Backlog otherwise, flagged On when the rule says so, under the actor `autopilot`, then adds the note "Created by
  Autopilot from recurring rule <name>". The title and description render `{{date}}` and `{{project}}` as of when the
  task is made, so a catch-up task carries the day it was made, not the day of the slot it stands for.
- It skips (the run is `skipped`, with the reason) while the task the rule made last is still open: not Done
  (closed tasks are Done) and not archived. A deleted template fails the run with "pick another one".
- Whatever the outcome, `act` moves the cursor to the slot (`recurring.handled`), so the next pass looks for the
  slot after it, and never moves it back. The cursor is also what stops a duplicate when runs are gone (a restore
  doesn't bring runs back). Dry-run records "Would …" and leaves the cursor, so turning it off makes the task.
- A rule's cursor starts at its creation time, and is set again when the rule is switched on or its schedule
  changes, so slots from before that aren't caught up. The same goes for the automation: when its switch turns on
  for a project (its own, or the board's), or Pause all is lifted, `AutopilotService` calls `onEnabled` and the
  project's rules restart from now (`recurring.restart`). Only downtime of the board itself catches up.
- Rules are managed in the project's settings (**Recurring tasks**, `components/recurring/`), which also offers
  example rules: adding one creates a template for the project (reusing one of the same name) and the rule.
  The automation's own switch is the project's Autopilot section like any other; the lane pill's popover links to
  these settings with an icon button beside Recurring tasks (`useOpenSettings()("project.recurring", { project })`), scrolled to the section.

#### Recurring rules API

REST only, like the rest of Autopilot:

| Route                                    | Does                                                           |
| ---------------------------------------- | -------------------------------------------------------------- |
| `GET /api/projects/:id/recurring`        | The project's rules, each with `nextDueAt`                     |
| `POST /api/projects/:id/recurring`       | Creates one (`name`, `templateId`, `schedule`, `flagAutopilot`, `enabled`); 409 on a name the project has |
| `PATCH /api/recurring/:id`               | Edits it                                                       |
| `DELETE /api/recurring/:id`              | Deletes it; tasks it made stay                                 |

Every change publishes `autopilot.changed`, which the web app uses to refetch the rules.

**Review PRs** (`review_prs`, #95; `automations/reviewPrs.ts`, contract in `packages/contracts/src/prReview.ts`).
Needs an agent and is off until switched on. Reviews a pull request linked to a task and posts the review on GitHub,
as comments only.

- **Trigger.** A `pr` link whose snapshot (from the `gh` poller) is open, or draft when **Review drafts** is on
  (off by default), and has a `headOid` and `headRef`. Merged and closed PRs, PRs from forks (`isCrossRepository`:
  the branch isn't on `origin`), Done and archived tasks, epics and links with no snapshot yet are skipped. The
  dedupe key is `review:pr:<linkId>:<headOid>`: one review per PR and head commit, and a push gives a new one.
- **After the local review.** A task in Review whose [local review](local-review.md) is still going (`reviewIsInProgress`:
  a round pending, running or stalled, or, with auto-review on for the task, blocking or major findings open with
  rounds left) isn't reviewed yet. An
  agent that links its PR just before moving to Review would otherwise get it reviewed on GitHub while the loop is
  still changing the code. Once the loop ends (clean, or the round limit, stuck included) the PR's current head is
  reviewed as usual; a failed round isn't waited on, and tasks without local review are never held back.
- **One at a time, and rounds.** While a review of the PR is queued or running, a new head commit waits; the next
  pass reviews the latest head with the earlier review in view. A PR gets at most `prReviewRounds` reviews (engine
  setting, default 3): the rounds used are its real review runs, a failed one included and a skipped one (which
  posted nothing) not. Once they are used up, a new head commit isn't reviewed. The fix automation (Fix PRs) counts its
  own attempts against the same limit; each fix is followed by at most one new head and so one review.
- **The agent only reads, and only its worktree.** It runs headless in a worktree on the PR's branch with
  `access: "read-only"` and an output schema. It has no way to write to GitHub. Because it reads text anyone can
  write (the PR's description and comments), the request sets `untrustedInput`, which gives it the least it needs:
  - no board tools and no other MCP servers (`--strict-mcp-config`), and `--setting-sources user`, so the branch's
    own `.claude/settings.json` (allow rules, hooks) never applies. The user's own settings stay, because some carry
    the login; `--tools Read,Grep,Glob,Bash` keeps a global allow rule of theirs (WebFetch and the like) from
    finding a tool, but a broad `Bash` allow rule of theirs would still widen what the reviewer may run;
  - file tools scoped to the worktree (`Read(./**)` and so on; a bare `Read` reaches any file the user can);
  - git in three exact commands only (`rev-parse HEAD`, `status --short`, `log --oneline -20`), because `git diff`,
    `show` and `log` take any path, so read any file (a path outside the work tree makes `diff` compare files) and
    write any file (`--output=`);
  - `gh` in exact commands only: `gh pr view <url>` (also with `--comments`), `gh pr diff <url>` (also with `--name-only`, for a diff too long for
    one command output) and two reads of
    the PR's comments and reviews with `gh api`. The PR is named by its URL, so there is no `-R` to point it at
    another repository, and no wildcard for `--web`, `-f` or `--method` to ride on.

  Before the agent starts the runner checks the worktree is at the commit the run is about (`expectHead`,
  `WorktreeHeadError`) and, when it isn't, removes the worktree and its branch (the run records neither). A branch
  that moved past the commit skips the run. So does a rewritten branch (a force-push) once `GithubActions.prHead`
  says GitHub's head is no longer that commit; if GitHub still says it is, the checkout is what's wrong (a stale
  `origin`, a fork's branch name that exists on `origin`, a PR in another repository) and the run fails, flagged,
  before any budget is spent. A read-only run may read the default branch (a PR from `main`), since it can't push.
  A review has to be held to read-only, which a T3 thread can't be, so the runner setting is Auto or Headless and
  both run headless. It has its own budget (default $2) and timeout (20 minutes), and follows the **Review skill**
  chosen (the built-in `aboard-review` by default; a skill on disk is inlined into the prompt). The prompt calls the
  PR's text untrusted, and says nothing is recorded on the board.
- **The server posts.** The agent answers with a summary and every point (severity, file, line, body, suggestion,
  `fyi`). `renderReview` builds one review from it: the summary under `📋 <displayName> Autopilot review`
  (`prReviewHeader`, from `BRAND`), points with no place in the diff and the FYI ones in the body, and the rest as
  inline comments starting with `📋 <displayName> Autopilot · <severity>`. `GithubIntegration.postReview` sends it
  with the `gh` token as a GraphQL `addPullRequestReview` with `event: COMMENT`: it can never approve or request
  changes, and it comes from the user's own `gh` login. It first reads the PR's live head and refuses with
  `StaleReviewError` when that isn't the commit that was reviewed (a push while the agent worked): nothing is posted,
  the run is skipped, and the new head is reviewed next as the same round. GitHub refuses a whole review over one
  comment on a line outside the diff, so it then posts again with the inline comments in the body; a body is cut to
  what GitHub takes. GitHub can also create the review and answer with an error ("An internal error occurred, please
  try again"): after such a transient error `postReview` first reads the account's own reviews on the PR
  (`findPostedReview`) and, when one at that head starts with `prReviewHeader`, counts it as posted instead of failing
  or posting twice. The inline fallback runs only for a refusal that isn't transient. Its errors are prefixed "GitHub
  couldn't post the review: …", so a card doesn't read like an Aboard or Claude failure. The agent doesn't post
  itself because Claude Code's permission rules can't scope `gh api` writes to a review (and can't see an `event`
  inside a heredoc), it refuses a JSON payload in a heredoc, and `gh api -f` can't build the inline comments reliably.
- **Verdict.** The board counts the non-FYI points by severity; those at or above the **fix threshold** (engine
  setting, default major) are the actionable ones.
- **Anti-spiral.** From round 2 the prompt carries the round ("round 2 of 3"), the earlier Autopilot reviews with
  their URLs and counts, and the rules: look for regressions and earlier points still unfixed, don't raise again
  what was fixed or declined with a reason, and mark new minors and nits `fyi` (they go in an "FYI (no action
  needed)" section). On the last allowed round the bar is raised to at least major (`effectiveFixThreshold`: minor
  and nit become major; blocking stays) and the prompt says no round follows.
- **What the board keeps.** The task gets a note "Autopilot reviewed PR #N at `<sha>` (round R of M): review on
  GitHub", linking the review, and the run gets its verdict in `output` (`PrReviewRunOutput`: review URL and id, the
  head commit in full, round, counts, FYI count, threshold, actionable count and `handoff`). An answer that isn't a
  review fails the run, flagged, and nothing is posted; a review GitHub refuses fails it too, and so does an agent
  that failed (its text is the run's error: for an API error, such as a 403, `claudeFailure` says that text
  rather than only the subtype). GitHub failing in passing (`isTransientGithubError`: "try again", "internal error",
  `HTTP 5xx`, a timeout or the network) while posting ends the run `skipped` ("will retry"), not a round used, with
  `output.retry`; each try is a full review, as the agent runs again. The next pass reviews the same head again under the key `review:pr:<linkId>:<headOid>:<n>`, up to
  `REVIEW_ATTEMPTS` (3) tries, after which it fails, flagged. Any other failed run is never retried, so there is one
  review per head commit even when posting failed.
- **Hand-off.** `handoff` says what comes next: `clean` (nothing at or above the bar: the loop ends), `fix`
  (something is, with rounds left) or `gave_up` (something is, on the last round: the run ends flagged "Autopilot
  gave up…", which shows under Needs attention and sends an `autopilot_failed` notification). The fix automation
  reads `currentPrReview(runs, linkId, snapshot.headOid)`: the newest finished review of the link, and only while
  its `headOid` is the PR's current head, so a superseded or stale verdict is never acted on. The review ids on the
  runs are how it tells Autopilot's own reviews from other people's.
- **Limits.** Switching the automation on reviews every open PR already linked in the project, once per head
  commit; dry run shows which first.

**Fix PRs** (`fix_prs`, #96; `automations/fixPrs.ts`). Needs an agent and is off until switched on. Sends an agent
to fix a pull request linked to a task.

- **Triggers**, each with its own switch (all on by default), read from the `gh` poller's snapshot of an open or
  draft PR with a `headOid` and `headRef` (merged and closed PRs, forks, Done and archived tasks and epics are
  skipped). Each has a key that fires once:
  - failing checks: `checks@<headOid>`;
  - merge conflicts: `conflict@<headOid>`;
  - changes requested: while `reviewDecision` is `changes_requested`, the newest `changes_requested` review from a
    `trusted` author that isn't Autopilot's: `changes@<reviewId>`. The user's own counts: Autopilot only comments;
  - review comments: comments on unresolved threads that aren't `own`, are `trusted`, aren't in one of Autopilot's
    reviews, and are newer than the newest comment an earlier attempt was given: `comments@<newestId>`. Autopilot
    posts as the user, and the poller doesn't read bodies, so the user's own comments can't be told from its
    replies and never count;
  - Autopilot's review: `currentPrReview(...)` with `handoff: "fix"`: `review@<reviewId>`.

  Autopilot's own reviews are told apart by the `reviewId`s on Review PRs' runs.
- **Batching and dedupe.** One candidate per PR link carries every trigger that hasn't fired yet, with the key
  `fix:pr:<linkId>:<headOid>:<trigger keys joined by +>`. Earlier attempts' triggers are read back from their keys
  (`parseFixKey`), so a failed attempt, which leaves no output, still counts what it was given; a skipped one didn't
  act and counts nothing. Triggers still holding from an earlier attempt are listed in the prompt for context. While
  a fix or a review of the PR is queued or running, the PR waits. So it does while an attempt
  handed to a T3 thread (a nudge, or a new thread) is still working on it (`t3RunWorking` in `packages/contracts/src/runThreads.ts`,
  shared with Start planned): those runs end as soon as the message is sent, so without this, comments arriving
  while the agent works would use up the attempts and give up before it pushed.
- **Action.** When the task's latest T3 thread is there, not settled, and seen by the live poll in the last ten
  minutes (so T3 Code is up to take it), and the runner isn't set to headless, the fix prompt is a nudge into it.
  Otherwise the runner starts a session (T3 or headless, from the runner setting) with `workspace: { branch:
  headRef }` and `expectHead`: a branch that moved on skips the run, and one at an unrelated commit fails unless
  `prHead` says the PR moved (a force-push). The prompt has a section per trigger with the `gh` commands to read
  it. For Autopilot's review it gives the counts and the review's `threshold` and says to fix only points at or
  above it and leave the FYI section alone. Comments are named by id (`gh api repos/<repo>/pulls/comments/<id>`),
  and the agent is told to read only the reviews and comments listed. The agent pushes to `headRef` and replies on the threads it addressed,
  each reply starting with `prReviewMarker()`. The reply goes in a file posted with `gh api … -F body=@file`,
  because the `gh api *merge*` deny rule would refuse a command line that mentions merging. A custom **Fix skill**
  is inlined into the prompt. The run's `output` is `{ kind: "pr_fix", linkId, headOid, round, attempt, triggers,
  via: "nudge" | "t3" | "headless" }`.
- **By hand.** The PR row's **Fix in →** starts the same kind of fix for the user ([GitHub PRs](github-prs.md#fixing-a-pr-by-hand)),
  with `manualFix`'s prompt, and the row shows this automation's state (running, gave up) in its action slot while it is on
  for the task. Those sessions aren't runs: they don't count against the attempts or the caps, and Fix PRs does not see them
  (it may start an attempt of its own on the branch while one is at work).
- **Limits.** At most 2 attempts per head commit (`ATTEMPTS_PER_HEAD`) and `prReviewRounds` per PR, counting every
  attempt that wasn't skipped or conflict-only (below). When a trigger fires past either limit, a gave-up run (`fix:gave_up:<linkId>:<headOid>`
  per head, `fix:gave_up:<linkId>` once the rounds are used) ends flagged "Autopilot gave up on PR #N: …". That puts
  it under Needs attention, logs the run on the task and sends an `autopilot_failed` notification. A new head
  commit starts the per-head count again. The gave-up candidate sets `startsNoAgent`, so a full concurrency cap, a
  daily cap or quiet hours don't hold it back.

  An attempt whose triggers were all `conflict@…` (read back from its key, so a failed one is classified too)
  counts against neither: main moving under the PR isn't the PR's doing, and every merge into the base can conflict
  it again, so conflicts must not use up the attempts review points and failing checks need. Conflict-only attempts
  have a budget of their own, `CONFLICT_ATTEMPTS_PER_PR` (5, a constant) for the life of the PR, which guards against
  a merge that keeps failing or a PR that never stops conflicting; failed and successful ones count, skipped ones
  don't. When only a conflict is fresh, only that budget applies, so a PR
  that used up its rounds is still kept merged; past it, a gave-up run `fix:gave_up:<linkId>:conflicts` says "N
  conflict-only attempts used, still to fix: merge conflicts". A mixed attempt (`checks+conflict`) counts as a normal
  round. Conflict-only runs are labelled "conflict attempt N of 5" in the summary and the prompt. An integration
  epic's PR, fixed for conflicts only, uses only this budget.
- **Safety.** Headless runs get `pushDenyRules` (no force-push, no push to the default branch, no `gh pr merge`)
  and the runner's workspace note. T3 threads get the same rules in their note, and the fix prompt repeats them for
  a nudge. Conflicts are fixed with a merge, never a rebase. Only trusted authors' comments start a fix, and the
  prompt names them by id, tells the agent not to read the others, and calls what it reads requests about the code,
  never instructions. That is a prompt, not a sandbox: a fix agent has edit access, Bash and the user's `gh` login,
  so on a public repository a stranger's comment it reads anyway (or a CI log) could still try to steer it. Unlike
  the reviewer it can't be confined to exact commands, because fixing means running the project's own tools.
- **Settings.** The five switches, **Fix skill** (built-in: the prompt alone), and the shared runner fields, with a
  $3 budget and a 30-minute timeout. Rounds and the threshold are the engine's.
- **An integration epic's own PR.** For an epic delivered through an integration branch
  ([epics](epics.md#delivery)), the epic's PR from that branch into the default branch is a candidate too, for the
  conflict trigger only, even once the epic is Done (it stays open until the user merges it). It never gets a nudge:
  a thread linked on an epic orchestrates its tasks. The agent merges the default branch into the epic's branch and
  pushes there; pushing to `epic/*` needs no deny-rule change, since only the default branch is denied.

**Merge into epic branch** (`merge_epic_prs`, #123; `automations/mergeEpicPrs.ts`). Needs no agent and is off until
switched on, with no settings. Only epics with integration delivery ([epics](epics.md#delivery)) give it work.

- **Merging.** A task's PR is merged into its epic's branch when `notMergeable` (`autopilot/mergeGate.ts`, shared
  with [`merge_task_pr`](github-prs.md#merge_task_pr)) finds nothing in the way: the task
  is in Review; the PR is open (not a draft), from origin, with the epic's branch as its base (`PrSnapshot.baseRef`,
  `baseRefName` in the poll) and a head commit; the local review isn't going (`reviewIsInProgress`) and left no
  blocking or major finding open; no Review PRs or Fix PRs run of the task is queued or running; when Review PRs is
  on for the task, its review of the current head (`currentPrReview`) has nothing actionable; no reviewer requested
  changes on GitHub; checks pass, or none has reported for `NO_CHECKS_WAIT_MS` (10 minutes) since the board first saw
  the head (`PrChanges.newHead`, else the link's creation: GitHub reports no checks for a moment after a push); and
  GitHub says it merges cleanly and isn't blocked on a check or rule (only a missing review is left to GitHub). The dedupe key is `merge:<linkId>:<headOid>`. The action re-checks all
  of it, then calls `GithubIntegration.mergeIntoEpicBranch`: a fresh read of the PR and the repository's default
  branch, `checkAutopilotMergeTarget` (refuses the default branch, a base that isn't an `epic/` branch, and a PR
  retargeted since the check, with `MergeTargetError`), and `mergePullRequest` with `MERGE` and `expectedHeadOid`.
  The refreshed snapshot says merged, which moves the task to Done (`completeIfPrsDone`), so Unblock dependents
  notifies and Start planned starts what waited on it, from the updated branch.
- **Refused.** A failure another try may get past (another PR merged into the branch first, a push, GitHub still
  computing mergeability, the network) ends the run skipped with `output.retry`, and the next pass tries the same
  head again under `merge:<linkId>:<headOid>:<n>`, up to `MERGE_ATTEMPTS` (3). Anything else, such as branch rules
  wanting an approval, or the last try failing, ends it skipped with `needsAttention` and "Ready to merge into the
  epic branch: … Merge it yourself." as the task's attention reason, and the engine notifies. A `MergeTargetError`
  fails the run, flagged.
- **The epic's PR.** Once a task PR has merged into the branch and the epic has no PR from it, it opens a draft PR
  from the branch into the default branch (`ensureEpicPr`: an open one already there is used instead) and links it
  on the epic (`epic-pr:<epicId>:<branch>:<task PRs merged>`, so a failed attempt is tried again after the next
  merge). Then it keeps the PR's description, `epicPrBody` (each task with
  its state, its PRs into the branch, its latest Autopilot review counts and its local review), current: the key
  `epic-pr-body:<linkId>:<hash of the body>` changes exactly when the body does, so nothing in it is a time. A closed
  epic PR is left alone. Nothing in Autopilot merges it.

**Orchestrate** (`orchestrate`, #138; `automations/orchestrate.ts`). Needs an agent and is off until switched on.
The built-in version of the T3 Code "babysitter" threads: a scheduled agent per project that keeps its work moving.

- **When.** Every `everyMinutes` (default 30, 5 to 1440) from local midnight (`latestMinutesSlot`), per project it's
  on in (`epicScope: false`: it has no task). Only the latest slot counts, so downtime catches up once, and switching it
  on runs the current slot at once. The dedupe key is `orchestrate:<projectId>:<local slot stamp>`. A project with
  nothing to look at gets no run: it needs an unarchived task In Progress, in Review flagged for auto-merge, or under
  Needs attention (a failed Start planned run included), leaving out tasks waiting on the user (an `agent_request` or
  a thread asking for input). So an idle project, or one whose work all waits on the user, costs nothing. One run at a time per project: while one is queued or
  running, `check` returns nothing for it and the latest slot runs once it ends. The rule is
  `orchestrateNeedsLooking` in contracts, so the board's lane pill reads it the same way. `nextMinutesSlot` gives the
  next slot (local midnight when the step doesn't fit in what is left of the day; it steps past wall times a DST change
  repeats).
- **Run now.** The first run-now path in Autopilot. `POST /api/autopilot/orchestrate/:projectId/run`
  (`requestOrchestrateRun`) puts a request for the project in `AutopilotService.requestRun`, an in-memory map (a
  restart drops it), publishes `autopilot.changed` and starts a pass at once (`Integrations.autopilotPass`, when the
  pollers run). `check` turns the request into a candidate keyed `orchestrate:<projectId>:manual:<requested at>` that
  skips the nothing-to-look-at gate, since the user asked; the first pass that finds the key has a run clears it. A
  slot that began before a manual run in it doesn't run again (`ranManuallySince`), so Run now doesn't double the
  next look. One run at a time still holds, and so do the engine's limits: the request is refused (`CONFLICT`, with the
  reason) when Orchestrate is off in the project, Autopilot is paused, a run is already going there, in quiet hours or
  at a daily cap (checked apart from concurrency, so a full run slot doesn't hide it); at the concurrency cap it waits
  for a free slot like any candidate. Asking again while one waits keeps the first. A request is dropped when
  Orchestrate goes off in the project, and after an hour without a run (`RUN_REQUEST_TTL_MS`), so it never starts out
  of the blue later.
- **State.** `GET /api/autopilot/orchestrate/:projectId` (`orchestrateState`, `OrchestrateState`) gives the switch,
  `everyMinutes`, `nextSlotAt`, `hold` (why that slot won't run, the first that applies: `off`, `paused`,
  `quiet_hours` at the slot, `daily_cap`, `idle`), `running`, `requestedAt` and `lastRun` (the latest real run,
  retried ones left out). Its section of the lane popover reads it (see
  [board-layout.md](board-layout.md#autopilot-on-the-board)). The quiet-hours and cap checks are the engine's
  (`agentHold` in `autopilot/limits.ts`).
- **The run.** Task-less and headless (`startDetached`: an empty temporary folder, `repo` for the default branch's
  push guard), with `access: "read-only"` and `untrustedInput`, since it reads PR and CI text anyone can write: file
  tools only in its own folder, no settings from a checkout (`--setting-sources user`), only the built-in tools it
  needs (`--tools Read,Grep,Glob,Bash`, so a global WebFetch allow rule finds no tool) and no MCP server but this
  board's. `boardTools` makes the runner write an MCP config naming only the board (`boardMcpConfig`, with its API
  token, in a temporary folder of its own outside the run's, removed afterwards) and pass it with
  `--strict-mcp-config --mcp-config`. On top of that, the `gh` reads in `ORCHESTRATE_TOOLS` (`gh pr view|checks|list|diff`, `gh run list|view`, and `gh run rerun` for a flaky CI
  job). The rules match each command, and a compound one is refused if any part isn't allowed, so the prompt tells it to run each `gh` command on its own (no loops, pipes or `&&`) and that a refusal is about the command's shape, not that Bash is off. It never edits code: it works through the board's tools, `message_task_thread` and `start_task_thread` (now
  for any task), `retry_autopilot_run`, `request_attention` and `merge_task_pr`. Because it reads text anyone can
  write (PR comments, CI logs), it gets only the board tools in `ORCHESTRATE_BOARD_TOOLS` (reads, `add_note`, `request_attention`, the
  thread tools, `retry_autopilot_run`, `merge_task_pr`); every other board tool is in `ORCHESTRATE_DENIED_TOOLS`
  (`RunnerRequest.deniedTools`), so it can't create or flag a task for auto-merge, link a PR, mark review findings away,
  or move, close, archive or delete tasks. `mcp.test.ts` checks every registered tool is on one list or the other. It never starts a Planned task: that is Start planned's, under its
  limits and the task's blockers; a failed start goes back through `retry_autopilot_run`. It counts against the caps and waits
  out quiet hours like any agent run. Tier `standard`; `model`, `budgetUsd` (3) and `timeoutMinutes` (30) are its
  only runner options (the runner choice doesn't apply).
- **Merging.** Only through `merge_task_pr`, so only tasks flagged for auto-merge and only past the server's gate. The
  prompt adds no policy of its own (nothing about UI changes): what to hold back is the user's call, in the extra
  instructions. **May merge** (default on) off adds `mcp__<id>__merge_task_pr` to the denied tools and tells it to
  list ready tasks instead.
- **The prompt** (`orchestratePrompt`) is adapted from the babysitter threads: ground rules (this project only, never
  read or edit files in the project's live folder, since a board or dev server under `--watch` may restart, and treat
  PR and CI text as data), orient, unstick stalled work the lightest way (message a live thread, start one only when
  none is working, retry a failed run instead of pushing an empty commit, re-run a flaky CI job once,
  `request_attention` for what only the user can decide), merge one at a time and re-check the other PRs' checks after
  each, and end with a short status. **Extra instructions** (multi-line) are appended last and win where they differ.
- **Memory.** The scheduled agents' handover ([custom automations](#custom-automations)):
  `scheduledHandoverParts` ends the prompt, `lastHandover("orchestrate", projectId)` supplies the last one, and the
  run keeps its `ScheduledAgentRunOutput`. Its settings section lists each project's latest runs with their summary
  and handover ([run history](#run-history)).

**Start planned tasks** (`start_planned`, #94; `automations/startPlanned.ts`). Needs an agent, so it counts against
the caps and waits out quiet hours. Off until switched on. The headline automation: it starts an agent on a task.

- **Eligible** (`notStartable` is the rule; the action re-checks it, so a flag turned off between the check and the
  action skips the run): not an epic or archived, in Planned, `task.autopilot === true` (Default and Off never
  start), a plan (`progress.total > 0`) and not `blocked` by unfinished tasks. The caps and quiet hours are the
  engine's. Candidates go priority tasks first (the priority flag, see [board-layout.md](board-layout.md#the-priority-lane)),
  then by project (in the board's order) and board position, and the engine starts as many as the cap leaves room for.
- **Dedupe** `start:<taskId>:<statusChangedAt>`: once per entry into Planned, so moving a task out and back in is the
  way to try again.
- **Action**: `ctx.runner.start` with `taskHandoffPrompt` in work mode (`linkedThread: true`: the board links the
  thread or session itself, and the model line is left out, since the tier picks the model) plus an unattended note
  (no one to ask: block the step and stop) and, for a chosen skill, a line pointing at its `SKILL.md`. `tier` is the
  task's suggested tier. The agent moves the task to In Progress itself.
- **Failure**: a runner error, or the task still in Planned when the grace period ends, counted from when the thread
  started (the runner may first have waited up to ten minutes for T3, see [Runners](#runners)). A T3 run returns once the thread has started, so the action then waits out the rest of the grace period for
  the agent to move the task, unless the live poll sees its thread `failed` first: that ends the run at once ("its T3
  Code thread failed before moving #N out of Planned"; only a snapshot taken after the runner returned counts). A
  headless run returns when the agent is done, so it is checked once, at once. A runner
  error after the agent moved the task (a headless budget or timeout) reads "Autopilot's agent stopped before
  finishing" instead. The run fails with "Autopilot couldn't start this task: …" and `needsAttention`, so the task is flagged
  and the engine notifies. Nothing retries it. The flag clears itself when the task changes status
  ([Needs attention](#needs-attention)), so there is no clearing step. While the action waits out the grace period its
  run stays `running` and holds a concurrency slot.
- **The cap counts working agents.** A T3 run ends once the thread has started (so a restart strands nothing), which
  would free its slot at once. So `check` also counts `workingAgents`: tasks In Progress, In Review (the agent runs
  its review loop there) or still Planned (the thread hasn't moved them yet) whose latest Start planned run began a T3 thread (the run's `threadUrl`, whatever the run's
  outcome: one that failed at the grace period may still move the task) that is `working`, `waiting` (subagents still
  going), `input` or `approval` in its snapshot, and not settled or archived. `check` drops candidates that already
  have a run (a failed or still-starting task would otherwise use up the room of those below it) and returns only as
  many as `maxConcurrent` leaves after those and the engine's running runs. A snapshot only counts as
  evidence when it was taken after the run ended (the launch-time poll sees a thread that hasn't run yet, "idle"). A
  thread with no such snapshot, or whose snapshot the live poll stopped refreshing (T3 gone, thread deleted), counts
  for ten minutes from the run's end or the snapshot. The slot frees when
  the thread idles, finishes, fails, settles or is archived, or the task is Done, archived or back in Backlog; a thread stuck
  waiting for you holds it until you answer, and Remind me about stuck tasks flags it. A headless run is a running run, which
  the engine counts. A dry run ignores this.
- **Config**: the shared runner options plus `skill` (a `ReviewSkillRef`; built-in means the default workflow, labelled
  by the field's `builtinLabel`), `baseRef` (the worktree's start; blank is the default branch) and `graceMinutes`
  (15). A task of an integration epic ignores `baseRef`: it starts from its epic's branch (`workspace.prBase`, below)
  and its prompt says to open its PR against it.

**Digest of what changed** (`digest`, #90; `automations/digest.ts`, `autopilot/digest.ts`). Writes a board-wide summary
of what changed since the previous digest, shown in the header's Digest panel and announced in the inbox. It is a
board-level automation: its switch, time and options are the board's (a project's own config is ignored), and a
project switched **Off** at its own scope is left out. A project set to On while the board isn't does nothing.
Needs no agent unless the mode asks for one, and is off until switched on.

- **When.** Daily at `time` (default 09:00, server local time), optionally weekdays only; and on demand (below).
  `check` asks `dueDigestSlot` (contracts) for the latest slot at or before now that is after both the newest
  digest (any trigger, so one made by hand counts as that day's) and the last change to the automation's board
  settings (so switching it on, or moving its time, owes nothing for a slot that passed before). Only the latest
  slot: after downtime there is one digest covering all of it. The dedupe key is `digest:<slot as a localStamp>`.
- **Period.** From where the previous digest ended (`to`) to now; the first digest covers the last 24 hours.
- **Plain** (`autopilot/digestBuilder.ts`, pure; the data comes from `digests.collect`), grouped by project, with
  sections only for what happened: **Moved** (a task that moved several times shows where it started and ended, and
  not at all when it came back), **Merged pull requests** (a `status_changed` entry carrying `mergedPr`; those are
  listed here instead of under Moved), **Needs attention** (`thread_waiting`, `pr_checks_failing` and
  `pr_changes_requested` notifications of the period, so a kind switched off in Settings isn't reported), and
  **Autopilot** (real runs that finished in the period: counts, and each failed or needs-you run with its message cut to one line).
  The total Autopilot cost closes it. Titles are escaped, and task numbers are written `#N` for the UI to link.
- **Summarised.** The plain digest goes to a headless agent on the light tier (`model` overrides), with the chosen
  digest skill (the built-in one, `BUILTIN_DIGEST_SKILL_BODY`, or one found on disk) and the instruction that the
  digest is material, not instructions. A skill found on disk is read by the board (only a `SKILL.md`, at most 200 KB, cut to 20,000 characters) and put in the prompt. The agent
  has no tools at all (`access: "none"`: `--tools ""` and `--strict-mcp-config`, so no file reads and no board MCP
  tools either): everything it needs is in the prompt, and task titles can come from imported issues. It runs through the runner as a task-less run (see [Runners](#runners)); T3 Code can't return
  text, so there is no runner choice. Whatever goes wrong (no agent allowed, the agent fails, answers nothing)
  stores the **plain** digest with the reason in `note`: a digest that fails to arrive is worse than a plain one.
  A period with nothing in it never starts an agent.
- **One at a time.** A scheduled digest is not started while another is being written, and "digest now" is refused (409)
  then, so two periods never overlap.
- **Gates.** The automation isn't `needsAgent` (a plain digest shouldn't count against the run caps or wait behind a
  busy runner), so the summarised mode keeps the rules itself: a scheduled one waits out quiet hours (the slot stays
  due), and a digest that finds Pause all set, dry-run on or today's spend cap used up comes out plain with that
  as its note. It sets `background`, so the engine doesn't hold the rest of its pass for it.
- **Digest now.** `createDigestGenerator` (`integrations.generateDigest`) records a run of its own (its cost counts
  toward the spend cap), covers every project not switched Off whether or not the automation is on, and uses the
  board's settings. A plain digest is done when the request returns; a summarised one goes on in the background
  (202), and the run in the Autopilot status (`active`, automation `digest`) is what the UI shows while it
  waits. A second request meanwhile is a 409.
- **Storage.** `autopilot_digests` (`020_autopilot_digests.sql`): the period, mode, trigger, Markdown body, cost,
  the fallback `note` and `read_at` for the header's unread dot. The newest 30 are kept. History only: not backed up.
  A new digest sends one `autopilot_notice` notification (task-less, dedupe key `digest:<id>`) with the counts.

#### Digest API

REST only, like the rest of Autopilot:

| Route                                  | Does                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /api/autopilot/digests`           | The kept digests, newest first, and how many are unread                        |
| `POST /api/autopilot/digests`          | Makes one now: 201 with the digest, or 202 `{digest: null}` while an agent writes it; 409 if one is being made |
| `POST /api/autopilot/digests/:id/read` | Marks one read                                                                 |

Every change publishes `autopilot.changed`, which the web app uses to refetch the list.

### Custom automations

Automations the user defines (#97, sharing #135, scripts and checks #225; guide: [custom automations](../guide/custom-automations.md)).
An action is an agent (on a schedule, optionally gated by a [check script](#check-scripts)), a shell command or a script.
Each row of
`autopilot_custom` (name, `trigger_json`, `filters_json`, `action_json`, `armed_at`) is a catalogue entry
`custom:<id>`, built by `customAutomation` (`autopilot/custom.ts`). The service's catalogue is a function
(built-ins, then every custom row), so a create, edit or delete applies from the next pass; nothing is reloaded.
Their switches and config are ordinary `autopilot_settings` rows, and the table's delete trigger removes them with
the automation. Runs stay, under the old key.

| Trigger            | Candidate                                   | Dedupe key                                     |
| ------------------ | ------------------------------------------- | ---------------------------------------------- |
| `status_change`    | A task in `to` (moved from `from`, if set, by its latest `status_changed` or `closed` event) | `status:<taskId>:<statusChangedAt>` |
| `pr_event`         | Per PR link: `linked`, `new_head`, `checks_failing`, `conflict`, `merged`, timed by `PrChanges` | `pr_linked:<link>`, `pr_head:<link>:<oid>`, `pr_checks:<link>:<began>`, `pr_conflict:<link>:<began>`, `pr_merged:<link>` |
| `stale`            | A task in `status` for `hours`              | `stale:<taskId>:<statusChangedAt>`             |
| `blocker_finished` | A task whose blockers are all Done          | `unblocked:<taskId>:<latest blocker statusChangedAt>` |
| `schedule`         | Per project in scope, no task: weekly (`latestDue`), every N hours (`latestHourlySlot`) or every N minutes, 5 to 1440 (`latestMinutesSlot`), counted from local midnight; only the latest slot counts, so downtime catches up once | `schedule:<projectId>:<local slot stamp>` |

- **Arming.** Events before a task came into the automation's scope don't fire, so switching it on doesn't act on
  the board's history. `customArmedAt` takes the latest of:
  - `armed_at`: set at creation and when the trigger or filters change (which also clears the times below);
  - the scope's time in `armed_projects_json`: a project's when its switch turns on there (`onEnabled`), an epic's
    (`epic:<id>`) when its effective state goes from off to on for an epic with a setting of its own
    (`onEpicEnabled`, which also covers it going back to Inherit). Lifting Pause all stamps every project and such
    epic that is on. A task in an epic with its own setting follows the epic, not the project, so switching the
    project doesn't drop events the epic is waiting on (held by quiet hours or a cap). An epic that gets a setting
    of its own takes over the project's time (`onEpicOwnSetting`), so its floor doesn't move either way;
  - when the task came into that scope: its latest `epic_changed`, `moved_project` or `unarchived` event, or its
    epic's `archived` or `unarchived` (`scopeChangedAt`): an archived epic no longer counts, so its tasks move to
    the project's scope.

  `stale` is a state, not an event, and ignores arming.
- **Epic scope.** Task-based custom automations can be switched per epic like the built-in ones (the engine
  resolves each task's epic). A schedule has no task, so it has `epicScope: false`, epics don't list it, and changing
  a trigger to a schedule deletes its epic switches.
- **Event times** are `statusChangedAt`, the latest blocker's, a PR link's creation, or for PR states the time the
  board saw the state begin. `setSnapshot` keeps that in `task_links.pr_changes_json` (`PrChanges`,
  `nextPrChanges` in contracts): when the PR merged, its checks started failing, a conflict appeared and its head
  moved from one commit to another. The PR's own `updatedAt` isn't used: a comment moves it. The first snapshot of a link only records what is true (`failing`,
  `conflicting`), so a state the board finds in place never counts as beginning: not on linking a PR, and not on the
  first poll after a restore, which leaves snapshots and this column out of the backup. Pending checks and unknown
  mergeability keep the last known state, so checks that fail again after a push, or a conflict GitHub recomputes,
  aren't new; passing and then failing again is.
- **Filters**: projects (on top of the scopes), labels (any of, normalised) and epic (`customTaskMatches` in
  contracts). Epics and archived tasks never match. A schedule has no task, so it takes only the project filter
  (`checkCustomDefinition`, run by the service and the form), and an agent on it can't use `onPrBranch`.
- **Agent action** (`needsAgent`): `customAgentPrompt` (contracts) is the skill line, the prompt with its
  `{{…}}` placeholders filled (`CUSTOM_PLACEHOLDERS`; unknown ones are refused on save) and the task's context.
  It goes to `ctx.runner.start` with the action's tier (else the task's) and, with `onPrBranch`, `workspace.branch`
  set to the PR's head branch. Its config is the shared runner options, per scope. On a schedule there is no task:
  the prompt's footer names the project and its folder instead (`customAgentPrompt` with a null task), the run has no
  `taskId`, and the runner runs it headless in an empty temp folder through `startDetached`, as it does the digest
  (never in the project's checkout, which the board may be running from, so the runner option is ignored: it is always
  headless). It has the usual edit access and the board's tools, and `repo` (the project's folder) gives it the
  default-branch push guard and the safety note a worktree run gets; the prompt names the folder as the live checkout to
  read from, not edit (advisory only: the run has edit access and Bash, and only pushes are denied; a project with no
  folder gets the safety note without a branch name and the generic denials). The tier is the action's, else the default for the runner's model tiers. One at a time per
  project: while a run of the automation for the project is queued or running (`status().active`), `check` returns no candidate, so the
  slot isn't recorded and the latest slot runs once the run ends. It also counts against `maxConcurrent` and the daily
  caps like any agent run.

  **Handover.** A scheduled run has no memory of the last one, so it is asked for `{summary, handover}`
  (`SCHEDULED_AGENT_OUTPUT_SCHEMA`, `outputSchema` on the runner request) and keeps it in `output`
  (`ScheduledAgentRunOutput`, `kind: "scheduled_agent"`, the handover cut to `HANDOVER_MAX_CHARS` = 4000 by
  `capHandover`). The prompt's footer (`customAgentPrompt` with a null task) says what a handover is for (what the next
  run needs, not a log; it replaces the last one) and, when there is one, passes on the last run's under "Handover from
  the last run", inside `<handover>` tags and labelled as data (the agent reads external text, so it may echo some),
  not instructions. `AutopilotService.lastHandover(automation,
  projectId)` reads it from the newest real, succeeded, task-less run of the same automation in the same project that
  has such an output (`lastScheduledAnswer`): a failed run leaves none, so the one before it carries on. A run
  with no structured answer fails (the runner's `outputSchema` handling), and what it did isn't carried over, so the
  next run may repeat it; an answer of the wrong shape that got through anyway keeps no `output`. Other
  projects and other automations never see it. A dry run's preview includes it. The editor links to the automation's
  [run history](#run-history), which lists its runs with their summary and handover, since a task-less run has no
  task panel to show in.
  - **Allowed tools** (`allowedTools`, `CustomToolRule` in contracts): extra tools the agent may call unattended,
    such as the user's own MCP servers, as `mcp__<server>`, `mcp__<server>__<tool>` (a `*` only in the tool part) or a
    built-in tool from `CUSTOM_BUILT_IN_TOOLS` with an optional specifier (`Skill(name)`); a built-in rule only adds a tool, it never narrows one the run already
    has (an edit run allows all of them but Agent and Skill); at most 20,
    200 characters each, deduped. The shell tools (Bash, PowerShell) are refused: the push and merge deny rules are
    `Bash(...)` patterns, so another shell tool would sidestep them, and an edit run has Bash anyway. `act` passes the
    rules as `RunnerRequest.tools`, for a task's run and a scheduled one alike, which `agentArgs` appends to `--allowedTools`. They make the run
    headless (a T3 thread can't be given tools, so with the runner set to T3 Code only, a task's run fails and says
    so; a scheduled run is headless anyway). Everything else about the run is unchanged: the push and merge deny rules still win, since deny rules beat
    allow rules. That covers git and gh run through Bash; a tool of an MCP server that runs commands is the user's
    call, which is why the editor warns. The dry-run preview lists the tools under the prompt. Nobody can approve a call in a headless run, so a tool not listed is denied, and one listed runs with
    no prompt: the editor warns about that. The server has to be one the run can start without approval: the user's
    own (`claude mcp add --scope user`, a plugin or a connector), as for [issue import](issue-import.md). A server from
    the project's `.mcp.json` needs an approval nobody can give. Only the agents of untrusted check items set
    `untrustedInput` ([check scripts](#check-scripts)); an untrusted run starts with `--strict-mcp-config`, so MCP
    rules would find no server there anyway, and the definition check refuses allowed tools and slots with them.
- **Shell action** (`background`, not `needsAgent`, so the agent caps and quiet hours don't hold it):
  `integrations/shellCommand.ts` runs the command with `/bin/sh -c`, or, on Windows, Windows PowerShell with
  `-EncodedCommand` (never cmd.exe, which expands `%VAR%` before parsing, so a value could add a command; values
  passed as arguments to another program are still unsafe there, since Windows PowerShell doesn't escape their quotes
  and `.cmd`/`.bat` programs re-parse them in cmd.exe; only the guide and the editor can warn about it), in the
  project's `workspaceRoot`, with the
  server's environment minus every `brandEnv` variable (the API token) plus the values as `brandEnv` variables
  (`customShellEnv`). The command is never interpolated, and `{{…}}` in it is refused on save. A timeout kills the
  process tree (`processTree.ts`, shared with `claude -p`), with SIGKILL and giving up on the run 5 seconds later if
  it doesn't end. Non-zero exits and timeouts fail the run and flag the task; the output's last 4,000 characters and
  the exit code go on the run. At most `AUTOPILOT_BACKGROUND_MAX` (4) go at once; the engine skips further
  candidates until one ends, without recording them.
- **Script action** (`{kind: "script", language: "python" | "node" | "powershell" | "sh", body, timeoutSeconds}`; the
  body is at most `CUSTOM_SCRIPT_MAX`, 100,000 characters): like a shell action in every other way (`background`, same
  environment, same results, same cap), but `integrations/scriptRunner.ts` writes the body to a file in a temp folder
  of its own, removed afterwards, and runs it with the language's interpreter in the project's `workspaceRoot`. `node`
  is the server's own `process.execPath` (as Node under Electron); `python` is `python -I -X utf8` (`python3` first
  off Windows; `python`, then `py -3`, on it); `powershell` is `pwsh`, else Windows PowerShell; `sh` is `sh` on the
  PATH. The interpreter is looked up on the PATH before anything starts, so a missing one fails the run with
  "python not found on PATH" (and flags the task) rather than a spawn error. The context goes to stdin as JSON
  (`customScriptContext`: `automation`, `project` with `id`, `name` and `path`, `inputs`, `task` and `pr`, null when the
  trigger has none), with non-ASCII characters escaped so every runtime reads it the same. The result keeps `stdout`
  (the first `STDOUT_MAX` characters) and `stderr` apart for a caller that parses what the script printed; the run
  gets the interleaved tail and exit code as for a shell action. A `{{…}}` in a body that names a placeholder is
  refused on save, as in a command (other `{{…}}` text is left alone). Known limits: a PowerShell script gets the shell
  action's two-line prelude (progress and encoding) and exit handling around it, so it can't open with `param(...)`,
  `[CmdletBinding()]` or `using`; it runs with `-File`, which an execution-policy Group Policy can block, unlike a
  shell action's `-EncodedCommand`; and on Windows only `.exe` programs are found on the PATH (not `.cmd` shims).
  The spawn, output buffering and timeout kill are shared with shell actions in `integrations/captureProcess.ts`.
  The storage is the same `action_json` column, so no migration.
- **REST only**, no MCP: `GET/POST /api/autopilot/custom`, `PATCH/DELETE /api/autopilot/custom/:id`. A write whose
  action is (or stays) a shell command, a script or an agent with a check script needs an `Origin` header, which browsers send and the guard checks is the
  board's; agents and scripts usually send none. It's a guard rail against an agent setting up a command by
  accident, not a boundary. Every change publishes `autopilot.changed`.
- **UI**: **Settings → Autopilot → Custom automations** (`CustomAutomationsSection`, the editor
  `CustomAutomationEditorForm` as a sub-page, `/settings/autopilot/custom/<id>`). The preview runs the same contracts helpers as the server
  on the newest board task the filters let through (`customAutomations.logic.ts`). Switches are the usual rows and
  lane popover entries, since those list the catalogue.

#### Inputs and required tool slots

An agent action carries `inputs` and `slots` (`AutomationInput`, `AutomationSlot` in contracts), both empty by default,
so rows saved before them still parse.

- **Inputs** are `{name, label, type: text | number | boolean, default, value}`. The prompt reads `{{inputs.<name>}}`
  (`renderCustomPrompt` with `CustomValues.inputs`), for declared names only. A value is data: it isn't filled in again,
  so one that looks like `{{task.title}}` stays as written. `checkCustomDefinition` refuses an undeclared
  `{{inputs.x}}`, repeated names and a value that doesn't fit its type (`inputValueProblem`).
- **Slots** are `{name, label, description, tools}`; `tools` follow the `allowedTools` rules. `customAllowedTools` is
  the allowed tools and every slot's tools together, which is what `act` passes as `RunnerRequest.tools` and what the
  dry-run note lists. `customAgentPrompt` adds a "Tools to use for this" line per *filled* slot after the prompt.
- **Blocked.** While a slot has no tools, `customBlockedReason` gives "Won't work until you fill in: Jira tools". The
  catalogue entry carries it as `Automation.blocked` (`AutopilotAutomation.blocked` in the API): `setScope` refuses
  `mode: "on"` with that message (`VALIDATION`), the UI shows it in orange and disables On, and the automation's `check`
  finds nothing meanwhile, so emptying a slot of one that is already on stops it rather than starting an agent without
  its tools. Inherit and Off are unaffected.

#### Check scripts

An agent action on a schedule can carry a `check` (a `CustomScript`: language, body, timeout) that runs before any
agent and decides what, if anything, they start for (#227). Null, the default, runs one agent per slot as above. Only a
schedule takes one for now (`checkCustomDefinition`); task triggers would need a check per task event.

- **Output.** The script prints JSON lines on stdout, each an object with a non-empty string `key` (at most
  `CHECK_KEY_MAX`, 200 characters) and any fields of its own; `parseCheckOutput` (contracts) reads them. Blank lines
  are skipped and a key printed twice counts once; any other line (not JSON, not an object, no key, a key with a
  control character, which would end up in the run's label and session name, over `CHECK_LINE_MAX`) fails the whole output with its line number, so a script that prints a stray `Done!` starts nothing.
  At most `CHECK_ITEMS_MAX` (500) items are read per run. It gets the same environment and stdin context as a script
  action, with no task, and runs in the project's `workspaceRoot`. A `{{…}}` in it that names a placeholder is refused.
- **In the engine.** `check` must not wait on a script (the engine awaits each automation's `check` in turn), so the
  first pass of a slot starts the script in the background and returns nothing; when it ends it calls
  `CheckContext.wake` (the engine's debounced pass) and the next pass returns what it printed. Where each project's
  check stands (`running`, `done` with the items, `failed`) lives in a `CheckRuns` map made once in `createServices`,
  keyed `<automation id>:<project id>` and stamped with the slot and the automation's `updatedAt`, so it runs once per
  slot and again after an edit. One runs at a time per automation and project: a check that outlasts its interval is
  waited for rather than started again beside itself, what it printed is acted on once (`offered`) in the slot it
  ended in or the one after (`finishedSlot`, by the engine's clock, `CheckContext.clock`), however many intervals it
  ran for, and the slot due then gets a run of its own. Output no pass read by then (Autopilot paused, the automation
  switched off) is dropped rather than acted on late. It is in memory only: after a restart the slot's check runs
  once more, and the items' dedupe keys keep that from starting anything twice. The check doesn't start while no
  agent could (`agentHold`: quiet hours, `maxConcurrent`, the daily caps), so it isn't run only for its items to wait
  (a dry run runs it anyway), nor while `AUTOPILOT_BACKGROUND_MAX` (4) checks are already running, across automations
  and projects: the agent caps don't bound scripts. The one-run-per-project hold of scheduled agents doesn't apply:
  each item is a run of its own.
- **Items.** Each item becomes a candidate keyed `check:<projectId>:<item key>`. The board is the memory, not the
  script: a key with a run (going, done or failed) is never started again, so a script can print every open item each
  time, and a failed item starts again only through `retry_autopilot_run`. Keys that already have a run are dropped
  before counting, and at most `CHECK_NEW_ITEMS_MAX` (50) new ones go per pass. Items go through the engine's
  per-candidate hold as usual: one held by `maxConcurrent` or a cap isn't recorded, and a later pass in the same slot
  takes it from the same output (a finished agent run asks for a pass). Printing nothing is a quiet pass: no run.
- **A failed check** (non-zero exit, timeout, a missing interpreter, output past `STDOUT_MAX`, a bad line) becomes one
  candidate `check-failed:<projectId>:<slot stamp>:<updatedAt>` (`CHECK_FAILED_KEY_PREFIX`) with `startsNoAgent`, which `act`
  records as a failed run with the error, the output tail and the exit code. No task, so nothing is flagged; the
  automation's run history shows it. `act` then forgets the failure, and that run's key keeps the slot's check from
  running again until it is retried (which retires the key), the automation is edited (a new `updatedAt`) or the next
  slot comes. Like Fix PRs' give-ups, these runs
  (retried or not) don't count towards the daily run cap or `maxConcurrent`.
- **The agent.** Each item's agent starts headless with no task, like a scheduled one, labelled `<name> · <item key>`.
  `customAgentPrompt` fills `{{item}}` (the item as JSON) and `{{item.<field>}}` (a dotted path; a string as it is,
  anything else as JSON, a missing field empty) in the same single pass as the other placeholders, so an item's text is
  never read for placeholders itself; a prompt can name them only with a check. The footer quotes the whole item inside
  `<item>` tags as data, not instructions, and asks for no handover: one run of the check starts many agents, and the
  check is their memory.
- **Untrusted items** (`untrustedItems`, on by default): items usually carry text anyone can write, such as PR titles
  and comments. Their agents run read-only with `untrustedInput` and `boardTools`, like Orchestrate: no MCP server but
  this board's, file tools only in their empty folder, and the board's tools narrowed by `CHECK_ITEM_DENIED_TOOLS`
  (Orchestrate's deny list plus starting, messaging or retrying other agents' work and merging). What is left reads the
  board, adds notes and asks the user. Allowed tools and slots can't be used with it, so the definition check refuses
  them; off, the agents get a scheduled agent's access and the action's tools.
- **Dry run.** The check really runs (the preview says so), and each new item is recorded as a skipped run whose
  preview is its agent's filled prompt; a failed check records a skipped run with the failure.
- **Sharing and the editor.** The bundle carries the check with the action (a version 2 file, imported only with the
  script confirmation; see [Sharing automations](#sharing-automations)), and the import page shows it and says how its
  items' agents run.
- **In the editor.** A schedule's agent form has **Check first with a script**: a switch that reveals the
  [script editor](#the-script-editor), the untrusted-items switch (with a warning when it is turned off) and `ScriptWarning`.
  The section is hidden for the other triggers, and `customFormToInput` leaves a check out unless the trigger is a
  schedule, so what was typed survives switching the trigger and back. The prompt hint names `{{item}}` and
  `{{item.<field>}}` while a check is on.

#### The script editor

`ScriptField` (`components/autopilot/`) is the one editor for both scripts of the form: a script action, picked as **Run a
script** beside **Start an agent** and **Run a command**, and an agent's check. It holds:

- A **language** toggle (Node.js, Python, PowerShell, sh) with what each needs installed (`SCRIPT_LANGUAGES` in
  `scripts.logic.ts`): Node is always there, since it runs on the board's own Node.
- The code, in CodeMirror 6 (`ScriptEditor`, which lazy-loads `ScriptEditorImpl` so the ~470 kB chunk stays out of the main
  bundle; until it loads, a plain text area edits the same value). It has a monospace font, line numbers and highlighting for
  the language, coloured from the theme's tokens so it follows the theme and the Contrast setting. Tab indents with
  spaces; Esc then Tab leaves the editor so a keyboard user is never trapped.
- **Load from file** (the file's extension picks the language; at most `SCRIPT_FILE_MAX_BYTES`) and **Copy**.
- A **starter** per language and role (`scriptStarter`): it shows how to read the JSON context on stdin and, for a check, how
  to print JSON lines. A new script starts from it, and changing the language swaps it for the new language's only while
  the text is still some starter (`withLanguage`), so nothing the user wrote is lost.
- The timeout, and the **test run** below.

#### Test runs

`POST /api/autopilot/custom/test-script` (`TestScriptInput` → `TestScriptResult`; `services/testScript.ts`) runs a draft
script once, now, in the folder of a project the user picks, and returns the exit code, stdout and stderr (each cut to
`TEST_OUTPUT_MAX`), the duration and whether it timed out. **It is not a dry run**: the script executes with the same
interpreter, environment and stdin context a real run gets, so it can do whatever it does (approve a PR, push), and the
editor says so and asks for a second click ("Run it for real") naming the project. Nothing is saved or recorded: no run
row, no event.

- An **action** may be given a task (the form's sample task, or none) and then reads that task's values; a **check** has
  none, like the scheduled agent it belongs to.
- For a **check** that exits 0 the response also has the output read as the board reads it (`parseCheckOutput`): the items
  and how many were dropped, or `problem` naming the bad line, and the prompt the first item's agent would start with
  (`customAgentPrompt` with the form's prompt and skill, so it shows the `<item>` block). A check that fails or times out
  has no items.
- A missing interpreter, or a project with no folder, is an answer (`error`) or a `VALIDATION` error, not a server error.
- Like writing a script, it needs an `Origin` header, so only the board's page can start one, and one test runs at a time
  (`CONFLICT` otherwise), so a double click can't act twice. There is no MCP path.
- The test uses the script's own timeout, and a client that goes away doesn't stop it.

### Sharing automations

An automation is shared as a versioned JSON file, an `AutomationBundle` (`packages/contracts/src/automationBundle.ts`,
`format: "<brand id>.automation"`, `version: 1`, or `2` for a file that carries a script). It holds the name, description,
trigger, the filters' labels only, the action, the declared inputs (`{name, label, type, default}`), the declared slots (`{name, label, description}`) and
optionally the `skill` as `{name, body}`. Not in it: project filters, the epic, arming, switches and slot tools, so the
importer's own servers and projects are theirs to choose. `parseAutomationBundle` checks a file, telling one from a newer
`version` apart from a malformed one.

**Scripts** (a `script` action, or an agent's `check`; `actionScripts` lists them) are someone else's code run as the
importer, so they get more care. A file is written as version 2 only when it carries one (`bundleVersionFor`), so
every other file stays version 1 and a board from before scripts still reads it; a version 1 file that carries a
script is refused, since an older board would read it without the script. Language, body and timeout travel as they
are, the body held to `CUSTOM_SCRIPT_MAX` by the contract. Importing a file with a script needs `confirmScript: true` (the
service refuses with a reason otherwise, whoever calls it) and, like creating one, the board page's `Origin`
(`actionRunsCode`, in the route's guard, also covers a check script on create and patch). There is no MCP path that
writes one, and a suggestion (which can only change an agent's prompt) leaves the check as it was. Dump, restore and
the git backup keep the whole `action_json`, so a script comes back as written.

| Route                                  | Does                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /api/autopilot/custom/:id/export` | The bundle (`automationBundle`): inputs' current values as defaults, slots empty, and the action's skill read from the user's installed skills when it is there and fits `BUNDLE_SKILL_BODY_MAX` |
| `POST /api/autopilot/custom/import`    | Body `{bundle, inputs, slots, projectIds, installSkill, confirmScript}`; 201 `{automation, skill}`       |

`customAutomations.importBundle` parses the file again (a body that isn't one is `VALIDATION`), fills the inputs and
slots (`bundleToDefinition`; an input left out takes its default), restricts the filters to `projectIds`, gives it a free
name (`Name (2)`) and runs the usual definition check **before** writing anything, so a file that can't run leaves no
skill behind. The skill goes to `~/.claude/skills/<name>/SKILL.md` (`installSkill` in `skills.ts`) only when
`installSkill` is true; a name taken by any installed skill (folder or frontmatter name) becomes `<name>-2`, `-3`, with
the frontmatter name rewritten, and the automation names what was written. Without `installSkill` it names no skill. It
is saved like any new one, with no switches, so it is off. As when creating one, a shell or script action needs the board page's
`Origin`, and so does `installSkill` with a skill in the file: a skill persists into every later session that reads
the user's skills. The skill's frontmatter `name:` is always set to the name it was installed as (added, with a
frontmatter block, when missing), so a file can't install a skill under another name. Export carries only the skill's
`SKILL.md`, not other files beside it, and the UI says when a skill went into the file.

The web import screen (`CustomAutomationImportForm`, `/settings/autopilot/custom/import`) reads the file in the browser
and shows the prompt, command, scripts (each with its language, and a check script as such), allowed tools and skill
text in full, as untrusted, before **Import**. A file with a script also shows `ScriptWarning` (the shared notice for
the editor too: it runs as you and can do anything you can, such as approve PRs through `gh`; text it reads from GitHub
comes from anyone who can comment, so it should check who wrote it) and a switch ("I've read the script above and I understand it runs on my machine as me"), which
**Import** waits for. It also offers the
files in `AUTOMATION_EXAMPLES` (`automationExamples.ts`). **Dispatch** is an hourly scheduled agent with the inputs `jql`,
`look_back_days`, `max_issues` and `require_approval` and a `jira` slot. It uses `list_tasks(query: KEY)` to skip keys
already on the board, `add_to_backlog` and `set_plan`, then `request_attention` or the Autopilot flag, and keeps triaged
and skipped keys in its handover. It never merges. **Improve prompts and skills** (#134) is a weekly (Monday 07:00)
scheduled agent on the `deep` tier with the inputs `look_back_days`, `max_suggestions` and `targets`, `allowedTools:
["Skill"]` (a headless run is denied the Skill tool otherwise) and its own skill, `<brand id>-improve`, in the file.
The skill holds the method and the rules that keep suggestions lean (evidence from at least two tasks or one costly
one, one behaviour each, rewrite or delete rather than add, no growth without a stated reason); the prompt holds the
inputs. Each run audits its own project (`board_activity` with the project's folder), proposes through
`suggest_change`, and hands over what it proposed, what was accepted and what to watch; `get_editable_prompt` lists a
target's recent suggestions with their status, so it can leave an open one alone and not repeat a rejected one.

**Review repo PRs** (#230) is the example of a [check script](#check-scripts): a version 2 file, since it carries one. A
schedule every 5 minutes, an agent action with `check` (`REVIEW_PRS_CHECK_SCRIPT`, Node, 120 seconds) and the inputs
`trusted_logins`, `max_rounds`, `look_back_days` (7) and `review_outside_contributors` (a boolean, off). The script runs `gh repo view`, then one `gh api graphql` query for the open PRs
(the first 50 by update, with a stderr note when there are more: labels, the last 100 reviews with `commit.oid`, the last 100 comments) and prints one item per
PR that needs a review (only PRs whose `updatedAt` is within `look_back_days`, so a first run isn't a flood of old PRs; a cap on printed items would starve the PRs behind five that are already remembered, so the board's own caps do that job); it holds no state, since GitHub is the memory. A PR is skipped when its author isn't the viewer, in `trusted_logins` or an OWNER, MEMBER or COLLABORATOR (`authorAssociation`) unless `review_outside_contributors` is on, since the agent reads the PR's text with the user's `gh`; when it is a draft, has the
`no-autopilot` label, or its latest valid `/stop-review` or `/re-review` is a stop
(a line start, any case, the last command wins; `/stop-review` counts from the PR's author, the viewer or
`trusted_logins`, `/re-review` only from the viewer or `trusted_logins`, since each starts an agent past the round limit; a
null author never counts). A review counts when the viewer
posted it and its body holds `prReviewMarker()`, the one Review PRs' reviews carry, so this skips what Review PRs posted (not the reverse: Review PRs decides from the board's runs, so a linked PR can be reviewed twice); a review at
`headRefOid` ends the PR's turn. Otherwise the PR is listed unless the reviews already number `max_rounds`; a
`/re-review` newer than the last review (by `submittedAt`; a pending review has none) lists it regardless. A dismissed review isn't an opt-out: GitHub only lets a review that approved or requested changes be dismissed, and the example posts comment reviews. The key is `<repo>#<number>:<head, 7 characters>:<count of
/re-review commands>`, so a push and a request each make a new one, and the board's key memory means a review that
failed isn't retried every slot. Each item's agent (`untrustedItems: false`, since it runs `gh` to read the PR and
post one `--comment` review headed `prReviewHeader()`, which an untrusted-item agent can't) is told in its prompt to
read only and never approve or request changes; nothing in the bundle approves. The risk of that choice, text from
anyone who can open a PR read by an agent with the user's access, is stated in the guide and on the import page's
warning. `reviewRepoPrs.test.ts` runs the script under Node with `child_process.execFileSync` replaced by a fake `gh`.

### Runners

An agent action calls `ctx.runner.start({ run, prompt, tier, options, … })` (`autopilot/runner.ts`). The engine
binds the run's `update` into it, so the session, thread or worktree is on the run as soon as it exists, and a
run that fails afterwards still shows it. A runner throws when the work couldn't be done, and the run fails
with that error.

- **`kind: "start"`** (the default) begins a new session. The automation's `runner` option picks the runner:
  **Auto** (a T3 Code thread when T3 is detected and its live poll is ok, else headless), **T3 only** (fails
  when T3 isn't connected) or **Headless only**. Once Auto has asked T3 it never falls back to headless: the
  thread may have started even when the reply was lost. Before choosing, a status that isn't ready is refreshed
  (`t3.test()`: discover and poll again), because the cached one is empty just after a restart.
- **A T3 that can't be reached is waited for.** A T3 launch or nudge that fails because T3 isn't answering
  (`isT3Unavailable`: not running yet, shell, socket or branch listing unreachable), and T3 only finding T3 not
  detected, is retried every 15 seconds for up to ten minutes in all (`T3_HOLD_MS`, `T3_RETRY_MS`; the clock starts at the
  first failure and is shared by the readiness check and the launch). Auto doesn't wait: a T3 that isn't ready after
  a fresh look sends it headless, as before. T3 only waits while T3 isn't detected; a detected T3 whose shell isn't answering goes on to the launch, which waits if it is unreachable and fails if T3 refuses (an expired token). A request can pass `stillWanted`, asked after each wait: Start planned
  uses it so a task started by hand, moved or archived meanwhile ends the run as skipped (no thread, no flag). The run stays `running` meanwhile:
  no failed run, no attention flag. A retried launch keeps its command id, so T3 never starts two threads. Anything
  else fails at once (no model ready, no token, project not in T3, a changed protocol), and so does a T3 that is
  still unreachable when the ten minutes end. A board restart during the wait fails the run like any run a restart
  strands.
- **`label`** is what the run is, short: "Review PRs · PR #73 round 1", "Fix PRs · PR #73", "Start planned · #107",
  "<custom name> · #42", "Digest". Each automation supplies it, and the runner (`sessionName`) prefixes it with
  "Autopilot · " and uses it as the session link's label, `claude --name` and the T3 thread's title
  (`TaskThreadInput.title`, default the task's number and title). Without one the name is "Autopilot session".
- **`kind: "nudge"`** posts the prompt into the task's latest live T3 thread (`sendToThread`). It never starts a
  session, and fails when the task has no live thread.
- **`workspace.prBase`**: the branch the agent's PR goes to when it isn't the default branch (an integration
  epic's). The session starts from origin's copy of it (T3: `baseRef` with `startFromOrigin`; headless:
  `createWorktree` with `baseFromOrigin`), and both workspace notes say to open the PR against it with
  `gh pr create --base`.
- **`workspace`**: `{ baseRef }` starts a new branch from that ref (default: the default branch); `{ branch }`
  starts from an existing branch, such as a pull request's, and the agent pushes back to it. The default
  branch is refused either way, except for a read-only run, which can't push.
- **No task.** A run with no task (a digest's) is headless only: `claude -p` in an empty temporary folder that is
  removed afterwards, with no worktree and no session link. T3 Code and `nudge` fail for it.
- Headless only: **`access: "none"`** gives the agent no tools at all (no built-in tools, no MCP servers), for one that
  must work from its prompt alone.
- Headless only: **`access: "read-only"`** for agents that only read (a reviewer), **`tools`** to allow more
  (`Bash(gh pr review *)`), **`deniedTools`** to deny more (Orchestrate with May merge off), and **`outputSchema`** for a structured answer, returned as `output`. A T3 thread
  can't be held to these, so a request with any of them runs headless under Auto, and fails under T3 only.
  Also headless only: **`untrustedInput`** for a read-only agent that reads text anyone can write (no MCP servers or
  checkout settings, file tools limited to the worktree, only exact git commands) and **`expectHead`**, the commit the worktree must be at, checked before the
  agent starts (`WorktreeHeadError`, with `moved` when the branch is ahead of it).

Every agent automation spreads the shared runner options into its config (`autopilot/runnerOptions.ts`:
`RUNNER_OPTION_SHAPE`, `RUNNER_FIELDS`, `RUNNER_DEFAULTS`):

| Option           | Default | Meaning                                                                          |
| ---------------- | ------- | -------------------------------------------------------------------------------- |
| `runner`         | auto    | auto, t3 or headless                                                             |
| `budgetUsd`      | 5       | Headless: `--max-budget-usd`                                                     |
| `timeoutMinutes` | 60      | Headless: the agent, and everything it started, is killed after this long        |
| `model`          | blank   | Headless: `--model`; blank takes the task's tier when it maps to a Claude model  |
| `t3Access`       | default | T3: the most access a thread gets. Never more than T3's own default              |

**T3 thread.** `launchTaskThread` with the command id `autopilot-<runId>` (T3 de-duplicates by it), in work mode,
so the model is the one the user mapped to the task's suggested tier. The thread gets a new T3 worktree; for a
`branch` it starts from origin's copy of it. The prompt ends with a note on where to push and the safety rules.

- **One launch per repository at a time.** T3 answers the launch at once and prepares the workspace afterwards,
  starting with a `git fetch` in the project's checkout. Fetches side by side in one checkout race for its ref locks
  and all but one fail ("Workspace preparation failed during provision worktree: … git fetch origin failed"), and the
  engine doesn't await agent actions, so every launch of a pass would start together. So each launch holds the
  repository's gate (`autopilot/repoGate.ts`, keyed by the project folder) from the launch until T3's shell shows the
  thread with a run that is past `preparing` (`threadWorkspace`, every 2 s), for up to three minutes (`T3_PREPARE_MS`;
  then the gate is let go and the run carries on), twice that when the preparation is retried. The headless runner's
  worktree fetch takes the same gate (`gateFetches`). What the user asks for doesn't, since a hold can last minutes:
  launches from the dialog and `start_task_thread`, and an epic's branch (`ensureEpicBranch`). A wait for an
  unreachable T3 lets the gate go meanwhile.
- **A failed preparation is retried once.** When the thread's run goes `failed` during that wait, the runner asks T3
  to prepare it again in the same thread (`retryPreparation`: T3's `prepared-run.retry` command, id
  `autopilot-<runId>-retry`), still holding the gate, so the link and thread stay. The shell may still show the old
  failure for a moment, so a failure counts only once the thread has changed since the retry. A second failure fails the run with
  "T3 Code couldn't prepare the thread's workspace: <T3's error>". T3 refuses the retry for a run that failed for
  another reason, which fails the run with "T3 Code couldn't start the thread: …".

**Headless.** `claude -p` in a worktree of its own (`autopilot/worktrees.ts`):

1. `git worktree add --no-track -b autopilot/<task#>-<run8> <data dir>/worktrees/<repo>/<task#>-<run8> <start>`,
   where `<start>` is the base ref, `origin/<default branch>` or `origin/<branch>`, after a best-effort fetch.
   The new branch tracks nothing, so a bare `git push` can't land on the branch it started from. A worktree
   folder that overlaps the project's checkout is refused.
2. The board picks the session id and records it on the run, with the worktree, before the agent starts. It
   also links the session to the task as an `agent_session` link ([agent sessions](agent-sessions.md)) with the
   run's name as its label and the worktree as its folder, so the card offers Open in terminal (`claude --resume <id>`). Sessions are kept:
   there is no `--no-session-persistence`. The link's status comes from the run, not the harness's files:
   Working while the run goes, then Finished or Failed with the time it ended
   ([agent sessions](agent-sessions.md#live-status)).
3. `--permission-mode acceptEdits`, with Bash, the file tools and this board's MCP tools (`mcp__<id>`) allowed.
   Read-only runs use `dontAsk` with the reviewer's read-only list. The agent reaches the board through the
   user's own MCP config.
4. **Push safety:** Claude Code checks deny rules before allow rules, and in every part of a compound command.
   The deny rules block force-pushes (`--force*`, `-f`, `+ref`), `--mirror` and `--delete`. They block pushes to
   the default branch, including ones written `*:main` or `refs/heads/main` or run as `git -C <dir> push`. They
   also block `gh pr merge` and `gh api …merge…`. They match the command as written, so they are a guard rail,
   not a sandbox; the prompt states the same rules.
5. The cost (`total_cost_usd`) is recorded even when the run stopped early (budget, turn limit). An early stop or
   a timeout fails the run. The CLI is the one set for the board's reviewer (`headlessReviewCli`).

**Cleanup** (`autopilot/cleanup.ts`) runs hourly with the pollers. It removes a finished headless run's worktree
once the task has a merged PR, or `worktreeRetentionDays` after the run finished. It uses `git worktree remove`
without `--force`, so a worktree with uncommitted changes is kept and logged once. The branch is deleted with
`git branch -d`, which keeps a branch that has unmerged commits.

### Writing an automation

One file under `apps/server/src/autopilot/automations/`, added to `AUTOMATIONS` in its `index.ts`, wrapped in
`defineAutomation`:

- `key`: stored in settings and runs, so never renamed. Start planned tasks uses `AUTOPILOT_START_PLANNED`.
- `needsAgent`: whether the action starts an agent, and so counts against the caps. `background` marks a slow
  action that isn't an agent run (a digest waiting on its summary): the engine doesn't wait for it before the next
  candidate. Agent actions always go on in the background.
- `epicScope` (optional, default true): false when no candidate is ever a task in an epic, so an epic can't switch it.
- `schema`, `fields`, `defaults`: the config, parsed with zod over the defaults; `fields` describe the form the
  UI renders (boolean, number, text, time, select, skill; a skill field's `builtinLabel` renames its built-in entry,
  and a text field's `multiline` makes it a text area).
- `check(ctx)`: reads the board and returns candidates, only for `ctx.projects` (and the board when `ctx.board`
  is set). It must be cheap: it runs every pass.
- `act(candidate, ctx)`: does the work, with `ctx.actor` as the actor of any change, and returns the outcome.
  Agent work goes through `ctx.runner.start` (see [Runners](#runners)); `ctx.update` records runner details while
  it runs. Return `needsAttention: true` for a failure the user should see.

An automation must never merge into the default branch itself, close or delete tasks, force-push or push to the
default branch. Its own merge is Merge into epic branch's, through `GithubIntegration.mergeIntoEpicBranch`; an
agent it starts (Orchestrate's) reaches the default branch only through `merge_task_pr`, for flagged tasks.

### The UI

How Autopilot looks on the board (the lane pill, the epic button, the header pause button, the card badge and the
task panel's Autopilot section) is in [board-layout.md](board-layout.md#autopilot-on-the-board). The settings are in
`components/autopilot/`:

- **Settings → Autopilot** (`AutopilotEngineSection`, self-contained: it reads and writes its own queries):
  Pause all, dry run, concurrency, the daily caps, quiet hours (a switch and a start and end time), PR review
  rounds, the fix threshold and worktree retention. A number that is out of range is put back with a toast; an empty cap means no cap.
- **Orchestrate** (`OrchestrateSettings`, section `autopilot.engine.orchestrate`), between the engine settings and the
  Automations heading: its board switch and config (the same `AutomationField` rows), the **Countdown on lanes** switch for the lane pill's timer
  (`showAutopilotTimer`, a per-browser display preference) and a **View
  all runs** row that opens its [run history](#run-history). It is left out of the folded list below. The Automations
  heading has an **All runs** link to the history of every automation.
- **Automations** (`AutomationSections`): one folded section per other automation with its On / Off switch at
  the board in the header (no Inherit; see [Switches and scopes](#switches-and-scopes)); opening it shows what it does and a form generated from its `fields`: a switch, number, text, 24-hour time
  or select per field, and for `skill` the review skill picker (built-in skill plus skills found on disk; a skill is
  stored as a `ReviewSkillRef`, and an unset one is the built-in skill, labelled with the field's `builtinLabel` when
  it has one, such as the digest's own skill). A project's settings page shows them as rows
  (`AutomationRows`, the config behind a **Settings** disclosure), where Inherit follows the board; an epic's switches (its button's popover) follow its project. The lane and epic popovers show them as a faded switch while it follows the scope above and a solid one with a ↺ reset once set (see [board-layout.md](board-layout.md#autopilot-on-the-board)). Config set at a scope is sent whole (the server replaces it), so editing one
  key sends the scope's other keys with it; the reset button beside a field's title (shown only while the key is set at that scope) removes the key so it inherits.
- Saves reach the server one at a time per scope, each built from the latest saved config when it runs, so two quick
  edits can't undo each other. The server's reply goes straight into the query cache, and `autopilot.changed`
  (which every settings change also publishes) refetches the scopes, so another window's edit shows up too. The
  forms wait for the real entries to load before they can be edited.

## Decisions

- **The review watchdog stays separate.** It is part of local review, on whenever local review is, and must not
  wait for an Autopilot switch or count against Autopilot's caps. See the ADR.
- **Attention is derived, not cleared.** Comparing a flagged run with the task's status change and later runs
  needs no hook in the task service, and can't be left stale by a move made any other way.
- **Held candidates aren't recorded.** A queue of held runs would need its own ordering and expiry; checking
  again next pass gives the same result with nothing stored.
- **Engine settings are one key.** They are always read and validated together; pause is its own key because
  it is a switch, not configuration.
- **The board picks the headless session id** (`--session-id`) rather than reading it from the result. That
  way the session is linked while the agent works, and survives a timeout that leaves no result.
- **Headless worktrees live under the data dir**, never in the project's folder. They can't show up in the
  user's checkout or its `git status`, and cleanup can't touch anything Autopilot didn't make.
- **The digest isn't an agent automation.** Counting a plain daily list as an agent run would use up the run cap
  and hold it behind a busy runner, so the summarised mode applies quiet hours, Pause all and the spend cap itself.
- **The digest has no agent tools.** The summary is written from the plain digest alone: it has nothing to look up,
  and an agent that could call board tools could be steered by a task title imported from an issue.
- **Self-made events are ignored by a depth counter** around the engine's synchronous writes, including the
  synchronous part of an action. Changes an action makes after an `await` do start a pass, which dedupe keys
  make harmless.

## Alternatives considered

| Option | Why not chosen |
| ------ | -------------- |
| Headless runs in the project's own checkout | Would switch the user's branch and mix the agent's edits with theirs |
| `--permission-mode bypassPermissions` for headless runs | Allows tools nobody listed; acceptEdits with an explicit list says what the agent may do |
| A long-running agent watching the board | Costs tokens while nothing happens, and its choices can't be tested or reasoned about |
| Clearing `needs_attention` on task moves | Needs a hook in every path that changes status; deriving it can't go stale |
| Recording held candidates as queued runs | Needs queue ordering and expiry; re-checking each pass is simpler |
| Filling task values into a custom shell command | A title with quotes or `;` would change what runs; environment variables can't |
| Acting on everything that matches when a custom automation is switched on | A "moves into Review" automation would fire for every card already there |

## Code map

| File | What it does |
| ---- | ------------ |
| `packages/contracts/src/autopilot.ts` | Modes, scopes, runs, engine settings, field descriptors, `resolveAutopilot`, `inQuietHours` |
| `apps/server/src/db/migrations/010_autopilot.sql` | `autopilot_settings`, `autopilot_runs`, the scope clean-up triggers |
| `apps/server/src/db/migrations/013_task_autopilot.sql` | `tasks.autopilot`, the per-task flag |
| `apps/server/src/db/migrations/016_autopilot_recurring.sql` | `autopilot_recurring`, the recurring-task rules |
| `apps/server/src/db/migrations/021_autopilot_custom.sql` | `autopilot_custom`, and the runs' `detail` and `exit_code` |
| `apps/server/src/db/migrations/020_autopilot_digests.sql` | `autopilot_digests`, the digests |
| `apps/server/src/mcp/format.ts` | `autopilotFlagHint`, the planning-time nudge to flag a task |
| `apps/server/src/db/repos/autopilotSettings.ts`, `autopilotRuns.ts` | Their SQL, and `attentionFor` |
| `apps/server/src/services/autopilot.ts` | Settings, pause, scopes, the run lifecycle and restart recovery |
| `apps/server/src/autopilot/types.ts` | `Automation`, `Candidate`, `Runner`, `RunnerRequest` |
| `apps/server/src/autopilot/runner.ts` | The T3, nudge and headless runners and the runner choice |
| `apps/server/src/autopilot/runnerOptions.ts` | The runner options every agent automation shares |
| `apps/server/src/autopilot/worktrees.ts`, `cleanup.ts` | Headless runs' worktrees and their removal |
| `apps/server/src/autopilot/repoGate.ts` | One `git fetch` per repository at a time: Autopilot's T3 launches and headless worktrees |
| `apps/server/src/integrations/headlessAgent.ts` | `claude -p` arguments for agent runs, the push deny rules, the outcome |
| `apps/server/src/autopilot/engine.ts` | The pass, the event and tick wiring |
| `apps/server/src/autopilot/limits.ts` | `agentHold`: quiet hours, concurrency and the daily caps, for the engine and Orchestrate's state |
| `apps/server/src/autopilot/automations/index.ts` | The catalogue |
| `apps/server/src/db/migrations/022_autopilot_run_output.sql` | `autopilot_runs.output_json`, an action's structured result |
| `apps/server/src/autopilot/automations/autoArchive.ts` | Auto-archive Done |
| `apps/server/src/autopilot/automations/startPlanned.ts` | Start planned tasks |
| `apps/server/src/autopilot/automations/orchestrate.ts` | Orchestrate: the schedule, Run now, its state, the tools it gets and `orchestratePrompt` |
| `apps/server/src/mcp/tools/autopilot.ts` | `retry_autopilot_run` |
| `apps/server/src/autopilot/automations/unstick.ts` | Remind me about stuck tasks (`unstick`) |
| `apps/server/src/autopilot/automations/reviewPrs.ts` | Review PRs: the trigger, the prompt, the verdict and the hand-off |
| `apps/server/src/autopilot/automations/fixPrs.ts` | Fix PRs: the triggers, batching, the limits and the fix prompt |
| `apps/server/src/autopilot/automations/mergeEpicPrs.ts` | Merge into epic branch: `notMergeable`, the merge, the epic's draft PR and `epicPrBody` |
| `apps/server/src/autopilot/epicBranch.ts` | `ensureEpicBranch`: making an epic's integration branch on origin |
| `packages/contracts/src/runThreads.ts` | `t3RunWorking`: whether a T3 thread a run handed work to is still working on it, for Start planned, Fix PRs and the PR row |
| `apps/server/src/autopilot/threads.ts` | `threadSeen`: whether the live poll has seen a thread lately |
| `packages/contracts/src/prReview.ts` | The review verdict, `PrReviewRunOutput`, `currentPrReview`, the threshold rules, the header |
| `apps/server/src/integrations/github.ts` | `postReview`: the comment review, with its head check and inline fallback; `mergeIntoEpicBranch`, `checkAutopilotMergeTarget`, `ensureEpicPr`, `setPrBody` |
| `apps/server/src/autopilot/automations/recurring.ts`, `services/recurring.ts` | Recurring tasks: the automation, and the rules' service |
| `packages/contracts/src/recurring.ts` | Rule and schedule schemas, `nextDue`, `latestDue` |
| `packages/contracts/src/customAutomations.ts` | Custom triggers, filters and actions, placeholders, the shell environment, the definition check |
| `apps/server/src/autopilot/custom.ts`, `services/customAutomations.ts` | Custom automations as catalogue entries, and their service |
| `apps/server/src/integrations/shellCommand.ts`, `scriptRunner.ts`, `captureProcess.ts` | Running a shell or script action, and the spawn they share |
| `apps/web/src/components/autopilot/CustomAutomation*.tsx` | The custom automation list and editor |
| `apps/web/src/components/autopilot/ScriptField.tsx`, `ScriptEditor*.tsx`, `scripts.logic.ts` | The script editor (CodeMirror, lazy), language notes, starters, the test run panel |
| `apps/server/src/services/testScript.ts` | Running a draft script once for the editor's test run |
| `packages/contracts/src/automationBundle.ts`, `automationExamples.ts` | The shareable file (version 2 with a script), and the shipped examples, with the "Review repo PRs" check script |
| `apps/server/src/autopilot/reviewRepoPrs.test.ts` | The example's bundle, and its script run against a fake `gh` |
| `apps/server/src/autopilot/automations/digest.ts`, `autopilot/digest.ts` | Digest of what changed: the automation, making a digest (plain, summarised, the fallback) and "digest now" |
| `apps/server/src/autopilot/digestBuilder.ts`, `digestConfig.ts` | The plain digest's Markdown, and the automation's config |
| `apps/server/src/services/digests.ts`, `db/repos/autopilotDigests.ts` | Collecting the period's activity, storing digests, the inbox notification |
| `packages/contracts/src/digest.ts` | `Digest`, `dueDigestSlot` |
| `apps/web/src/components/recurring/` | The rule list, editor and examples on the project settings page |
| `apps/server/src/http/routes/autopilot.ts` | The REST routes |
| `packages/contracts/src/autopilotRunHistory.ts` | The run history's filter, query and page, and the delete's input, result and kept reasons |
| `apps/server/src/db/migrations/034_autopilot_runs_automation_index.sql` | The index the history page's filter and paging read |
| `apps/web/src/components/autopilot/RunHistory.tsx`, `RunHistoryRow.tsx`, `runHistory.logic.ts` | The run history page, a run's row, and the URL-to-filter logic |
| `apps/web/src/components/autopilot/OrchestrateSettings.tsx` | Orchestrate's area in Settings → Autopilot |
| `apps/web/src/state/autopilotRunHistory.ts` | The history's infinite query, the delete preview and the delete |
| `apps/web/src/components/autopilot/` | The pill, epic button, their shared popover (`ScopePopover`), badge, panel section and settings (`autopilot.logic.ts` holds the tested logic) |
