# Autopilot

Board tasks: #79 (engine core), #85 (runners), #88 (Unstick stale tasks, now reminders), #90 (digest), #94 (start planned tasks), #95
(PR review), #21 (other people's PRs), #97 (custom automations), in epic #101; #123 (Merge into epic branch), #127 (Merge ready PRs); #135 (sharing custom automations); #241 (agents' drafts).

Autopilot lets the board act on its own: a catalogue of automations, each switched on or off per epic, per project or
for the whole board, that watch the board and act when something needs doing. The engine is deterministic code in
the server. It never calls an LLM itself; an automation whose action needs one starts an agent through a runner.
The rules every automation lives under are in [ADR 0008](../decisions/0008-autopilot-engine.md).

This doc covers the engine, the runners, the per-task flag, the automations that have landed (below) and the
settings UI. The digest's header button and panel are in [board-layout.md](board-layout.md#digest-of-what-changed). The rest of the catalogue is each its own task in the epic.

## How it works

### Switches and scopes

Each automation has a mode at each scope: **Inherit**, **Off**, **Preview** or **On**. The most specific scope that
isn't Inherit wins: epic over project over board. With nothing set anywhere, an automation is off. [Preview](#preview)
is on, but every run it makes is a dry run.

The board is the top scope, so Inherit there would only fall back to that default, which is the same as Off. The
board's switch therefore offers **Off**, **Preview** and **On** only (`BOARD_MODES`); no row reads as Off, and picking
Off saves `inherit`, which drops the row unless it still holds config or a last on-mode. The server accepts every mode
at every scope. Projects and epics offer Inherit / Off / Preview / On.

| Board | Project | Epic    | Effective      |
| ----- | ------- | ------- | -------------- |
| —     | —       | —       | Off (default)  |
| On    | Inherit | Inherit | On (board)     |
| On    | Off     | Inherit | Off (project)  |
| Off   | On      | Inherit | On (project)   |
| Off   | Off     | On      | On (epic)      |
| On    | On      | Off     | Off (epic)     |
| On    | Preview | Inherit | Preview (project) |
| Preview | Inherit | On    | On (epic)      |

**Where it runs** is the same rows read as one sentence and edited as one table. `describeWhere` (`packages/contracts/src/autopilotWhere.ts`)
turns an automation's modes at every scope into a reach and its exceptions: **Everywhere** is the board On;
**Only in…** is the board off with some projects On; **nowhere** is neither. An exception is a project or epic whose own
setting differs from what it would follow: a project Off under Everywhere, an epic set against its project (an epic
set the same as its project is not one). "On everywhere except payments-api; epic #5 Off" is the sentence for the
board On, payments-api Off and epic #5 Off. Switching on over the board's row drops the rows a project or epic only repeated, so a later Switch off of the board really is off. Nothing is stored for it: the edits (`whereEverywhere`, `whereOnEverywhere`, `whereOffEverywhere`,
`whereProject`, `whereProjectPreview`, `whereEpic`) return the plain `PUT` writes (a scope and a
mode), and a toggle that gives what the scope above already gives saves Inherit rather than an override
(`modeToBe`), so a project that is switched on and off again leaves no row. Each write is its own request and the
server acts on each, so the order is part of the contract: a write that turns the board on sends it first, so nothing
is off on the way, which would drop a Run now request or restart a schedule (`whereEverywhere` keeps projects set Off,
and `whereOnEverywhere`, the table header's on click, clears them too), and `whereOffEverywhere` clears epics and
projects before the board. `useApplyWhere` sends them in order and the event stream holds back the switches'
refetch until the last is in (`WHERE_MUTATION_KEY`). The tests run every board × project × epic
combination against `resolveAutopilot`.

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
first, then project, then epic, over the automation's defaults (with the board's [agent defaults](#agent-defaults)
laid over them), whatever the modes: a project can tune an
automation the board switches on, and an epic can tune one for its tasks. `resolveAutopilot` in `packages/contracts/src/autopilot.ts` is the rule, and
`describeInherited` gives the UI its "Inherit (On from board)" (or "Preview from board") label.

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

### Preview

Preview is a per-automation dry run: try one new automation while the others keep working. `resolveAutopilot` counts
`preview` as enabled and sets `preview`, so the check runs where it would, and the engine records each candidate whose
task (or project, or the board for a task-less one) resolves to Preview as a dry run: a `skipped` run with "Would …"
as its summary, exactly as under [Preview everything](#engine-settings-and-pause) (`engine.dryRun`), which still
previews every automation at once.

- **What still runs.** Nothing the action would do: no agent, no shell command or script action, no change to the
  board or GitHub. A custom automation's **check script** is the exception: it runs for real, to find what it would act
  on, so its preview can say what it printed. The UI says so wherever an automation has one.
- **Per scope.** A project, or an epic, can be in Preview while the rest is On, and the other way round. A check is
  handed `ProjectScope.dryRun` per project (true when no scope reaching the project is live: neither the project's own
  resolution nor an epic of it switched On) and `engine.dryRun` set when nothing of the automation is live anywhere, so
  checks that read the dry-run flag (dedupe of custom checks, Orchestrate's slots, Start planned's room) read the right
  one. The engine still decides each candidate by its own task's scopes.
- **Turning it on.** Going from Preview to On counts as switching it on (`onEnabled`, `onEpicEnabled`): a custom
  automation re-arms and Recurring tasks restarts, so On acts on what happens from then, not on what Preview saw. Dry
  runs are deduped apart from real ones, so the Preview runs stay as history.
- **Start planned's room.** Its check resolves each task as the engine will: a task that resolves Off (outside an epic
  that is on, in a project that is off) is left out, and one in Preview is handed over outside the slots, since the
  engine only records it. Neither can take the room a live task needs.
- **A custom automation's preview text** is built per task: its epic's mode when the epic has its own setting, else
  its project's, so a task in a Preview epic of a live project still gets "what it would run".
- **Elsewhere.** The merge gate counts Review PRs in Preview (or under Preview everything) as on, so a merge still
  waits for its review: that review doesn't come until it is turned on, which holds merges back rather than letting a
  PR through unreviewed. A Recurring section in Preview says no task is made.
- **New automations save in Preview.** Creating, importing or importing a draft writes a board row in Preview
  (`customAutomations` insert), with `last_on_mode` Preview.
- **The last on-mode.** `autopilot_settings.last_on_mode` (migration 043, which also widens the mode CHECK) keeps the
  last of On or Preview a scope was set to, through Off and Inherit; the row stays while it holds one. Such a row, at
  Inherit with no config, isn't an epic's own setting (`epicsWithOwnSetting`), so the epic still follows its project. Scope entries
  carry it as `lastOnMode`, with `preview`. The list's switch turns an automation back on in it, or, with none, in
  Preview for one that has never made a real run and On for one that has (`restoreMode`). The lane and epic popovers'
  switches turn on in it, or On.
- **How often it would have run.** `overview.previewRuns` counts each automation's dry runs over the last 7 days
  (`PREVIEW_WINDOW_MS`, `autopilotRuns.dryRunCountsSince`), for the detail's "Would have run N times this week" notice
  and its **Turn on**.

### Engine settings and pause

Engine-wide settings are one `autopilotEngine` key in the `settings` table, and Pause all is
`autopilotPaused`:

| Setting                | Default         | Meaning                                                              |
| ---------------------- | --------------- | -------------------------------------------------------------------- |
| `maxConcurrent`        | 1               | Autopilot's open agent runs at once (not a machine-wide limit)       |
| `dailyRunCap`          | none            | Agent runs started per local day                                    |
| `dailySpendCapUsd`     | none            | What agent runs created today may cost before no more start          |
| `quietHours`           | off, 22:00–07:00 | No agent runs start in the window (local time; may wrap midnight; equal ends are no window) |
| `dryRun`               | off             | Preview everything: every automation records what would run, and does nothing |
| `worktreeRetentionDays` | 7              | Days a finished headless run's worktree is kept when its PR hasn't merged |
| `agentDefaults`        | auto, $5, 60 min, T3's default | What agent automations run with unless they override it ([below](#agent-defaults)) |

Quiet hours and the caps only hold back automations with `needsAgent`; board-only actions (archiving a card)
go ahead.

#### Agent defaults

`agentDefaults` (`AutopilotAgentDefaults` in contracts) is the runner, budget, timeout and T3 access every agent
automation runs with: Settings → Autopilot → Limits & safety → Defaults for agent runs. An automation's config only
overrides it. The service lays it over the automation's own defaults (`agentDefaultsFor` in
`autopilot/runnerOptions.ts`, used by `resolve`, the scope entries and the overview's `defaults`), key by key, for
the keys the automation has a default for and whose value its schema accepts: Orchestrate has no runner or T3 access,
and Review PRs, which takes only Auto or Headless, keeps its own runner when the board's is T3 Code. So a key comes
from the most specific scope that sets it, else the board's agent default, else the automation's built-in default
(`readRunnerOptions(config, board)` falls back the same way). The model isn't one of them: each kind of run has its
model in Agents → Operations ([Models](#models)), and an automation's Model field defaults to Inherit. A run with no
task (the digest, a scheduled custom automation) and a custom agent given extra tools are always headless, whatever
the board's runner, so a board default of T3 Code can't make them fail.

Review rounds, comment rounds and the fix threshold were engine settings (`prReviewRounds`, `prCommentRounds`,
`prFixThreshold`) until `044_autopilot_agent_defaults`, a code migration, moved them into
Review PRs (`rounds`) and Fix PRs (`attempts`, `commentAttempts`, `fixThreshold`; see [Automations](#automations)): a value
the user had changed goes into those automations' board-scope config (unless that scope sets the key already), and
the engine keys are dropped. Review PRs, Fix PRs, Orchestrate and the digest had budgets and timeouts of their own
below the old shared defaults ($2/20 min, $3/30, $3/30, $1/15); the migration writes them into the board-scope config of
each one that has any setting row, so nothing that ran changes, and the user sees them as overrides. One never touched
was never on, and takes the board's defaults. **Pause all** stops every new run; runs already going finish. Backups carry the engine settings but not
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
5. Under Preview everything, or where the candidate resolves to Preview, records a `skipped` run with "Would …" as its
   summary and moves on.
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
Automations that count runs by key (Review PRs' rounds, Fix PRs' attempts, Merge ready PRs' tries) no longer
count the retried one. This replaces pushing an empty commit to get a new head reviewed after a board restart failed
the review. Dry-run runs are deduped
apart from real ones (the unique key is automation, dedupe key and `dry_run`), so turning dry-run off doesn't
hide work it only previewed.

### Runs

`autopilot_runs` holds one row per run: `queued → running → succeeded | failed | skipped`. The runner fills in
`runner`, `session_id`, `thread_url`, `worktree_path` and `cost_usd`. An action can leave a structured result in
`output_json` (`ActionResult.output`, `AutopilotRun.output`) for a later automation to read; Review PRs leaves its
verdict there. A custom automation's shell or script action fills in `exit_code` and `detail` (the output's tail); a dry run
of a custom automation keeps in `detail` what it would have run (`Candidate.preview`). The UI labels a dry run
**Preview**. Runs are history, so backups
leave them out.

- **Deferred runs.** A skipped run whose work comes again later says why in `deferred` (migration 045,
  `AutopilotRunDeferral`, `ActionResult.deferred`). Today that is only `head_moved`: Review PRs, Fix PRs and Merge into
  epic branch stopped because the PR's head moved before or while they ran, so the new head is acted on next. The UI
  shows these as **Deferred: head moved** (`runStatusLabel`, a warning badge), not as a plain skip, and the history's
  outcome filter has them apart. The status stays `skipped`, so dedupe keys, rounds and attempts read them as before.

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
first, or of all of them with `all`: the Runs tab of Settings → Autopilot. An automation's detail and a custom
automation's editor link to its own. It is for reading what scheduled agents did, since their runs have no task panel, and for clearing out old runs.

- **Plain names.** Every run shows its automation's name, never its key: `automationTitleOf` (contracts,
  `autopilotRunHistory.ts`) takes the catalogue's title, then `RETIRED_AUTOMATION_TITLES` for automations the board
  no longer has (`unstick`, `unblock_dependents`, `fix_pr_findings`), "Removed custom automation" for a deleted custom
  one, and otherwise the key made readable. The server's titles (activity, digests, Needs you, notifications) and the
  Stats page's table use it too.
- **A row** shows its status, automation, project and task, the error or summary, cost and age. What you can _do_ with
  it sits in its header, right of cost and age, whether it is open or closed: **↻ Retry** when `canRetryRun` allows it
  (judged against the loaded runs, so a superseded run offers none) and, on a failure, **Ask an agent ▾** (`AskToFix`,
  the hand-off menu described under [Ask an agent](#ask-an-agent) below), so a failed run can be handled without
  opening it. Clicking it opens what the run kept: its summary under an error, the output (**Error output** on a
  failure), a scheduled agent's handover, and a details list of cost, model, runner, times and run id. What it can
  _open_ is a link in that list: **Thread** ("Open in T3 Code ↗" for a T3 deep link, "Open thread ↗" for a web URL)
  and **Session** ("Open session ↗", which opens the session in a terminal as the task panel does when it is linked
  on the run's task (`runSessionLink`), then the short id, the whole one in its tooltip). The task panel's Autopilot
  section places them the same way: Retry on the run's first line, the thread and session links on the line under it.

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
- **Filters in the URL.** The automation is the path's `$automation` (the page's Automation select navigates, keeping
  the rest; retired automations are listed too). Search params `project`, `range` (`24h`, `7d`, `30d` or `custom`),
  `since` and `until` (local calendar days, both included, only with `custom`), `outcome` and `q` (`RunHistorySearch`,
  `runHistoryFilter` in `runHistory.logic.ts`), so a filtered page can be linked to. A preset counts from when it was
  chosen. `outcome` (`AutopilotRunOutcome`, the chips under the filters) is `failed`, `succeeded`, `deferred` (skipped
  with a deferral), `skipped` (the other real skips), `preview` (dry run) or `active` (queued or running); the list's
  `outcome` query param filters the same way (`OUTCOME_CLAUSE` in the runs repo).
- **Deleting, by hand only.** Nothing deletes runs by itself: there is no retention setting and no sweep. Deleting
  sits under **Clean up…** below the list, out of the way: **Select runs to delete** shows a checkbox per run and a bar
  with **Delete selected**, and **Delete all matching…** deletes every run the filters match (**Delete all matching…**, which with no filter is the
  automation's whole history, so with a time range it clears, say, everything before a date).
  `POST /api/autopilot/runs/delete` takes `{ ids }` (at most 500, `RUN_DELETE_IDS_MAX`; the page stops ticking there) or `{ filter }` (the same filter as the list, without paging) and
  `preview`. A preview counts and deletes nothing, which is what the confirm dialog shows before it asks; a real delete
  weighs the runs again and removes them in one transaction, then publishes `autopilot.changed`. The reply is
  `{ preview, deleted, kept, keptReasons }`. Runs aren't in backups ([backup.md](backup.md)), so there is no way back,
  and the dialog says so.
- **What is always kept.** Runs are more than history: the engine reads them. A delete leaves a run alone, with the
  first of these as the reason, when it is: **queued or running**; one whose **worktree is still on disk** (the
  worktree cleanup finds worktrees through the row); **on a task that isn't done or archived**, since dedupe keys
  (`hasRun`), Review PRs rounds, Fix PRs attempts, Merge ready PRs tries and the attention flag read the task's
  runs; a **custom or Auto-archive run on a task** (their dedupe keys follow the task's own state, so without the run Auto-archive would archive a task someone unarchived, and a custom trigger that still holds would fire again); the **latest succeeded answer of a scheduled agent** in its project (`lastScheduledAnswer`, what the next run is
  handed); or **less than a day old** (`RUN_DELETE_MIN_AGE_MS`), so deleting a just-finished run can't free a slot's
  dedupe key (Orchestrate would run the slot again) or make a notice repeat. The other automations are safe without their old runs: Recurring tasks has its cursor, the Digest and Start planned follow state that has moved on, and Review PRs, Fix PRs and Merge into epic branch key on a PR head or sit on tasks that are open while it matters. Everything else, including every older run
  of a Done task, can go. `keptReasons` has each reason with its count (`KEPT_REASON_TEXT`).

### Health and hints

How each automation is doing, on its detail in Settings → Autopilot and in Needs you.

- **This week.** `GET /api/autopilot/automations/:automation/week` (`AutomationWeek` in
  `packages/contracts/src/autopilotHealth.ts`, `AutopilotService.week`) covers today and the six local days before it:
  real runs that acted (`runs`, skipped ones did nothing), `failed`, `deferred`, `spendUsd`, `wouldRun` (dry-run
  records), `gaveUp` (distinct PRs Fix PRs gave up on, by attempt budget: `review` or `comments`, read from its
  `fix:gave_up:` dedupe keys), a bar per day, and its last five real finished runs. 404 for an automation the board
  doesn't have. The detail's **This week** section (`WeekSection` in `HealthSections.tsx`) shows it while the
  automation is on anywhere, with an All runs link. Its query sits under the runs keys, so `autopilot.changed`
  refetches it.
- **Tuning hints** are rules, no model: pure functions in `autopilotHealth.ts` the overview runs for every automation
  that is on somewhere (`hints` in `AutopilotOverview`). Each has a stable `id` naming the situation, a tone, its text
  and one action (`AutopilotHintAction`):
  - Fix PRs gave up on 2 or more PRs this week at an attempt cap below 10 → **Raise to N+1** (Fix PRs' `attempts` or
    `commentAttempts`, set in its board config).
  - 3 or more of the last 5 runs failed (board restarts aside) → **Ask an agent to fix**, which copies
    `fixAutomationPrompt` and dismisses the hint until the next failure.
  - Start planned tasks is on but no ready Planned task (a plan, not blocked, not manual) in its projects is flagged,
    while some are Default → **Flag #9, #10 and #11** (`update_task`-style PATCH with `autopilot: true`; tasks switched
    Off by hand are left out).
  - Orchestrate ran 40 or more times this week since its board setting last changed → **Every 2N minutes** (its board
    config; the count starts again once it changes, so the hint asks again only after the new interval has run often too). Whether a run changed
    anything isn't recorded, so the text says "if most runs found nothing to do".
  - A daily run or spend cap is reached today (`engineHints`, `automation: null`) → **See limits**.

  Hints show under the detail's header (`HintNotice`) and in Needs you, each with **Dismiss**
  (`POST /api/autopilot/hints/dismiss`, stored as the last 200 ids in the `autopilotDismissedHints` setting, which
  stays with the machine like pause). Applying a hint dismisses it too. A dismissed hint comes back only when its id
  changes: a newer give-up or failure, other tasks, another interval, another day.
- **Auto-pause.** After a real run in a project fails, `autoPauseAfter` (service `finish`) reads the automation's
  finished runs there since it was last resumed and counts failures in a row (`failureStreak`: a success ends the
  streak; skipped runs, dry runs and runs the board's restart failed neither count nor break it). At
  `AUTOPILOT_AUTO_PAUSE_FAILURES` (3) it pauses the automation in that project (`autopilot_auto_pauses`, migration 045)
  with a reason ("Failed 3 times in a row. The last: …"), publishes `autopilot.changed` and sends an
  `autopilot_failed` notification. The engine then leaves the project out of the automation's check (a custom
  automation's check script doesn't run there either) and drops its candidates; other projects go on. The overview
  lists the pauses (`autoPaused`): the list row's subline reads **Paused** (amber) "in storefront", the detail's Where it
  runs a row per project with the reason and **Resume**, and Needs you the same. Resume
  (`POST /api/autopilot/auto-pauses/resume`, `{ automation, projectId }`; 409 when it isn't paused) lifts it, counts
  failures again only from then (`counted_from`), marks the notification read, and calls `onEnabled` as lifting Pause
  all does, so automations with a schedule of their own don't catch up. Board-wide runs (no project) never pause.
  Auto-pauses aren't in backups.

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

- The user sets it in the task panel's Autopilot section, as the **start it** chip (On saves On; off saves Default). Agents set it with `autopilot: "default" | "on" | "off"`
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
thread that is working on a task turned manual mid-run, since nothing stops that agent), the quiet-task and waiting-thread reminders, Review PRs, Fix PRs, and Orchestrate (`orchestrateNeedsLooking` ignores it, and
its prompt tells the agent to leave manual tasks alone). The unblocked notification still fires when a manual blocker
finishes, since the task it unblocks is code; Auto-archive still tidies it away once Done.

### API

REST only, for the UI. There is no MCP tool, so agents can't switch Autopilot on, lift its limits or unpause it. The
one exception is `retry_autopilot_run`, which only frees a run's work for the engine to judge again; `draft_automation`
switches nothing on either, since only the user's import saves the automation it drafts ([drafts](#drafts)).

| Route                                           | Does                                                   |
| ----------------------------------------------- | ------------------------------------------------------ |
| `GET /api/autopilot`                            | Pause, engine settings and the catalogue (with each automation's group, field descriptors and defaults), plus today's agent runs and spend, Needs you, auto-pauses, tuning hints and each automation's last finished run, for the settings page |
| `PATCH /api/autopilot/engine`                   | Updates engine settings; `quietHours` may be partial   |
| `POST /api/autopilot/pause`, `/resume`          | Pause all, and back                                    |
| `GET /api/autopilot/modes`                      | Every switch that is set (not Inherit) at any scope, as `{ scopeKind, scopeId, automation, mode }`: the one read the Where it runs widget needs for its exceptions, instead of a scope per project and epic |
| `GET /api/autopilot/board`, `/projects/:id`, `/projects/:id/epics/:epicId` | Each automation at that scope: its own mode and config, and what it resolves to (an epic's through its project and the board) |
| `PUT /api/autopilot/board/:automation`, `/projects/:id/:automation`, `/projects/:id/epics/:epicId/:automation` | Sets mode and/or config; Inherit with no config removes the row |
| `GET /api/autopilot/runs?taskId=` or `?projectId=` | Runs, newest first (`limit`, default 50)            |
| `GET /api/autopilot/runs/history`               | One automation's runs (or `automation=all`), filtered, a page at a time (see [Run history](#run-history)) |
| `POST /api/autopilot/runs/delete`               | Deletes runs by hand, or with `preview` counts what would go (see [Run history](#run-history)) |
| `POST /api/autopilot/runs/:id/retry`            | Retries a failed or skipped run (see [A pass](#a-pass)) |
| `POST /api/autopilot/runs/:id/dismiss`          | Dismisses a flagged run's attention flag (see [Needs attention](#needs-attention)) |
| `GET /api/autopilot/automations/:automation/week` | An automation's last seven days (see [Health and hints](#health-and-hints)) |
| `POST /api/autopilot/hints/dismiss`             | Dismisses a tuning hint by id                          |
| `POST /api/autopilot/auto-pauses/resume`        | Resumes an automation that paused itself in a project  |
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

**Reminders, no longer automations.** Remind me about stuck tasks (`unstick`, #88) and Unblock dependents
(`unblock_dependents`, #92) needed no agent and only notified, so they left the catalogue: they are the `task_quiet`,
`thread_waited` and `task_unblocked` notification settings, found by `sendReminders` on the engine's pass
(`autopilot/reminders.ts`, [notifications.md](notifications.md#what-produces-a-notification)). They have no scopes, no
config (24 hours quiet and 30 minutes waiting are fixed, as their labels say), and no runs: the run history keeps the old ones, named by
`RETIRED_AUTOMATION_TITLES`, and a Needs-attention reason from an old Unstick run still clears on new activity
(`attentionFor`). Getting stalled work moving again is Orchestrate's job (below). Migration `047_reminder_notifications`
turned each switch on where its automation was effectively on, and dropped the automations' `autopilot_settings` rows.

**Recurring tasks** (`recurring`, #89; `automations/recurring.ts`). Needs no agent and has no switch: it is `alwaysOn`, so
every project is on for it (`resolve` and `enabledProjects` say so, which is what the engine and Pause all's restart use), while its
scope entries stay Inherit and not enabled, so a lane's pill doesn't read On because of it, and `setScope` refuses it
with a `VALIDATION`, and a rule that is enabled runs. Pause all still holds it back; quiet hours and the caps never
did (it needs no agent). Makes a task from a template on a schedule; the rules are rows in `autopilot_recurring` (below).
It has no config of its own. Migration `048_recurring_without_switch` disabled the rules of every project where it was
effectively off, and dropped its settings rows.

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
  doesn't bring runs back). Preview everything records "Would …" and leaves the cursor, so turning it off makes the
  task. The automation's own Preview does too, but turning it On restarts the rules (`onEnabled`), so a slot only
  previewed is not made.
- A rule's cursor starts at its creation time, and is set again when the rule is switched on or its schedule
  changes, so slots from before that aren't caught up. The same goes for Pause all: when it is lifted,
  `AutopilotService` calls `onEnabled` for every project and the rules restart from now (`recurring.restart`). Only
  downtime of the board itself catches up.
- Rules are managed in the Recurring tasks detail in Settings → Autopilot (`components/recurring/`); in a project's
  scope it lists that project's rules and offers example rules: adding one creates a template for the project (reusing one of the same name) and the rule. The
  Recurring tasks row in Settings → Autopilot has no switch (`alwaysOn` hides it, and `scopeAutomations` leaves it out
  of the lane and epic popovers); its detail lists every project's rules (`RecurringRulesByProject`), each with its
  switch, next run, last task and a **New rule** for that project (`ProjectRuleRows`). The rule editor keeps its
  path (`/settings/project/recurring/$ruleId?project=`) and returns to that detail.

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
as comments only (task PRs only where `ownPrs` is on). With [Other people's PRs](#other-peoples-prs) on, it also reviews other people's open PRs and
approves, asks for changes or hands them to the user.

- **Trigger.** A `pr` link whose snapshot (from the `gh` poller) is open, or draft when **Review drafts** is on
  (off by default), and has a `headOid` and `headRef`. Merged and closed PRs, PRs from forks (`isCrossRepository`:
  the branch isn't on `origin`), Done and archived tasks, epics and links with no snapshot yet are skipped. The
  dedupe key is `review:pr:<linkId>:<headOid>`: one review per PR and head commit, and a push gives a new one.
- **After the local review.** With auto-review on for the task, its PR isn't reviewed until the task is in Review and its
  [local review](local-review.md) has ended. Before that it waits: a task still in Backlog, Planned or In Progress
  hasn't started its loop (the move to Review opens round 1), and in Review a loop that is still going
  (`reviewIsInProgress`: a round pending, running or stalled, or blocking or major findings open with rounds left)
  holds it. An agent that opens its PR early would otherwise get it reviewed on GitHub while the loop is still
  changing the code. A task sent back to In Progress after feedback waits for its next loop the same way. Once the
  loop ends (clean, or the round limit, stuck included) the PR's current head is reviewed as usual; a failed round
  isn't waited on, and tasks with auto-review off are never held back.
- **One at a time, and rounds.** While a review of the PR is queued or running, a new head commit waits; the next
  pass reviews the latest head with the earlier review in view. A PR gets at most **Rounds per PR** reviews (`rounds`,
  default 3): the rounds used are its real review runs, a failed one included and a skipped one (which
  posted nothing) not, and neither a carried verdict nor a resolution review (below: their output has a `basis`,
  `isCountedReview`). Every new head still gets a run, rounds left or not, so nothing is skipped silently (see Head
  moves, below). Fix PRs counts its
  attempts on Autopilot's review and failing checks against a limit of its own (`attempts`, also 3 by default); each
  fix is followed by at most one new head and so one review. Other people's comments have a budget of their own
  (`commentAttempts`, below).
- **Head moves: base merges and the last round.** When the PR already has a verdict, `act` first asks git how the head
  got from that verdict's head to the new one (`autopilot/headMove.ts`): `fetchForHeadMove` fetches the PR's base and
  head branches into the project's checkout (its fetch waits its turn at the same per-repository gate as the runner's
  worktrees), then `classifyHeadMove` reads the history. Only merges of the base branch in leave the PR's own change as
  it was reviewed, so only those are let off a round: every first-parent commit since the reviewed head must be a
  two-parent merge whose other parent is already on `origin/<baseRef>`. Each is then checked against git's own
  merge (`git merge-tree --write-tree`, git 2.38+): the same tree is a clean merge, a different one (conflicts
  resolved by hand, or an edit slipped into the merge) a resolved one. Anything else (a commit of the PR's own, a
  rewrite or force-push, a merge of another branch, the base merged the other way round) is a change.
  - **Clean base merge: the verdict is carried.** No agent runs and nothing is posted: the run succeeds with the last
    verdict at the new head (`basis: "carried"`, `carriedFrom: <old head>`, the same `round`, `handoff` and review
    id), and the task gets a note "Autopilot carried its review of PR #N … No review round used". This holds for any
    verdict, so a clean one lets Merge ready PRs merge and a `fix` one is still Fix PRs' to act on (once: its
    trigger key is the review id, which the carry keeps).
  - **Hand-resolved base merge: a resolution review**, not counted. The prompt says round N already covered the
    PR's own change and asks the reviewer to check only how the conflicts were resolved (a side's change lost or
    doubled, code that no longer fits the other side, markers left in, unrelated edits), with `git show
    --remerge-diff` of the resolved merges inlined as untrusted text (cut at `MAX_REMERGE_DIFF`, 40,000 characters).
    It is posted like any review, headed "Conflict resolution review (not counted), after round N of M"; its output
    has `basis: "conflict_review"` and the last counted round. Its verdict also counts what the review before it left
    open (counts, `actionable` and so `handoff`; the posted body names that review, and `openFrom` points Fix PRs at
    it), since the merge didn't change the
    PR's own code: a clean resolution can't wave through points nobody fixed. A git too old to check a merge (no `merge-tree
    --write-tree`) treats it as resolved, and one with no `--remerge-diff` gets a full review instead, still
    uncounted. At most `CONFLICT_REVIEWS_PER_PR` (5) per PR, as many as Fix PRs' conflict attempts; past that the run
    is skipped, flagged: "PR #N merged <base> in with conflicts resolved by hand again, after 5 conflict resolution
    reviews …". A resolution review that fails is flagged like any failure but keeps its `basis`, so it costs no
    round.
  - **A change of the PR's own** is a counted round while rounds are left. With none left the run is skipped and
    flagged, so the card says why the PR waits: "PR #N changed after Review PRs' last round (round 3, at `<sha>`):
    `<reason>`. Review and merge it yourself, or retry this run to allow one more round." Retrying it (the run's
    Retry, or `retry_autopilot_run`) grants exactly one more round for that PR at that head: the retried run keeps
    `output.roundsUsedUp`, and a retried notice whose (retired) key is of the PR's current head adds one to its rounds.
    A later head goes back to the configured rounds, and a notice of an older head can't be retried (the board calls it
    history), so no round is banked for later. A resolution review after a granted round still says "round 4 of 4"
    (`maxRounds` is at least that of the review it follows). Retrying the conflict-review notice
    (`output.conflictReviewsUsedUp`) allows one more resolution review the same way.
  - **When git can't tell** (a project with no folder, a base branch the poller hasn't read, a fetch that fails, a
    commit git doesn't have), the move counts as a change: it may cost a round, but never lets code through
    unreviewed. A PR with no verdict yet is always a counted round.
- **Resolving its own threads.** From round 2 the prompt asks the reviewer to list, in the verdict's optional `fixed`,
  the comment ids of earlier Autopilot inline comments whose point is fixed at this commit. After posting,
  `resolveConfirmedThreads` reads the threads fresh (`reviewThreads`) and resolves those (`resolveReviewThread`), only where the thread's first comment is in
  one of the earlier rounds' reviews (`rootReviewId`), so a reviewer can't close someone else's point. A failure leaves
  the thread open and doesn't fail the review; the count goes on the output as `resolvedThreads`. This covers points
  fixed by hand, which Fix PRs' resolver (below) never sees a reply for.
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
  - the PR itself only through its [run tools](#run-tools) (`runTools: {toolSet: "prReview", target}`): `pr_overview`,
    `pr_files`, `pr_diff` and `pr_comments`, bound to this one PR, served by the board and paged so a diff of any size
    is read in full. No `gh` and no network: the run tools' server is its one MCP server.

  Before the agent starts the runner checks the worktree is at the commit the run is about (`expectHead`,
  `WorktreeHeadError`) and, when it isn't, removes the worktree and its branch (the run records neither). A branch
  that moved past the commit skips the run. So does a rewritten branch (a force-push) once `ctx.gitHosts.prHead`
  says GitHub's head is no longer that commit; if GitHub still says it is, the checkout is what's wrong (a stale
  `origin`, a fork's branch name that exists on `origin`, a PR in another repository) and the run fails, flagged,
  before any budget is spent. A read-only run may read the default branch (a PR from `main`), since it can't push.
  A review has to be held to read-only, which a T3 thread can't be, so the runner setting is Auto or Headless and
  both run headless. Its budget and timeout are the board's [agent defaults](#agent-defaults) unless it overrides
  them, and it follows the **Review skill**
  chosen (the built-in `aboard-review` by default; a skill on disk is inlined into the prompt). The prompt calls the
  PR's text untrusted, and says nothing is recorded on the board.
- **The server posts.** The agent answers with a summary and every point (severity, file, line, body, suggestion,
  `fyi`). `renderReview` builds one review from it: the summary under `📋 <displayName> Autopilot review`
  (`prReviewHeader`, from `BRAND`), points with no place in the diff and the FYI ones in the body, and the rest as
  inline comments starting with `📋 <displayName> Autopilot · <severity>`. `ctx.gitHosts.postReview` (GitHub's `GitHost`, `githubHost.ts`) sends it
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
- **Verdict.** The board counts the non-FYI points by severity; those at or above the **fix threshold** are the
  actionable ones. The threshold is Fix PRs' `fixThreshold` (default major), resolved where the task is
  (`fixThresholdFor`), whether Fix PRs is on or not, since what gets fixed is Fix PRs' call.
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
  rather than only the subtype). GitHub failing in passing (`isTransientHostError`: "try again", "internal error",
  `HTTP 5xx`, a timeout or the network) while posting ends the run `skipped` ("will retry"), not a round used, with
  `output.retry`; each try is a full review, as the agent runs again. The next pass reviews the same head again under the key `review:pr:<linkId>:<headOid>:<n>`, up to
  `REVIEW_ATTEMPTS` (3) tries, after which it fails, flagged. Any other failed run is never retried, so there is one
  review per head commit even when posting failed.
- **Hand-off.** `handoff` says what comes next: `clean` (nothing at or above the bar: the loop ends), `fix`
  (something is, with rounds left) or `gave_up` (something is, on the last round: the run ends flagged "Autopilot
  gave up…", which shows under Needs attention and sends an `autopilot_failed` notification). The fix automation
  reads `currentPrReview(runs, linkId, snapshot.headOid)`: the newest finished review of the link (highest round; on a
  tie, which a carried verdict or a resolution review makes, the newer run), and only while its `headOid` is the PR's
  current head, so a superseded or stale verdict is never acted on. The review ids on the
  runs are how it tells Autopilot's own reviews from other people's.
- **Limits.** Switching the automation on reviews every open PR already linked in the project, once per head
  commit; dry run shows which first.

#### Other people's PRs

Board task #21 (epic #123). Review PRs' second source, off until **Others'** (`otherPrs`) is on in a
project's config: open pull requests of the project's repository, by the logins in **People** (`otherAuthors`), that
no task works on. It replaces the custom "Autopilot PR review" automation the owner ran, and the shipped **Review repo
PRs** example. The difference that matters: the agent only reads and answers; the **server** finds the PRs, works
out the mode and the approval gate from the PR's history, and posts. The gate is code, not a line in a prompt.
`automations/repoPrs.ts` (poll, prompt, posting, board writes), `repoPrAssess.ts` (which PRs and how), contract in
`packages/contracts/src/repoPrReview.ts`.

- **Settings.** In the table (`inWhereTable`, so the settings draw no row): **Others'** (`otherPrs`), **People**
  (`otherAuthors`, comma separated, `parseLogins`: lower-cased, a leading `@` dropped) and **Approve** (`otherApprove`,
  off by default). Advanced: **Require a linked issue** (on),
  **Sensitive paths** (`DEFAULT_SENSITIVE_PATHS`: `.github/`, `tools/`, `CODEOWNERS`, `*.lock`, `package-lock.json`,
  `pnpm-lock.yaml`, `go.sum`; `dir/` is a root folder, a name with no `/` matches in any folder, `*` stops at `/`,
  `**` doesn't: `matchesPathPattern`), **Quiet period** (10 minutes), **Other reviewers' wait** (60 minutes) and
  **Rounds** (3). The first three are per project, in the Where it runs table below. On with nobody listed it reviews
  nothing and raises nothing: the table's row asks for people.
- **Where it runs** (`ReviewPrsProjects`, `reviewPrs.logic.ts`). Columns **Your PRs** (`ownPrs`, default true, task PRs
  skipped where false, unless the task's epic set its own On or Preview: `reviewsTaskPrs`, which the merge gate reads
  too, so a PR isn't held for a review that won't come), **Others'**, **People** and **Approve**, the last two empty where Others' is off. The engine
  only looks at projects where the automation is on, so a project runs if either source is on, and a source's switch
  writes the mode together with both source keys in one PUT, so turning a switched-off project on can't bring back a
  source left behind. A project stores a key only where it differs from the board, whose keys are the All projects row
  (no migration: an old board's `otherPrs` and friends read the same). A project's `otherAuthors` replaces the board's
  list; matching it again drops the key. A header click writes the board first, then each project against the new board;
  `opensAllDetail` and `expandsOnTurnOn` open the people where a row has none. A project with no folder (General) is
  skipped before any read, so it records no failed run. The name pills offer logins already in use: the default, each
  project's list and authors waiting under Needs you, so nothing new is read from GitHub.
- **Finding PRs.** The check can't read GitHub in a pass, so `otherPrCandidates` starts a read per project in the
  background every `OTHER_PRS_POLL_MS` (5 minutes, or at once when the settings change) and wakes the engine when it
  ends; each pass offers what the latest read found. The repository is the project folder's `origin`
  (`CheckContext.repoOf`, `createRepoUrls`), and the reads go through `CheckContext.gitHosts`: `listOpenPrs` (the
  newest 100 open PRs), then `readRepoPr` for each one by a listed author (`REPO_PR_QUERY`, one GraphQL query: closing
  issues, files, the newest 100 commits with parent counts, the head's checks with `isRequired`, latest reviews,
  reviews, comments with edit times, threads with comments, dismissed reviews and the open issues of the same
  repository that mention it). The base branch's required checks also come from its rulesets (REST
  `rules/branches/<base>`) and its classic branch protection (`baseRef.branchProtectionRule
  .requiredStatusCheckContexts`), so a required check that never reported is seen. Drafts, PRs linked to a task that isn't
  manual (those are the task source's and Fix PRs'), and PRs of anyone else are skipped. A read that fails becomes a
  failed task-less run, once a day per error, so it isn't silent.
- **History from the markers.** Nothing about a PR's history has to be remembered: everything Autopilot posts ends
  with a hidden marker, the same one the custom automation wrote, so switching over keeps rounds, approvals,
  hand-offs and stops. A review ends `<!-- autopilot-review head=<sha> verdict=approve|changes counted=1|0 round=<n> -->`,
  a hand-off comment `<!-- autopilot-review event=escalated head=<sha> reason=<reason> round=<n> counted=1 -->`, an
  inline point `<!-- autopilot-review finding -->`. Old posts without `round` count one round each when counted;
  v1 hand-offs have no reason and v2's `no_issue` reads as `gate`. `/autopilot stop` and `/autopilot resume`
  (`parseControlCommand`, at the start of a comment, any case) count only from the signed-in account and without a
  marker; the newest wins, and a resume starts the history afresh.
- **Which PR, which mode** (`assessRepoPr`, a port of the custom automation's check):
  - skipped while stopped, while a person's approval or request for changes stands (the user's hand review too:
    it has no marker), while any counted check is pending, until the quiet period has passed since the head commit and
    its last check, and while another reviewer's unresolved thread is younger than the wait and the author hasn't
    answered in it;
  - the newest of Autopilot's reviews, its hand-offs and the user's own approval that someone else's push dismissed
    (`REVIEW_DISMISSED_EVENT`) sets the mode: none is `full`; the same head after an approval or a hand-off is skipped;
    the same head after changes is a `dispute` only once the author replied on one of Autopilot's open threads (the
    reply's id goes in the key), else skipped; a newer head after an approval is `delta` (skipped when its approval
    still stands and nothing the author wrote changed); after a hand-off, `followup` (skipped likewise); else
    `full`. `full`, `dispute` and `followup` past the rounds become `cap_reached`;
  - "nothing the author wrote changed" is `GitHost.unchangedSince`: the PR's change against its base branch
    (`compare <base>...<old head>` and `...<new head>`) is the same patch, hunk line numbers ignored. That holds after
    merging the base branch in or rebasing onto it, and fails for a merge of any other branch, an edited merge, and any
    file GitHub serves no patch for (binary, too large), which can't be compared. A hand-off edited later counts from
    its edit.
  - The key is `review:repo:<host>/<repo>#<n>:<head12>:r<resume id>[:c<reply id>]`; one review of a PR runs at a time.
- **The gate** (`approvalGate`): a closing issue (when required), every required check finished, green and reported,
  at most 100 files (all of them read), no sensitive path. The rulesets' required checks must be readable (anyone who
  can read the repository can): a failure to read them fails the read of the PR, so it is judged on a later pass, never
  as if nothing were required. Classic branch protection's list may be hidden from an account without admin rights;
  then only the checks GitHub marks `isRequired` on the head count. The agent is told the reasons but not asked to obey them.
- **The review.** A task-less, read-only headless run with `untrustedInput`, in a worktree of the project's checkout
  at the PR's head (`RunnerRequest.checkout`: removed when the run ends; a fork's PR gets an empty folder), on the
  `repoPrReview` [run tools](#run-tools): the PR review set plus `pr_threads` and `repo_issue`. `repoPrPrompt` gives
  it the mode, the base commit, the round, the closing and the mentioning issues (the bug report a past approval
  missed), the gate, what to read (the project's docs and decision records), the severity scale (only blocking and
  major hold up approval), a concurrency and contract checklist, when a recorded decision is a departure and when it
  isn't, and the review skill chosen for Review PRs (inlined). It answers `RepoPrReviewVerdict`
  (`REPO_PR_REVIEW_OUTPUT_SCHEMA`): the PR review's answer plus `decision` (approve, request_changes, escalate), an
  `escalation` (reason: departure, dependency, security, dispute or vague; one line; a checklist), `disputes` per
  thread of its own (accepted, rejected, unsure, with a reply) and `counted`.
- **Read again before posting.** The poll can be minutes old by the time the agent answers, so `actRepoPr` reads the PR
  again (`readRepoPr`) before it posts anything: a moved head skips the run, `/autopilot stop`, a person's standing
  review or a closed PR skips it with nothing posted (`standingBlock`), and the gate is worked out afresh, so an
  approval never rests on a check that has since turned red or a `Closes #n` that was removed.
- **What the server does with it** (`settleDecision`). Minor points and nits are always FYI. An approval with a
  blocking or major point open is a request for changes, and a request for changes with none open is a clean
  review (minor points never block a merge). A request for changes in `cap_reached` is a hand-off for
  `cap`. An approval with the gate failing, or with **Approve** off, is `ready`. Only a clean approval past the gate
  is posted as one: `postReview` with `event: "approve"` (or `request_changes`, blocking and major points inline,
  folded into the body when GitHub refuses them), refused with `StaleReviewError` if the head moved, which skips the
  run. `counted: false` is honoured for an approval or a ready-for-approval in `delta` or `followup`, so small re-checks
  don't walk a PR into the round limit. GitHub failing in passing while posting (`isTransientHostError`) skips the run
  with `output.retry`, and the next pass tries again under `<key>:a<n>`, up to `REPO_REVIEW_ATTEMPTS` (3); so does
  GitHub failing in passing on the read before the post. A try finds the post an earlier one made if GitHub took it
  and still answered with an error (`postedSince`: a post of its own at this head after the plan's `lastPostAt`), and
  then posts nothing.
- **Hand-offs.** The head is read again first; a moved PR skips the run with nothing posted or written. One comment
  (`renderHandoff`): the header, the round, "Handed to @you for manual review (<reason>): <why>" or "Ready for
  @you's approval: <gate>", the summary, every point, the checklist, and that Autopilot looks again by itself on a push.
  When the latest hand-off on the PR has the same reason, that comment is edited (`GitHost.editComment`) instead of
  another posted. A real escalation finds the open manual task for the PR (the one remembered, one linking the PR,
  or one titled `Review PR #n:`) or creates one (manual, label `review`, the PR linked, the checklist), and asks for
  attention only when the task is new or the reason changed; a repeat adds a note. A `ready` PR makes no task and
  pings nobody: it goes under **Needs you** (`AutopilotNeed` kind `pr_approval`, from `repo_pr_reviews.ready_since`)
  with a `pr_ready` notification, and leaves it once a person reviews it, it is stopped, closed or merged, a new
  head comes, or its author leaves the list; the list also hides rows of projects where the source or Review PRs is
  off. While it waits, each poll works the gate out again at that head: a reason that changed is updated, and once the
  gate passes (a required check re-run green, an issue linked) and Approve is on, the PR gets a fresh look
  (`approveReady`, key `…:approve:<hash of when its wait was last written>`) that uses no round: the agent is told
  it found the PR clean before and checks what can change without a push (new threads, issues that mention it), and
  the server approves past the gate or, if it is held again, edits its Ready comment with the new reason. Skips carry a typed `code`
  (`ENDS_WAIT` lists the ones that end the wait).
- **Afterwards.** Its own threads the review says are fixed, and disputes it accepted, are resolved
  (`resolveReviewThread`); accepted and rejected disputes get the agent's reply on the thread. An approval, or the
  first review after a resume, closes the PR's hand-off task (a note, attention cleared, Done). Fix PRs never acts
  on these PRs: they have no task.
- **What the board keeps.** `repo_pr_reviews` (migration 046, `services/repoPrReviews.ts`), keyed by host, repository
  and number: the last head, round, outcome and reason, the hand-off comment to edit, the manual task and
  `ready_since`. The run's output is `RepoPrReviewRunOutput`. Neither is in backups; the markers on GitHub are the
  history.

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
    posts as the user, so the user's own comments can't be told from its replies and never count. A thread whose
    newest comment is the user's account's (`ownLast`: Autopilot's reply, or the user's own) is left out altogether:
    it was answered, and asking again would let two review bots ping-pong;
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
- **Action.** When the task's [implementing thread](agent-handoff.md#follow-up-threads) (never a follow-up the user
  opened to ask about the work) is there, not settled, and seen by the live poll in the last ten
  minutes (so T3 Code is up to take it), and the runner isn't set to headless, the fix prompt is a nudge into it.
  Otherwise the runner starts a session (T3 or headless, from the runner setting) with `workspace: { branch:
  headRef }` and `expectHead`: a branch that moved on skips the run, and one at an unrelated commit fails unless
  `prHead` says the PR moved (a force-push). The prompt has a section per trigger with the `gh` commands to read
  it. For Autopilot's review it gives the counts and the review's `threshold` and says to fix only points at or
  above it and leave the FYI section alone. Comments are named by id (`gh api repos/<repo>/pulls/comments/<id>`),
  and the agent is told to read only the reviews and comments listed. The agent pushes to `headRef` and then replies on
  each thread it was sent to, the reply's first line exactly `prFixedReply(sha)` ("📋 … Autopilot · fixed in <sha>")
  for a point it fixed or `prDeclinedReply(reason)` for one it won't. The reply goes in a file posted with `gh api … -F body=@file`,
  because the `gh api *merge*` deny rule would refuse a command line that mentions merging. A custom **Fix skill**
  is inlined into the prompt. The run's `output` is `{ kind: "pr_fix", linkId, headOid, round, attempt, triggers,
  via: "nudge" | "t3" | "headless" }`.
- **By hand.** The PR row's **Fix in →** starts the same kind of fix for the user ([GitHub PRs](github-prs.md#fixing-a-pr-by-hand)),
  with `manualFix`'s prompt, and the row shows this automation's state (running, gave up) in its action slot while it is on
  for the task. Those sessions aren't runs: they don't count against the attempts or the caps, and Fix PRs does not see them
  (it may start an attempt of its own on the branch while one is at work).
- **Resolving threads it fixed** (switch `resolveThreads`, on by default). The poll reads no bodies, so with no agent
  a candidate keyed `fix:resolve:<linkId>:<headOid>:<hash of thread@newest comment ids>` (`resolveDedupeKey`,
  `startsNoAgent`) picks the snapshot's unresolved threads the account can resolve and answered last (`ownLast`), but
  not one whose newest comment is in one of Autopilot's own reviews (a point it just raised, not a reply). The
  action reads them fresh with `reviewThreads` (`ReviewThreadDetail`: the newest comment's body, and the PR's newest 100
  commits) and resolves each whose newest comment is Autopilot's reply saying `fixed in <sha>` (`reply: "fixed"`,
  `parseAutopilotReply`, lenient enough for replies written before the format was fixed) with that sha prefixing one
  of the commits. The others (declined, the user's own words, Autopilot's review comment) go on the run's
  `output.settled` as `thread@newestCommentId` and aren't read again until someone comments; one whose commit isn't on
  the PR is read again after the next push. A thread GitHub refuses to resolve flags the run under Needs attention;
  the ones that did resolve drop out of the next poll, so the refused ones form a new set and are tried once more. It doesn't wait for a fix or review of the PR to finish, isn't an attempt
  and isn't counted as an agent run (`FIX_RESOLVE_KEY_PREFIX` is left out of the caps like the give-ups). The fix
  prompt tells the agent not to resolve threads itself; with the switch off it says the reviewer does.
- **Limits.** At most 2 attempts per head commit (`ATTEMPTS_PER_HEAD`), counting every attempt that wasn't skipped or
  conflict-only (below), and per PR as many as each budget allows (`FixBudget`; `attemptBudgets` reads an attempt's
  budgets back from its key): `review` (`attempts`, default 3) for Autopilot's review and failing checks, `comments`
  (`commentAttempts`, default 5) for other people's comments and requests for changes, and `conflicts` (below). An
  attempt given triggers of both uses one of each. A colleague's review bot thus can't use up the attempts Autopilot's own loop needs, nor
  the other way round. When a budget is used up, a gave-up run `fix:gave_up:<linkId>:review` or `:comments` gives up
  on that budget's triggers and the others still go ahead (a conflict that came with them becomes a conflict-only
  attempt); past the per-head limit, `fix:gave_up:<linkId>:<headOid>`. Each ends flagged "Autopilot gave up on PR #N:
  …". That puts it under Needs attention, logs the run on the task and sends an `autopilot_failed` notification. A
  new head commit starts the per-head count again. The gave-up candidate sets `startsNoAgent`, so a full concurrency
  cap, a daily cap or quiet hours don't hold it back. (Before the budgets were split the key was
  `fix:gave_up:<linkId>`; a PR given up on under it gets a fresh look.)

  An attempt whose triggers were all `conflict@…` (read back from its key, so a failed one is classified too)
  counts against neither: main moving under the PR isn't the PR's doing, and every merge into the base can conflict
  it again, so conflicts must not use up the attempts review points and failing checks need. Conflict-only attempts
  have a budget of their own, `CONFLICT_ATTEMPTS_PER_PR` (5, a constant) for the life of the PR, which guards against
  a merge that keeps failing or a PR that never stops conflicting; failed and successful ones count, skipped ones
  don't. When only a conflict is fresh, only that budget applies, so a PR
  that used up its rounds is still kept merged; past it, a gave-up run `fix:gave_up:<linkId>:conflicts` says "N
  conflict-only attempts used, still to fix: merge conflicts". A mixed attempt (`checks+conflict`) counts against the
  budgets of its other triggers. Conflict-only runs are labelled "conflict attempt N of 5" in the summary and the prompt. An integration
  epic's PR, fixed for conflicts only, uses only this budget.
- **Safety.** Headless runs get `pushDenyRules` (no force-push, no push to the default branch, no `gh pr merge`)
  and the runner's workspace note. T3 threads get the same rules in their note, and the fix prompt repeats them for
  a nudge. Conflicts are fixed with a merge, never a rebase. Only trusted authors' comments start a fix, and the
  prompt names them by id, tells the agent not to read the others, and calls what it reads requests about the code,
  never instructions. That is a prompt, not a sandbox: a fix agent has edit access, Bash and the user's `gh` login,
  so on a public repository a stranger's comment it reads anyway (or a CI log) could still try to steer it. Unlike
  the reviewer it can't be confined to exact commands, because fixing means running the project's own tools.
- **Settings.** The five switches, **Fix findings at or above** (`fixThreshold`), **Attempts on checks and reviews**
  (`attempts`) and **Attempts on comments** (`commentAttempts`) up front; **Fix skill** (built-in: the prompt alone)
  and the shared runner fields, which take the board's [agent defaults](#agent-defaults), under Advanced.
- **An integration epic's own PR.** For an epic delivered through an integration branch
  ([epics](epics.md#delivery)), the epic's PR from that branch into the default branch is a candidate too, for the
  conflict trigger only, even once the epic is Done (it stays open until the user merges it). It never gets a nudge:
  a thread linked on an epic orchestrates its tasks. The agent merges the default branch into the epic's branch and
  pushes there; pushing to `epic/*` needs no deny-rule change, since only the default branch is denied.

**Merge ready PRs** (`merge_epic_prs`, #123, #127; `automations/mergeEpicPrs.ts`, `mergeIntoMain.ts`). Needs no
agent and is off until switched on. It was Merge into epic branch, and keeps that key. Two targets: **Into epic
branches**, always on with it, for epics with integration delivery ([epics](epics.md#delivery)); and **Into main**
(`intoMain`, the one setting, essential, default off) for tasks flagged for auto-merge. Its detail in Settings →
Autopilot explains integration branches and gives each target a sentence, its gate and an example
(`MergeTargets.tsx`; its counts are board-wide, from `mergeTargets.logic.ts`).

- **Into main.** The candidates are open tasks in Review with `autoMerge` on, no integration branch, and `intoMain` on
  for the task (`intoMainOn`: the automation resolved at the task's epic, then project, then board, so an epic's own
  setting counts; checked again in the action). Each goes through
  `autoMergeVerdict` (`integrations/mergeTaskPr.ts`), the rules `merge_task_pr` refuses by: the task's one unfinished
  PR (unpolled ones count), not from a fork, passing `notMergeable` against its own base, no required approval still
  missing, and an account that can merge. `ready` makes a merge candidate `main:<linkId>:<headOid>` (retries
  `:<n>`, up to `MAIN_MERGE_ATTEMPTS`, 3, as for the epic merges below); `wait` makes nothing; `yours` (an approval
  GitHub requires, two open PRs, a fork, an account that can't merge) makes one skipped, flagged notice per PR head
  and reason (`main-hold:<linkId>:<headOid>:<hash>`), "Ready to merge into main, but Autopilot won't merge #N by
  itself: …". **One at a time per repository:** at most one merge candidate per `host/repo` per pass, in order (a
  task blocked by another flagged task after it, then by number), none while a run of this automation on a
  default-branch task of that repository is queued or running, and none for a PR whose link was last read
  (`syncedAt`) before the latest merge into its base that the board saw in the project (`PrChanges.merged` of any
  merged PR link there), so a PR the merge left conflicting waits for its next read. The action checks the verdict
  again at the same link and head, then calls `ctx.gitHosts.mergeAutoMergeTask`, which runs `mergeTaskPr` itself with
  `expectedHeadOid` (the flag and gate again, then `mergeIntoDefaultBranch`: `checkAutopilotMergeTarget` with
  `into: "default"`, the host's fresh merge state, the head). Its note on the task says "with Autopilot's Merge ready
  PRs". Then it rereads (`rereadPr`, the poller's `reread`) the repository's other open PRs of flagged tasks. A
  refusal from `mergeTaskPr` (something changed since the re-check) skips as a re-check; a race, "try again in a
  minute" or a network error retries; anything else ends "Ready to merge into main: … Merge it yourself." flagged;
  `MergeTargetError` fails the run, flagged.

- **Into epic branches: merging.** A task's PR is merged into its epic's branch when `notMergeable` (`autopilot/mergeGate.ts`, shared
  with [`merge_task_pr`](github-prs.md#merge_task_pr)) finds nothing in the way: the task
  is in Review; the PR is open (not a draft), from origin, with the epic's branch as its base (`PrSnapshot.baseRef`,
  `baseRefName` in the poll) and a head commit; the local review isn't going (`reviewIsInProgress`) and left no
  blocking or major finding open; no Review PRs or Fix PRs run of the task is queued or running; when Review PRs is
  on for the task, its review of the current head (`currentPrReview`) has nothing actionable (a verdict Review PRs
  carried across a base merge counts, so a PR that only merged the epic's branch in after its last round still
  merges; one whose own code changed after it waits, and Review PRs' run says why under Needs attention); no reviewer
  requested
  changes on GitHub; checks pass, or none has reported for `NO_CHECKS_WAIT_MS` (10 minutes) since the board first saw
  the head (`PrChanges.newHead`, else the link's creation: GitHub reports no checks for a moment after a push); and
  GitHub says it merges cleanly and isn't blocked on a check or rule (only a missing review is left to GitHub). The dedupe key is `merge:<linkId>:<headOid>`. The action re-checks all
  of it, then calls `ctx.gitHosts.mergeIntoEpicBranch` (`integrations/prMerge.ts`): a fresh read (the host's `mergeTarget`) of the PR and the repository's default
  branch, `checkAutopilotMergeTarget` (refuses the default branch, a base that isn't an `epic/` branch, and a PR
  retargeted since the check, with `MergeTargetError`), and `mergePullRequest` at `expectedHeadOid`. The method comes from the repository's `mergeCommitAllowed`,
  `squashMergeAllowed` and `rebaseMergeAllowed` as that same read says now, not the snapshot's `mergeMethods`, which
  may be stale: `epicMergeMethods` orders them merge, squash, rebase (a merge commit keeps each task's commits), and
  when GitHub refuses one as "not allowed" (a ruleset on `epic/*`, say) the next is tried in the same call. A
  repository that allows none fails with a VALIDATION error. The result names the method and the run summary says it
  ("Merged PR #45 into epic/… (squash)"). The trade-off: a squash can conflict for a task branch built on another
  task's unmerged branch, which is accepted because tasks normally start from the epic's branch once their blockers
  are Done. A run that ended "Merge it yourself" is settled for that head (`mergeRuns`) and isn't reconsidered by a
  fix or a settings change: use `retry_autopilot_run` or push to the PR.
  The refreshed snapshot says merged, which moves the task to Done (`completeIfPrsDone`), so the unblocked notification
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
  merge). Its title is set only then, so a rename by hand sticks, and it follows `epicPrTitle`: when any merged task PR
  (the title on its link's snapshot) is a Conventional Commits header, so is the epic's, because the repo's
  commitlint would otherwise fail `Epic #N: …`. The type is `feat` if any is a `feat`, else `fix` if any is a `fix`,
  else the most common (ties go to the first of the epic's tasks); a scope only when every conventional one shares it; `!` if any
  has it. The subject is the epic's title, whitespace collapsed, without a trailing period and with the first word
  lowercased (`GitHub sync` becomes `github sync`, because commitlint's `subject-case` rejects a capital first
  character), cut to 100 characters. Only config-conventional's types count as conventional, and an epic title that is
  already a header keeps its type and scope. It carries no `#N`, which a squash commit
  would turn into a link to the repo's issue #N; the body names the epic. With no conventional task PR the title
  stays `Epic #N: <title>`. That PR merging is what finishes the epic: the board sees it through the link and the epic goes from Review to
  Done once its tasks are Done too ([epics](epics.md#delivery)). Then it keeps the PR's description, `epicPrBody` (each task with
  its state, its PRs into the branch, its latest Autopilot review counts and its local review), current: the key
  `epic-pr-body:<linkId>:<hash of the body>` changes exactly when the body does, so nothing in it is a time. A closed
  epic PR is left alone. Nothing in Autopilot merges it.

**Improve automations** (`improve_automations`, #133; `automations/improveAutomations.ts`). Needs an agent, is in the
Upkeep group and is off until switched on. A weekly (`weekday`, `time`) task-less headless agent per project that audits
recent runs, failures and review rounds and writes at most `maxSuggestions` Suggestions through `suggest_change`; the
design, tools and cap are in [suggestions.md](suggestions.md#the-improve-automation). Its `improve` operation defaults to
the Deep tier.

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
  for any task), `retry_autopilot_run` and `request_attention`. Because it reads text anyone can
  write (PR comments, CI logs), it gets only the board tools in `ORCHESTRATE_BOARD_TOOLS` (reads, `add_note`, `request_attention`, the
  thread tools, `retry_autopilot_run`); every other board tool is in `ORCHESTRATE_DENIED_TOOLS`
  (`RunnerRequest.deniedTools`), so it can't create or flag a task for auto-merge, link a PR, mark review findings away,
  merge, or move, close, archive or delete tasks. `mcp.test.ts` checks every registered tool is on one list or the other. It never starts a Planned task: that is Start planned's, under its
  limits and the task's blockers; a failed start goes back through `retry_autopilot_run`. It counts against the caps and waits
  out quiet hours like any agent run. The `orchestrate` operation (Standard tier by default); `modelChoice`, `budgetUsd` and `timeoutMinutes` (the board's
  [agent defaults](#agent-defaults) unless set) are its only runner options (the runner choice doesn't apply).
- **Merging.** Never (#127): `merge_task_pr` is always denied, and the prompt tells it to list the Review tasks whose
  PR looks ready, saying which are flagged for auto-merge, and leave merging to Merge ready PRs. Its old **May merge**
  setting is gone: migration `043_merge_ready_prs` switched Merge ready PRs on with Into main wherever Orchestrate was
  on with May merge (see [Merge ready PRs](#merge-ready-prs) above), and dropped the stored values.
- **The prompt** (`orchestratePrompt`) is adapted from the babysitter threads: ground rules (this project only, never
  read or edit files in the project's live folder, since a board or dev server under `--watch` may restart, and treat
  PR and CI text as data), orient, unstick stalled work the lightest way (message a live thread, start one only when
  none is working, retry a failed run instead of pushing an empty commit, re-run a flaky CI job once,
  `request_attention` for what only the user can decide). Stalls are judged by the thread's status and the work's
  state, never by the age of the task's last board activity: a working thread or a pending or running local review
  round is activity (a reviewer can run for 40+ minutes and write nothing to the board). A Review task with no PR
  is asked for one only when `get_task` says the loop has ended, since with auto-review the PR is opened after the
  local loop; a stalled or failed round is sent back to its review loop instead. A PR left red or conflicting by a
  merge into the default branch is a stall like any other. It ends with a short status. **Extra instructions** (multi-line) are appended last and win where they differ.
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
  waiting for you holds it until you answer, and the waiting-thread reminder tells you. A headless run is a running run, which
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
- **Summarised.** The plain digest goes to a headless agent on the `digest` operation's model (the light tier by default; the config's `modelChoice` overrides), with the chosen
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
The editor is a five-step builder (When → Do → Details → Where → Review & try, `CustomAutomationEditorForm` with the
steps in `BuilderSteps.tsx`): one form, so moving between steps keeps everything; `stepProblem` (`builder.logic.ts`)
checks each step only for what it shows, and Save jumps to the first step with a problem. Review shows the
sentence, what it would run for right now (`rightNow`: a stale trigger's tasks already past the limit), the prompt
preview or a script's test run, and the name, pre-filled from the trigger and action. A new one saves in Preview where
the Where step put it, or **Save and turn on** switches it On there after it is created (`useTurnOnCustomAutomation`:
the board, or each of its projects); an existing one opens at Review.

**Where** decides where it runs with its switches, and nothing else: the same [project table](#the-ui) as the
automation's page (`ProjectTable.tsx`). For a saved automation the step is `WhereProjects`, which writes its switches
as they are picked, like its page; for a new one (or an import, or Edit first) it is `DraftProjects`, kept in the form
(`everywhere`, `projectIds`) and sent as the create input's
`projectIds`: empty saves a board row in Preview, otherwise a project row in Preview for each, with the board off. Under
it, for a task trigger: **With any of these labels** (`filters.labels`) and a **Tasks in epics** switch
(`filters.epicTasks`, default on). Off, a task in an epic is skipped unless that epic has a setting of its own for the
automation (`epicsWithOwnSetting`, passed to `customTaskMatches`), so the epic popover still switches one epic on. A
schedule has no task, so neither shows and the definition can't carry them (`checkCustomDefinition`).

**The project and epic filters became switches** (`049_custom_filters_to_scopes`), so one place decides where it runs
and no stored automation runs anywhere new or stops anywhere it ran. A non-empty `projectIds` filter becomes Only in
those projects: each keeps the state it had (its own row, or the board's), the board goes off, and the projects left
out and their epics' rows go to Inherit. An `epicId` filter becomes that epic's own row at the state the epic had (off
when its project was off or left out), every other row of the automation goes to Inherit, and Tasks in epics turns off.
Rows keep their config and last on-mode. Since Tasks in epics replaced the epic filter, it counts as where it runs: an
agent's change (`replaces`, `applyDraft` and `proposedDefinition`) and a `PATCH` whose filters leave it out keep the
automation's own. Details for a
command ("Which command?") or a script ("The script") has a small amber **Runs as you** pill by its heading
(`RunsAsYouBadge` in `ScriptWarning.tsx`) instead of an alert: its card opens on hover, on click or tap, and on
keyboard focus, and Esc closes it (it stays closed until focus leaves the pill). It says the code runs on this machine
as the user, with their logins, can do anything they can in the project's folder, and that text from GitHub can come
from anyone who can comment; a command's adds the Windows advice (let the program read the variable itself, since
PowerShell doesn't escape quotes and npm and pnpm hand arguments to cmd.exe). Code someone else wrote keeps the full
`ScriptWarning`: the import page, an agent's draft or change, and the script confirmation.
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
  - `armed_at`: set at creation and when the trigger, the filters or the [variables](#variables-and-the-repository-url) the action needs change (which also clears the times below);
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
  It goes to `ctx.runner.start` with the action's `model` as its `modelChoice` and the `customTask` operation (see [Models](#models)) and, with `onPrBranch`, `workspace.branch`
  set to the PR's head branch. Its config is the shared runner options, per scope. On a schedule there is no task:
  the prompt's footer names the project and its folder instead (`customAgentPrompt` with a null task), the run has no
  `taskId`, and the runner runs it headless in an empty temp folder through `startDetached`, as it does the digest
  (never in the project's checkout, which the board may be running from, so the runner option is ignored: it is always
  headless). It has the usual edit access and the board's tools, and `repo` (the project's folder) gives it the
  default-branch push guard and the safety note a worktree run gets; the prompt names the folder as the live checkout to
  read from, not edit (advisory only: the run has edit access and Bash, and only pushes are denied; a project with no
  folder gets the safety note without a branch name and the generic denials). The model is the automation's Model setting, else the action's `model`, else the board's for `customDetached`, else the light tier ([Models](#models)). One at a time per
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
  (`customScriptContext`: `automation`, `project` with `id`, `name`, `path` and `repoUrl`, `inputs`, `vars`, `task` and `pr`, null when the
  trigger has none), with non-ASCII characters escaped so every runtime reads it the same. The result keeps `stdout`
  (the first `STDOUT_MAX` characters) and `stderr` apart for a caller that parses what the script printed; the run
  gets the interleaved tail and exit code as for a shell action. A `{{…}}` in a body that names a placeholder is
  refused on save, as in a command (other `{{…}}` text is left alone). Known limits: a PowerShell script gets the shell
  action's two-line prelude (progress and encoding) and exit handling around it, so it can't open with `param(...)`,
  `[CmdletBinding()]` or `using`; it runs with `-File`, which an execution-policy Group Policy can block, unlike a
  shell action's `-EncodedCommand`; and on Windows only `.exe` programs are found on the PATH (not `.cmd` shims).
  The spawn, output buffering and timeout kill are shared with shell actions in `integrations/captureProcess.ts`.
  The storage is the same `action_json` column, so no migration.
- **REST only**: `GET/POST /api/autopilot/custom`, `PATCH/DELETE /api/autopilot/custom/:id`. Over MCP an agent can
  only [draft](#drafts) one, which the user imports. A write whose
  action is (or stays) a shell command, a script or an agent with a check script needs an `Origin` header, which browsers send and the guard checks is the
  board's; agents and scripts usually send none. It's a guard rail against an agent setting up a command by
  accident, not a boundary. Every change publishes `autopilot.changed`.
- **UI**: listed under **Yours** in Settings → Autopilot → Automations (`AutomationsSplit`), with the editor
  `CustomAutomationEditorForm` as a sub-page, `/settings/autopilot/custom/<id>`. The preview runs the same contracts helpers as the server
  on the newest board task the filters let through, in a project it runs in (`customAutomations.logic.ts`). Switches are the usual rows and
  lane popover entries, since those list the catalogue.

#### Inputs and required tool slots

Every action carries `inputs`, and an agent action `slots` too (`AutomationInput`, `AutomationSlot` in contracts), both
empty by default, so rows saved before them still parse (#238 added inputs to shell and script actions).

- **Inputs** are `{name, label, type: text | number | boolean, default, value}`. A prompt reads `{{inputs.<name>}}`
  (`renderCustomPrompt` with `CustomValues.inputs`), for declared names only; every action kind, checks included, also
  gets each as `<PREFIX>_INPUT_<NAME>` (`inputEnvName`) and in stdin's `inputs`. A value is data: it isn't filled in
  again, so one that looks like `{{task.title}}` stays as written. `checkCustomDefinition` refuses an undeclared
  `{{inputs.x}}`, repeated names and a value that doesn't fit its type (`inputValueProblem`), for every kind.
- **Slots** are `{name, label, description, tools}`; `tools` follow the `allowedTools` rules. `customAllowedTools` is
  the allowed tools and every slot's tools together, which is what `act` passes as `RunnerRequest.tools` and what the
  dry-run note lists. `customAgentPrompt` adds a "Tools to use for this" line per *filled* slot after the prompt.
- **Waiting for the slot's server.** `claude -p` connects MCP servers in the background, so a slow server's tools may not
  be there on the agent's first turn. When `RunnerRequest.tools` name an `mcp__<server>` other than the board's, and the
  run gets the user's servers (not `access: "none"`, nor read-only and untrusted, which use `--strict-mcp-config`), the
  runner adds `MCP_CONNECTION_NONBLOCKING=false` to the agent's environment beside the push guard's (`mcpWaitEnv`), so
  Claude Code connects them first. Such a run waits for every user server, up to Claude Code's MCP timeout, within the
  run's own timeout; runs that need only the board's server don't wait. A run with [run tools](#run-tools) waits too,
  locked down or not: its only way to read its target is that server, and a locked-down run has no ToolSearch to find
  a late one. Same cause as ticket imports ([issue-import.md](issue-import.md#the-job)).
- **Blocked.** While a slot has no tools, `customBlockedReason` gives "Won't work until you fill in: Jira tools". The
  catalogue entry carries it as `Automation.blocked` (`AutopilotAutomation.blocked` in the API): `setScope` refuses
  `mode: "on"` with that message (`VALIDATION`), the UI shows it in orange and disables On, and the automation's `check`
  finds nothing meanwhile, so emptying a slot of one that is already on stops it rather than starting an agent without
  its tools. Inherit and Off are unaffected.

#### Variables and the repository URL

Named values an automation reads instead of branching on the project (#238): a Jira key, a team, a board id.
`AutomationVariable` is `{name, value}` (names follow the input rule, values are plain text up to 2,000 characters, at
most 50 per list; `automationVariables.ts` in contracts).

- **Where they live.** The board's are the `automationVariables` setting (`PATCH /api/settings`, edited under **Settings →
  Autopilot → Limits & safety → Variables**); a project's overrides are `projects.variables_json` (migration 036,
  `PATCH /api/projects/:id` with `variables`, edited under the project's Automations section). `effectiveVariables` lays
  the project's over the board's. Both writes publish `autopilot.changed`, since a row's "Needs" line depends on them.
- **How they are read.** A prompt reads `{{vars.<name>}}`; a command, script or check reads `<PREFIX>_VAR_<NAME>`
  (`variableEnvName`) or stdin's `vars`. Like inputs they are filled in once and never read again for placeholders, and
  a `{{vars.x}}` in a command or script body is refused like any placeholder.
- **A missing value skips the project.** `variablesNamedBy(action)` lists the names an action needs: the prompt's
  `{{vars.x}}`, and, best effort, `vars.x`, `vars["x"]` (also `["vars"]["x"]`) and `<PREFIX>_VAR_X` in a check, script or
  command. A method call such as `vars.get("x")` reads one as optional and isn't counted, and a name built at run time
  isn't seen. A variable has a value when it is set and not blank, so a project can opt out by overriding one with
  nothing. The custom automation's `check` drops every project missing one (`missingVariables`): no candidate, no run,
  no check script. What happened meanwhile is dropped, not held: when a settings or project write leaves a project with
  every variable an automation needs where it lacked one before, `rearmWhereFilled` (wrapped around both updates in
  `createServices`) re-arms the automation there (`rearm`, with the project's epics that have an arming of their own),
  so it starts from that moment rather than firing every move, PR event or missed slot of the gap. In a dry run it records one skipped run per project and set of names (`needs:<project>:<names>`)
  saying "Needs `jira_key` in billing". The catalogue entry has `Automation.needs(projects)`, which the overview calls
  with the projects the automation is on in (directly or through an epic) to give `AutopilotAutomation.needs`, "Needs
  `jira_key` in: billing", shown in orange on its rows (`NeedsVariablesWarning`). Unlike `blocked`, it doesn't stop the
  automation being switched on: the other projects still run it.
- **Repository URL.** `{{project.repo_url}}`, `<PREFIX>_PROJECT_REPO_URL` and stdin's `project.repoUrl` hold
  `https://<host>/<repo>` from the project folder's `origin` (`repoWebUrl` over `remoteRepo` in
  `integrations/gitRemote.ts`, credentials dropped). `createRepoUrls` runs `git remote get-url origin` through the
  services' `runGit`, cached per folder for 10 minutes, and gives "" when there is no folder, no repository or no
  origin; it never blocks a run. `check` resolves it for the projects in scope (so previews show it) and `act` again for
  its own project, as `CustomScope.repoUrl`, the fifth argument of `customValues` beside `vars`. The test run gets both.
- **The editor and import page** list the variables the action reads with the projects that have no value for each
  (`variableNeeds` in `variables.logic.ts`). The preview fills the sample project's variables and shows the repository
  URL as a placeholder (the browser can't read `origin`). A bundle never carries values (they are the sharer's); the
  import page derives the names from the file's action.
- **Not secrets.** Values show in dry runs, previews, run details and backups, so the editors say to keep tokens out.

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
  records as a failed run with the error, the tail of what it printed to stderr (or, with nothing there, of all its output) and the exit code. No task, so nothing is flagged; the
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
- **Dry run and Preview.** The check really runs (the preview says so), and each new item is recorded as a skipped run whose
  preview is its agent's filled prompt; a failed check records a skipped run with the failure.
- **Sharing and the editor.** The bundle carries the check with the action (a version 2 file, imported only with the
  script confirmation; see [Sharing automations](#sharing-automations)), and the import page shows it and says how its
  items' agents run.
- **In the editor.** A schedule's agent form has **Check first with a script**: a switch that reveals the
  [script editor](#the-script-editor), the untrusted-items switch (with a warning when it is turned off) and `ScriptWarning`
  (the check has no heading of its own for the Runs as you badge).
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
- **Load from file** (the file's extension picks the language; a file over `CUSTOM_SCRIPT_MAX` characters is refused) and **Copy**.
- A **starter** per language and role (`scriptStarter`): it shows how to read the JSON context on stdin and, for a check, how
  to print JSON lines. A new script starts from it, and changing the language swaps it for the new language's only while
  the text is still some starter (`withLanguage`), so nothing the user wrote is lost.
- The timeout, and the **test run** below.
- **Insert chips** over the code (`InsertChips`, `insertChips.logic.ts`), coloured by group (`sdkStyle.tsx`): project,
  task and PR (left out for a schedule, which has no task), automation, the variables set on the board or any project,
  and the automation's inputs. A chip puts the value's read at the cursor. There is one convention, shared by the
  starters, the examples and the authoring skill: a script parses the stdin JSON into `ctx` and reads from it
  (`ctx.project.name`, `ctx['project']['name']`, `$ctx.project.name`); only sh and a command read the environment
  (`"$X"`), since they can't parse JSON. The same chips sit over a command and an agent's prompt (`{{…}}` placeholders,
  plus the item for a check's agent), in place of hints that listed every name.
- A **status line** under the code and under a command (`SdkStatusBar`): how values arrive, exit 0 succeeds, the
  output kept, and two links. **Examples** opens the snippets for the language and role (`AUTOMATION_SDK_SNIPPETS`)
  to copy or insert at the cursor. **Full reference** opens a side sheet with every value by stdin path or environment
  variable (`AUTOMATION_SDK_SCOPE`), the rules as titled cards (`AUTOMATION_SDK_RULES`) and the examples.
  The text is in contracts (`automationSdk.ts`) so the authoring skill can quote it; a test checks that the snippets'
  variable reads are what `variablesNamedBy` finds. The starters read `project`, `vars` and `inputs` without naming a
  variable, so starting from one never makes an automation need one.

#### Test runs

`POST /api/autopilot/custom/test-script` (`TestScriptInput` → `TestScriptResult`; `services/testScript.ts`) runs a draft
script once, now, in the folder of a project the user picks, and returns the exit code, stdout and stderr (each cut to
`TEST_OUTPUT_MAX`), the duration and whether it timed out. **It is not a dry run**: the script executes with the same
interpreter, environment and stdin context a real run gets, so it can do whatever it does (approve a PR, push), and the
editor says so and asks for a second click ("Run it for real") naming the project. Nothing is saved or recorded: no run
row, no event.

- Inputs reach an action and a check alike, as in a real run, with the project's variables and repository URL. An **action** may be given a task (the form's sample task, or none) and then reads that task's values; a **check** has
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
`format: "<brand id>.automation"`, `version: 1`, `2` for a file that carries a script (`SCRIPT_BUNDLE_VERSION`), or `3`
(`AUTOMATION_BUNDLE_VERSION`) for one whose action reads a [variable](#variables-and-the-repository-url) or is a command
or script with inputs, so a board from before those says the file is newer instead of refusing it as invalid; a file
below 3 that declares inputs on a command or script is refused). It holds the name, description,
trigger, the filters' labels only, the action, the declared inputs of any action kind (`{name, label, type, default}`), an agent's declared slots (`{name, label, description}`) and
optionally the `skill` as `{name, body}`, and `filters.epicTasks` (missing reads as true). Not in it: where it runs,
arming, switches and slot tools, so the importer's own servers and projects are theirs to choose. `parseAutomationBundle` checks a file, telling one from a newer
`version` apart from a malformed one.

**Scripts** (a `script` action, or an agent's `check`; `actionScripts` lists them) are someone else's code run as the
importer, so they get more care. A file is written as version 2 only when it carries one and needs nothing of version 3
(`bundleVersionFor`), so every other file stays version 1 and a board from before scripts still reads it; a version 1 file that carries a
script is refused, since an older board would read it without the script. Language, body and timeout travel as they
are, the body held to `CUSTOM_SCRIPT_MAX` by the contract. Importing a file with a script needs `confirmScript: true` (the
service refuses with a reason otherwise, whoever calls it) and, like creating one, the board page's `Origin`
(`actionRunsCode`, in the route's guard, also covers a check script on create and patch). There is no MCP path that
writes one (an agent's [draft](#drafts) only reaches this import, from the board's page), and a suggestion (which can only change an agent's prompt) leaves the check as it was. Dump, restore and
the git backup keep the whole `action_json`, so a script comes back as written.

| Route                                  | Does                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /api/autopilot/custom/:id/export` | The bundle (`automationBundle`): inputs' current values as defaults, slots empty, and the action's skill read from the user's installed skills when it is there and fits `BUNDLE_SKILL_BODY_MAX` |
| `POST /api/autopilot/custom/import`    | Body `{bundle, inputs, slots, projectIds, installSkill, confirmScript}`; 201 `{automation, skill}`       |

`customAutomations.importBundle` parses the file again (a body that isn't one is `VALIDATION`), fills the inputs and
slots (`bundleToDefinition`; an input left out takes its default), starts it Only in `projectIds` when there are any (the
import screen's Where it runs, `DraftProjects`), gives it a free
name (`Name (2)`) and runs the usual definition check **before** writing anything, so a file that can't run leaves no
skill behind. The skill goes to `~/.claude/skills/<name>/SKILL.md` (`installSkill` in `skills.ts`) only when
`installSkill` is true; a name taken by any installed skill (folder or frontmatter name) becomes `<name>-2`, `-3`, with
the frontmatter name rewritten, and the automation names what was written. Without `installSkill` it names no skill. It
is saved like any new one, in Preview for the board (or those projects). As when creating one, a shell or script action needs the board page's
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
file in `AUTOMATION_EXAMPLES` (`automationExamples.ts`). The "Improve prompts and skills" example that was here is now the built-in
[Improve automations](suggestions.md#the-improve-automation); a copy someone imported is an ordinary custom automation and is unaffected.

**Review repo PRs** (#230), an example check script that commented on any repository PR, was retired by #21: Review
PRs' [other people's PRs](#other-peoples-prs) does it as a built-in, and an imported copy keeps working until deleted.

### Drafts

Agents can't save a custom automation, but they can write one for the user (#241): `draft_automation` (in
`mcp/tools/autopilot.ts`) keeps it as a draft, and only the user's import on the board's page saves it. The Origin guard
on the REST writes is unchanged, so this opens no path to setting up a command or script without the user.

- **The shape is a shared file's.** The tool takes `automation`, an `AutomationBundle` without `format` and `version`
  (they are filled in, at the newest version, so the agent needn't work out which), and a `note` to the user.
  `checkAutomationDraft` (`automationDrafts.ts` in contracts) parses it and runs what an import runs on it with the
  inputs at their defaults and the slots empty (labels, `checkCustomDefinition`), and lists **every** problem with
  where it is, so the agent can fix them all in one go; a newer `version` is told as such. Capped at 500,000
  characters of JSON and a 2,000-character note.
- **Stored apart.** `autopilot_drafts` (migration 037: id, `bundle_json`, note, `created_by`, `created_at`,
  `expires_at`) holds it for 14 days (`AUTOMATION_DRAFT_TTL_DAYS`), at most 20 at once (the oldest go). Expired ones
  are left out of reads and pruned on the next draft. Not in backups: it is a hand-off, not the user's data until it
  is imported.
- **What the agent is told.** The import page's URL (`automationDraftPath`, `/settings/autopilot/custom/import?draft=<id>`
  on the board's URL), the expiry, whether a script needs confirming (or, for a command, reading), the slots to fill and, per variable
  the action reads, the projects with no value for it, so the agent can tell the user. The result says nothing is set
  up until the user imports it, and that it then saves in Preview. Orchestrate's agent is denied the tool.
- **The user.** Each draft sends an `automation_draft` notification (task-less; the inbox opens Needs you in Settings → Autopilot).
  That section lists the drafts with **Review** and **Dismiss**. The import page with `?draft=` loads it
  (`GET /api/autopilot/drafts/:id`, NOT_FOUND once gone) into the same untrusted preview, script confirmation, inputs and
  slots as a file, under a banner naming who drafted it and their note, and sends `draftId` with the import, which
  deletes the draft once the automation is saved. **Dismiss draft** is `DELETE /api/autopilot/drafts/:id`. Every change
  publishes `autopilot.changed`.
- **Review, or Edit first.** The import page is the builder's review step for someone else's automation: the
  `formSentence` sentence, the read-first sections, **Saves in** Preview or On (On sets the board's mode after the
  import), and **Edit first**, which opens the builder (`CustomAutomationEditorForm`) at Details on `formFromBundle`
  with what was filled in. Saving there creates it over the ordinary route (Origin-guarded) and dismisses the draft;
  a skill the file carries isn't installed that way. Opened on a script (or, for a change, a changed one), the builder's
  `confirmScript` holds Save until the same "I've read it" switch is on, so editing first doesn't skip it.
- **Changes (`replaces`).** A draft can name the custom automation it is a new version of: `replaces` takes its id,
  `custom:<id>` key or exact name, resolved on drafting (a built-in's key or title is refused as VALIDATION, anything
  else unknown as NOT_FOUND) and stored as the id (`autopilot_drafts.replaces`, migration 044; no foreign key, so a
  draft whose automation was deleted says so when applied). Needs you shows it as **Change to <name>**
  (`AutopilotNeed.replaces`), and the page opens `AutomationChangeReview`: per field, a line diff of the current and
  proposed definition (`changeReview.logic.ts`), the agent's note as **Why**, and a warning for tools it adds.
  **Apply change** is `POST /api/autopilot/drafts/:id/apply` → `customAutomations.applyDraft`: the draft's definition
  with input values and slot tools kept by name (new ones from the request), the automation's own projects and epic,
  saved with `update`, so the id, switches and run history stay (a changed trigger, filters or variables re-arm it, as
  any edit does). A changed script needs `confirmScript`, checked in the service; the route holds a draft with code or
  a skill install to the board's Origin, as the import route does. **Keep current** dismisses the draft; **Edit first**
  opens the builder on the automation with the change filled in, and its **Save changes** dismisses the draft.

### Runners

An agent action calls `ctx.runner.start({ run, prompt, operation, options, … })` (`autopilot/runner.ts`); `operation` is what the run's model is resolved for ([Models](#models)). The engine
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
- **`label`** is what the run is, short, and leaves the task's number out: "Review PRs · PR #73 round 1",
  "Fix PRs · PR #73", "Start planned", "<custom name>", "Digest". Each automation supplies it, and the runner
  names the session with `autopilotSessionName(label, task)`. A run on a task is `#<n> <task title> · Autopilot:
  <label>` (the title cut to about 60 characters with `…`, the automation part never cut), the task first like a
  thread started by hand, so the useful part survives a truncated sidebar. A run with no task (a digest, Orchestrate,
  a scheduled or item-driven custom agent) is `Autopilot · <label>`, and `Autopilot session` without a label. That
  one name is the session link's label, `claude --name` and the T3 thread's title (`TaskThreadInput.title`, default
  the task's number and title). `isAutopilotSessionName` still recognises the old `Autopilot · ` prefix, so session
  links named before the change stay marked as Autopilot sessions.
- **`kind: "nudge"`** posts the prompt into the task's implementing T3 thread (`implementingThread`, see
  [agent-handoff.md](agent-handoff.md#follow-up-threads); `sendToThread`). It never starts a
  session, and fails when the task has no live thread.
- **`workspace.prBase`**: the branch the agent's PR goes to when it isn't the default branch (an integration
  epic's). The session starts from origin's copy of it (T3: `baseRef` with `startFromOrigin`; headless:
  `createWorktree` with `baseFromOrigin`), and both workspace notes say to open the PR against it with
  `gh pr create --base`.
- **`workspace`**: `{ baseRef }` starts a new branch from that ref (default: the default branch); `{ branch }`
  starts from an existing branch, such as a pull request's, and the agent pushes back to it. The default
  branch is refused either way, except for a read-only run, which can't push.
- **No task.** A run with no task (a digest's) is headless only: its CLI in an empty temporary folder that is
  removed afterwards, with no worktree and no session link. T3 Code and `nudge` fail for it.
- Headless only: **`access: "none"`** gives the agent no tools at all (no built-in tools, no MCP servers), for one that
  must work from its prompt alone.
- Headless only: **`access: "read-only"`** for agents that only read (a reviewer), **`tools`** to allow more
  (`Bash(gh pr review *)`), **`deniedTools`** to deny more (Orchestrate's `ORCHESTRATE_DENIED_TOOLS`), and **`outputSchema`** for a structured answer, returned as `output`. A T3 thread
  can't be held to these, so a request with any of them runs headless under Auto, and fails under T3 only.
  Also headless only: **`untrustedInput`** for a read-only agent that reads text anyone can write (no MCP servers or
  checkout settings, file tools limited to the worktree, only exact git commands), **`runTools`**, the board-served
  tools the run reads its target through ([Run tools](#run-tools)), and **`expectHead`**, the commit the worktree must be at, checked before the
  agent starts (`WorktreeHeadError`, with `moved` when the branch is ahead of it).

Every agent automation spreads the shared runner options into its config (`autopilot/runnerOptions.ts`:
`RUNNER_OPTION_SHAPE`, `RUNNER_FIELDS`, `RUNNER_DEFAULTS`). All but the model take the board's
[agent defaults](#agent-defaults) where no scope sets them; the defaults below are those defaults' own:

| Option           | Default | Meaning                                                                          |
| ---------------- | ------- | -------------------------------------------------------------------------------- |
| `runner`         | auto    | auto, t3 or headless                                                             |
| `budgetUsd`      | 5       | Headless: `--max-budget-usd`                                                     |
| `timeoutMinutes` | 60      | Headless: the agent, and everything it started, is killed after this long        |
| `modelChoice`    | inherit | The model runs start on: inherit, a tier, a custom model or a typed model ([Models](#models)) |
| `t3Access`       | default | T3: the most access a thread gets. Never more than T3's own default              |

**T3 thread.** `launchTaskThread` with the command id `autopilot-<runId>` (T3 de-duplicates by it), in work mode,
so the model is the run's model ([Models](#models)) when its T3 model is ready, else T3's default. The thread gets a new T3 worktree; for a
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

**Headless.** A CLI in a worktree of its own (`autopilot/worktrees.ts`): `claude -p` by default, or `codex exec` or
the Copilot CLI when the run's model says so ([Headless drivers](#headless-drivers)):

1. `git worktree add --no-track -b autopilot/<task#>-<run8> <data dir>/worktrees/<repo>/<task#>-<run8> <start>`,
   where `<start>` is the base ref, `origin/<default branch>` or `origin/<branch>`, after a best-effort fetch.
   The new branch tracks nothing, so a bare `git push` can't land on the branch it started from. A worktree
   folder that overlaps the project's checkout is refused. The worktree then gets its [push guard](#the-push-guard).
2. The board picks the session id and records it on the run, with the worktree, before the agent starts (Codex
   picks its own: it is recorded and linked as soon as its first JSONL event names it). It
   also links the session to the task as an `agent_session` link ([agent sessions](agent-sessions.md)) with the
   run's name as its label and the worktree as its folder, under the harness that ran it, so the card offers Open
   in terminal (`claude --resume <id>`, `codex resume <id>`, `copilot --resume=<id>`). Sessions are kept:
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
   a timeout fails the run. The CLI is each provider's path (`harnessCliSetting`, Settings → Agents → Providers), else
   its name on PATH.

#### Headless drivers

Each harness has a `HeadlessDriver` (`integrations/headlessAgent.ts` for Claude Code, `integrations/headlessDrivers.ts`
for the others): the argv, a parser that turns its output into an outcome, and what it can be held to.

| Capability                                        | Claude Code | Codex          | Copilot CLI |
| ------------------------------------------------- | ----------- | -------------- | ----------- |
| Structured output (`outputSchema`)                | yes         | yes            | no          |
| Isolated read-only run (`readOnly`)               | yes         | yes            | no          |
| Untrusted-input lockdown (`untrusted`)            | yes         | no, warns      | no          |
| No tools (`access: "none"`)                       | yes         | no             | no          |
| Extra tool rules (`tools`, `deniedTools`)         | yes         | no             | no          |
| Board-served [run tools](#run-tools) (`runTools`) | yes         | yes            | no          |
| Spending cap (`budgetUsd`) and cost               | yes         | no             | no          |
| Session id given up front                         | yes         | no             | yes         |

Each "yes" for Codex was checked against codex-cli 0.166.0; the findings are below. "No, warns": Codex has every other
part of the lockdown but can't confine its file reads, so an operation that reads text anyone can write runs on it only
when the user chose it, with a warning ([Warnings](#capability-warnings)).

- **Which one.** The provider the run's operation resolves to ([Models](#models)): the chosen model's preferred
  provider when it can do what the run needs, else the first in the user's Providers order that can. A run that needs
  what only Claude Code can do (a no-tools digest, tool rules, the full untrusted lockdown, or an editing run with no
  task, which has no worktree and so no push guard) runs on Claude Code, and its detail says why; with Claude Code not
  added, it fails with the reason instead. Codex also runs the structured operations on the user's own input (the
  [board reviewer](local-review.md#the-board-reviewer), the settings Ask) and, when the user chooses it, those that read
  text anyone can write (PR review, GitHub [issue import](issue-import.md)), with a [warning](#capability-warnings).
  The Copilot CLI runs only edit and plain read-only runs. Every operation goes through `headlessDriverFor`: the
  Autopilot runner, the board reviewer (`headlessReview.ts`), Ask (`settingsAsk.ts`) and issue import
  (`headlessImport.ts`, through `structuredRun.ts`).
- **Needs.** Each operation's needs are in `OPERATIONS` (contracts `operations.ts`): the board reviewer and Ask need
  `outputSchema` and `readOnly` (isolated read-only, for the user's own diff or question); PR review needs
  `outputSchema`, `untrusted` and `runTools`; issue import needs `outputSchema` and `untrusted` for a GitHub issue (its
  text is in the prompt) and `toolRules` on top for a ticket (`IMPORT_TICKET_NEEDS`: it reads through the user's own
  MCP servers). `checkNeeds(harness, needs)` sorts what a CLI lacks into *missing* (it can't run it) and *warned*.
- **Structured output on Codex:** `--output-schema <file>`. Checked on codex-cli 0.166.0: Codex sends the schema as an
  OpenAI strict response format and holds the answer to it (asked for an enum value outside the schema and extra
  fields, it returned a conforming object). Strict mode refuses a schema whose objects don't say
  `additionalProperties: false` (a 400 in `turn.failed`) and wants every property required, so `strictSchema()`
  (`integrations/strictSchema.ts`) closes every object and makes an optional field nullable, and `fromStrict()` drops
  the nulls the model then writes for them before the caller's zod schema reads it. `withDriverArgs` writes the
  converted schema to a temp folder outside the run's working folder and removes it when the run ends. The answer is
  the last `agent_message` item's text, parsed as JSON; one that isn't fails the run.
- **Isolated read-only on Codex** (`readOnly`, and every untrusted run): `--sandbox read-only --ignore-user-config
  --ignore-rules -c web_search="disabled" --disable apps`, plus `--ephemeral` for a run with nothing to resume (the
  board reviewer, Ask, import). Checked on codex-cli 0.166.0: the sandbox refused a write in the working folder
  ("Read-only file system", and `apply_patch` was rejected) and the shell had no network (`curl` couldn't resolve a
  host that the machine could). Two things sit outside the sandbox and are turned off: the model's hosted web search
  (`web__run`) and, once the shell is off, the hosted `codex_apps` connector. Claude Code's isolated read-only run is
  its reviewer's read-only tool list without the board, `--strict-mcp-config` and `--setting-sources user`.
- **Codex can't confine reads,** so it lacks `untrusted`. Its read-only sandbox read a file outside the working folder.
  `--disable shell_tool --disable unified_exec` does remove the shell, but the run keeps code-mode `exec`,
  `spawn_agent` subagents and `view_image`, several of the features involved are marked under development, and what
  the model lists as its tools changed from run to run, so no reliable confinement was found.
- **Codex:** `codex exec --json --skip-git-repo-check --sandbox danger-full-access [--model <m>] [-c
  model_reasoning_effort=<effort>] -` (read-only runs use `--sandbox read-only`), prompt on stdin. Checked against
  codex-cli 0.166.0 (recorded output is in `integrations/fixtures/codex/`). Edit runs leave Codex's sandbox off. Its
  `workspace-write` sandbox does work for git when both the worktree's git dir and the repository's common git dir are
  added as writable roots (`-c sandbox_workspace_write.writable_roots=[…]`, with `-c
  sandbox_workspace_write.network_access=true`): `add`, `commit` (the repository's hooks run) and an HTTPS `push` to
  GitHub all succeeded. Without the roots `git add` fails (`Unable to create '…/index.lock': Read-only file system`).
  But only the worktree, those roots and temp folders are writable then; `mkdir ~/.cache/x` and
  `mkdir ~/.local/share/x` fail with `Read-only file system`, which is where a package manager keeps its store and
  caches, so an edit run that installs or tests would fail. SSH pushes weren't tried. So the access is the one a Claude
  Code edit run has (Bash allowed outright); the push guard still applies, and the guard refused a force-push, a branch
  delete and a push to the default branch from a real Codex run. The effort is the config key (`codex exec` has no
  flag for it): the model's Codex effort (`none` to `ultra`, as Codex's `model/list` names them) goes through when the profile sets one;
  Codex's own session file confirmed the model, effort and sandbox of a run. A bad value isn't refused by the CLI but by
  the API (the run ends with `error` and `turn.failed`). The parser reads `thread.started` (the session id), the last
  completed `agent_message` item (the answer) and `turn.failed` or `error`; a run with no `turn.completed` failed. A
  refusal from the API arrives as its response body in `message`, and the parser shows the error inside it. Items of
  type `error` are warnings (an unknown model's metadata) and are ignored. The agent's shell has `CODEX_THREAD_ID`,
  the same id as `thread.started`'s.
- **Copilot CLI:** `copilot --output-format json --no-ask-user --session-id <id> --allow-tool write --allow-tool shell
  --allow-tool <board> --deny-tool 'shell(gh pr merge)' [--model <m>] [--name <name>]`, prompt on stdin. Read-only
  runs allow only `git status`, `log`, `diff`, `show` and `rev-parse` and deny `write`. The parser takes the last
  `assistant.message` or `session.task_complete` summary as the answer, and `session.error` or a printed `Error:`
  line as the failure. Copilot's rules match a command's first-level subcommand (`git push`), so they can refuse
  merging but not a force-push alone: the push guard does that.
- **Run tools:** Claude Code gets `--mcp-config <file>` naming only the run's server (`aboard-run`, `RUN_SERVER_NAME`)
  with its token in a header, and `mcp__<server>` allowed; a locked-down run keeps `--strict-mcp-config`, any other
  keeps the user's servers too. Codex gets `--ignore-user-config -c mcp_servers.<server>.url="…" -c
  mcp_servers.<server>.bearer_token_env_var="<RUN_TOKEN_ENV>" -c
  mcp_servers.<server>.default_tools_approval_mode="approve"`, with the token in that variable. The approval mode
  matters in the read-only sandbox: there Codex asks before calling a tool without `readOnlyHint`, and with nobody to
  answer the call fails ("MCP tool call requires approval, but approval policy is never"; a tool with the hint ran,
  checked on 0.166.0). The run tools all carry the hint, and the endpoint serves only the tools the run may use. Checked on
  codex-cli 0.166.0: a `codex exec` pointed at a run endpoint called `pr_overview` and `pr_diff` (`mcp_tool_call`
  items, no approval asked) and answered from the diff; and with `--ignore-user-config` a stdio server named in a
  `config.toml` was not started, while without it it was. The login under `CODEX_HOME` still applies. The Copilot
  CLI can't yet be held to one given MCP server, so it lacks the capability.
- **Cost:** Codex and Copilot report none and take no cap. Only `timeoutMinutes` stops them, the run records no cost,
  and the spend cap doesn't count them.

#### Capability warnings

A provider that has the isolated read-only run but not the untrusted lockdown (Codex) meets `untrusted` with a
warning rather than not at all (`checkNeeds` puts it under `warned`, `needsWarning` gives the text: it can't confine
its file reads, so text anyone can write could make it leak local files into what it returns, such as a review the
board then posts):

- **Never a fallback.** `resolveOperationModel` falls back only to providers with nothing missing and nothing warned.
  With none, it refuses, and says which provider could run it with a warning if the user chose it.
- **Only when chosen for the operation:** a typed model on that provider, at any level, or a tier or custom model
  whose preferred provider it is, set for this operation (on the task, the project, the automation or the Models
  page). A tier that is only the operation's default, or the task's own model, was chosen for other work: its
  preferred provider is passed over like any other with a warning, and the note says why.
- **Said where it runs:** `ResolvedModel.warning`, also appended to `note`, so a run's detail repeats it; an import
  logs it. The [picker](#models) shows the provider with a warning dot and its tooltip, the warning under its list, and
  ", with a warning" on a tier that resolves to it; a provider with a need missing stays greyed out with the reason.

#### Run tools

A headless run that reads a git host gets that host's reads as tools the board serves for it alone, instead of `gh`
and tool rules only Claude Code can follow ([ADR 0013](../decisions/0013-board-served-run-tools.md)):

- **The scope.** `RunnerRequest.runTools` is `{toolSet, target}` (`mcp/runTokens.ts`): one tool set per kind of
  operation and the one thing it reads. The sets are `prReview` (a task's PR) and `repoPrReview` (another person's
  PR); the target is a PR.
- **The token.** `runOnDriver` mints one before the agent starts (`RunTokens.mint`, through the runner's `runTools`
  dep): 32 random bytes, kept in memory by its SHA-256 only, alive for the run's timeout plus five minutes and never
  more than a day (`RUN_TOKEN_MAX_TTL_MS`). It writes the MCP config (`runToolsMcpConfig`) to a temp folder of its own
  outside the worktree, mode 0600, and in a `finally` revokes the token and removes the folder, however the run
  ended. Only a driver that reads the token from its environment (`runTokenFromEnv`: Codex) gets it there, in
  `RUN_TOKEN_ENV`. The token is never logged, never in a URL, never on a command line.
- **The endpoint.** `POST /mcp/run` with `Authorization: Bearer <run token>` (`mcp/runTools.ts`): stateless
  streamable HTTP like `/mcp`, but each request gets a server with only its grant's tools. A missing, unknown,
  revoked or expired token gets 401 without the token in the answer; the board's own API token is neither needed nor
  accepted. The localhost guard applies.
- **The PR review set.** `pr_overview`, `pr_files`, `pr_diff(path?, page?)` and `pr_comments(page?)`. None takes a
  target: each reads the grant's PR, so arguments naming another one are dropped, and a path the PR doesn't change is
  refused. The diff comes in pages of at most 400 lines and 20,000 characters (`PAGE_LIMITS`, small enough that Codex
  shows a result whole), by file or for the whole PR in order; a file split across pages repeats its header with
  `(continued)`, each result names its page, the count and the next call, and only a line longer than half a page is
  cut, with a marker. The file list is read once per run (`RunGrant.cache`) however many pages follow. Results mark
  the PR's own text as untrusted.
- **The other-people's-PR set** (`repoPrReview`): the same four, plus `pr_threads(page?)` (every review thread,
  resolved or not, each comment with its id and author, Autopilot's own threads marked, read through
  `GitHost.readRepoPr`) and `repo_issue(number)` (one issue of the PR's own repository: the issues it closes and the
  open ones that mention it). Neither reads another repository.
- **What they read through.** A `GitHost` (`integrations/gitHost.ts`): `getPr`, `listFiles` (with each file's patch),
  `getDiff(path, page)`, `getComments` (conversation comments, review bodies and inline comments with their ids,
  oldest first) and `getIssue` (`GitHostReads`, found by the run's target host through the `GitHosts` registry). GitHub's
  (`integrations/githubReads.ts`) reads REST (`GithubApi.rest`) with the `gh`
  token, 100 a page up to 30 pages; a file GitHub serves no patch for (binary, too large) says so.
- **Which providers.** The `runTools` capability: Claude Code and Codex. A run with `runTools` adds the `runTools`
  need, so the resolver never picks the Copilot CLI for it, and it runs headless only.

#### The push guard

Codex and Copilot can't be given Claude Code's deny rules, so git refuses the pushes itself. Every headless worktree
(`createWorktree({ pushGuard: true })`, `autopilot/pushGuard.ts`) gets a hooks folder of its own inside its git dir
(`<git dir>/autopilot-hooks`, removed with the worktree). The agent's process is pointed at it with
`core.hooksPath` in `GIT_CONFIG_PARAMETERS` (how `git -c` passes config on, `pushGuardEnv`), so every git the agent
runs uses it and no config file changes: not the repository's (turning on `extensions.worktreeConfig` would break
a bare repository's worktrees), not the user's. `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0` would be the documented way,
but a Codex shell was only seen keeping them in a read-only run, and a tool that drops variables with `KEY` in their name would break git outright; `GIT_CONFIG_PARAMETERS` has no such risk. Its `pre-push`
refuses a delete, a push to `refs/heads/<default branch>`, and a push whose remote commit isn't an ancestor of the
local one (a force-push; a remote commit the worktree hasn't fetched is refused too, as it can't be told apart). It
then runs the repository's own `pre-push`; every other hook just runs the repository's own (where git would look:
`git rev-parse --git-path hooks`, so a `~` in `core.hooksPath` is expanded), so its lint and commit-message checks
still apply. Git run by the board itself, or by the user in that worktree, doesn't use the guard. If the guard can't be installed the
worktree is removed and the run fails. It is a guard rail, not a sandbox: `git push --no-verify` skips it. Codex has
nothing that refuses `gh pr merge`; only the prompt says not to.

**Cleanup** (`autopilot/cleanup.ts`) runs hourly with the pollers. It removes a finished headless run's worktree
once the task has a merged PR, or `worktreeRetentionDays` after the run finished. It uses `git worktree remove`
without `--force`, so a worktree with uncommitted changes is kept and logged once. The branch is deleted with
`git branch -d`, which keeps a branch that has unmerged commits.

### Models

Every operation that runs a model has one model choice, `ModelChoice` (`packages/contracts/src/modelProfiles.ts`):
`"inherit"`, a tier (`{tier}`), a custom model (`{profile}`), or a model typed for one provider
(`{provider, model, effort?}`). The operations are the `OPERATIONS` registry (`packages/contracts/src/operations.ts`),
each with what it needs from the provider and a default that is a tier or inherit, never a provider's model:

| Operation (`OperationId`)                    | Default | Needs                                    |
| -------------------------------------------- | ------- | ---------------------------------------- |
| Task runs (`taskRun`), PR fix (`prFix`)      | inherit | edit                                     |
| New sessions, terminal and T3 (`launch`)     | inherit | nothing                                  |
| Reviewer subagent (`reviewer`)               | inherit | nothing (it is a line in the brief)      |
| Board reviewer (`boardReviewer`)             | standard | structured output, tool rules           |
| PR review (`prReview`)                       | standard | structured output, untrusted lockdown, run tools |
| Orchestrate (`orchestrate`)                  | standard | untrusted lockdown, tool rules          |
| Improve automations (`improve`)              | deep    | untrusted lockdown, tool rules           |
| Digest (`digest`)                            | light   | no tools                                 |
| Custom agents on a task (`customTask`)       | inherit | edit                                     |
| Custom agents without a task (`customDetached`) | light | nothing                                 |
| Issue import (`issueImport`)                 | light   | structured output, tool rules            |
| Ask (`ask`)                                  | light   | structured output, no tools              |

**Which choice applies** (`resolveOperationChoice`), most specific first; `inherit` defers to the next:

1. The task's reviewer override, then the project's (`reviewModel`; the two reviewer operations only).
2. The automation's **Model** field (kind `model`, config key `modelChoice`, default inherit) at its scope, then a
   custom agent action's own `model` (`RunnerRequest.modelChoice`).
3. The board's setting for the operation (`AppSettings.operationModels[op]`). Set to inherit on an operation on a
   task, it skips the default and takes the task's own model (step 5), so PR review or the board reviewer can follow
   the task.
4. The operation's default.
5. When everything inherits, a task-scoped operation takes the task's own model (`resolveTaskModel`): a custom model
   one of its labels picks (**Settings → Agents → Models → Custom models**, the first in the list when several claim a
   label), else its suggested tier, else the light tier. Anything else takes the light tier.

A choice naming a custom model that was since deleted is passed over with a note, and the next level decides.

**Which provider runs it** (`resolveOperationModel`, pure, so the web can show it too). Only providers the user added
and switched on (Settings → Agents → Providers) that can do what the operation needs (`HEADLESS_CAPABILITIES`, and what the run
asks on top: `driverNeeds` in `integrations/headlessDrivers.ts`) count:

- A typed model runs on its own provider, with its effort when that CLI takes it. If that provider isn't on, or can't
  do what the operation needs, the operation refuses.
- A tier or custom model runs on its preferred provider (`ModelTierSetting.provider`, the **Preferred** radio on Settings → Agents → Models;
  it has no default) when that counts; otherwise on the first provider in the Providers order that counts and has a
  model for it, else on the first that counts, on the CLI's default model. A CLI model comes with its effort; when a
  tier has no CLI model for a provider, its T3 model stands in when T3 files it under that provider
  (`t3InstanceHarness`), with no effort.
- A provider that meets the needs only with a [warning](#capability-warnings) counts for a typed model on it and as
  the preferred provider of a tier or custom model chosen for the operation, never as a fallback or through a default.
- No provider counts: the operation refuses with the reason ("Ask needs a provider that can return structured output
  and run with no tools; add one in Settings → Agents → Providers"). It never runs something else quietly. The refusal is the
  Ask error, the issue-import failure, the board review round's error and the Autopilot run's failure.

Every fallback (another provider, no model for it, a deleted custom model) goes in the run's detail, with a
`Model: …` line naming the model, what picked it and the provider. The run records what it ran on in
`AutopilotRun.model` (`autopilot_runs.model_json`: `{provider, model, effort, source}`). A **T3** launch passes the
tier or custom model the run's operation resolved to on to `launchTaskThread` (`modelChoice`), whatever picked it, so
the board's model for new sessions (`launch`) never replaces it; there it is checked against T3's providers
(`resolveSuggestion`). A model typed for a CLI provider, or the light fallback, has no T3 model: the launch gets
`defaultModel` and T3's default runs. The run records `{provider: "t3-code", model}` with the T3 model it asked for
(null when T3 couldn't use it, or there was none).

041_operation_models moved what was saved before into this shape: see [ADR 0012](../decisions/0012-provider-neutral-operation-models.md).

### Writing an automation

One file under `apps/server/src/autopilot/automations/`, added to `AUTOMATIONS` in its `index.ts`, wrapped in
`defineAutomation`:

- `key`: stored in settings and runs, so never renamed. Start planned tasks uses `AUTOPILOT_START_PLANNED`.
- `needsAgent`: whether the action starts an agent, and so counts against the caps. `background` marks a slow
  action that isn't an agent run (a digest waiting on its summary): the engine doesn't wait for it before the next
  candidate. Agent actions always go on in the background.
- `epicScope` (optional, default true): false when no candidate is ever a task in an epic, so an epic can't switch it.
- `group`: the heading Settings → Autopilot lists it under (`ship`, `prs` or `upkeep`; unset is `yours`, as for a
  custom automation).
- `schema`, `fields`, `defaults`: the config, parsed with zod over the defaults; `fields` describe the form the
  UI renders (boolean, number, text, time, select, skill; a skill field's `builtinLabel` renames its built-in entry,
  and a text field's `multiline` makes it a text area). A field's `tier` is `essential` for what most people set,
  shown with the automation; anything else (and unset) sits under its closed Advanced section. Runner, model, budget,
  timeout and T3 access are always advanced, and the detail pane shows them as two lines rather than a row each, the
  same for every automation (see [Advanced overrides](#advanced-overrides)). A field's `help` is one short line and
  `info` the rest, behind an info button by its label; `inRowOf` draws a field's control in another field's row (Fix
  PRs' threshold beside Autopilot's review) instead of a row of its own. Add the automation's sentence to
  `automationSentence` too.
- `check(ctx)`: reads the board and returns candidates, only for `ctx.projects` (and the board when `ctx.board`
  is set). It must be cheap: it runs every pass.
- `act(candidate, ctx)`: does the work, with `ctx.actor` as the actor of any change, and returns the outcome.
  Agent work goes through `ctx.runner.start` (see [Runners](#runners)); `ctx.update` records runner details while
  it runs. Return `needsAttention: true` for a failure the user should see.

An automation must never close or delete tasks, force-push or push to the default branch. Its merges are Merge ready
PRs': into an epic's branch through `ctx.gitHosts.mergeIntoEpicBranch`, and into the default branch only through
`ctx.gitHosts.mergeAutoMergeTask`, which is `merge_task_pr`'s own `mergeTaskPr` (the auto-merge flag and the gate are
checked there). No agent an automation starts merges: Orchestrate is denied `merge_task_pr`.

### The UI

How Autopilot looks on the board (the lane pill, the epic button, the header pause button, the card badge and the
task panel's Autopilot section) is in [board-layout.md](board-layout.md#autopilot-on-the-board). The settings are in
`components/autopilot/`:

**Settings → Autopilot** is three tabs (`AutopilotTabs` in `AutopilotPage.tsx`), each a sidebar entry:

- **Automations** (`/settings/autopilot`, section `autopilot.automations`, `AutopilotAutomationsTab`):
  - **The status strip**: Running, Paused or Nothing is on; today's agent runs and spend (`overview.today`,
    `todaySummary`) and the limits in one line (`limitsSummary`, both in `packages/contracts/src/autopilotSentence.ts`);
    **Pause all** (`autopilot.automations.pause-all`) and a link to Limits & safety.
  - **Needs you** (`autopilot.automations.needs-you`, hidden when empty), from `overview.needsYou` (`AutopilotNeed`,
    built by the service's `overview()`): failed runs whose flag still stands on their task (one per task, the latest;
    **Retry** when `canRetryRun`, **Dismiss**), other people's PRs Review PRs found clean that only the user can
    approve (kind `pr_approval`, oldest first, **Open PR**), drafts agents wrote (**Review** opens the import page,
    **Dismiss**), and automations that can't run as set up, their `blocked` or `needs` (**Fix** picks the built-in, or opens a
    custom one's editor).
  - **The list and detail** (`AutomationsSplit`), the Providers page's `SplitCard`. Every automation is listed once,
    under its `group` heading (`AUTOMATION_GROUPS`: Ship work, Pull requests, Upkeep, then Yours for custom
    automations, which have no group of their own). A row has an icon, the name with the row's full width (no marker
    beside it: the switch says On or Off), a subline (`rowSubline`, from each project's scope and `overview.lastRuns`),
    and its board switch (on saves the mode `restoreMode` gives); that switch, and the detail header's **Switch on**
    (`useBoardMode`), turn it on as Everywhere, so the rows Only in… left go too and a later off is off everywhere (while
    it is already on or in Preview, only the board's own row changes). The subline says where it is on and how its last
    run went ("every project · ✓ 2m"), led by what the switch can't show, as a coloured word: **Paused** (amber) "in
    storefront", **Preview** (amber), **Last run failed** (red) "· 3m ago". A project's own setting beats the board's,
    so with the board off and some projects set On it does run there: the switch is then **mixed** (`switchState`, a
    centred thumb on a tinted track) and the subline reads "On in 5 projects". Switching off a mixed automation, or one
    whose board is on while projects or epics set their own On (`whereOwnOn`), asks first (`SwitchOffDialog`): **Off
    everywhere** (`whereOffEverywhere`: the board and every own On or Preview back to Inherit; rows set Off stay) or,
    when the board is on, **Board only**, which leaves those projects running; a plain one saves the board's `inherit`.
    An
    automation off on the board and in every project is dimmed, as a switched-off provider is; its switch stays.
    **+ Add automation** opens [the Add gallery](#the-add-gallery), and **Ask an agent** beside it is
    [the hand-off](#ask-an-agent). `?automation=<key>` picks a row; with none, the first is shown.
  - **The detail**: a header with the status line (`statusLine`, "Preview · …" in Preview, "On in 5 projects · Off for
    the board" when mixed, agreeing with the list switch) and **Switch on/off** (Switch off when mixed),
    plus **Export** and **Delete** for a custom automation; in Preview, a notice with how often it would have run this
    week (`previewHint`), **See them** (its run history) and **Turn on**; **What it does**, one sentence read from its
    effective config (`automationSentence`; a custom automation's from its trigger and action) with **All runs**, and
    the **Mode · for the board** row, the board's Off · Preview · On, saying what the mode does (`modeDescription`;
    with a check script, that it still runs for real; when mixed, "**Off for the board.** On in 5 projects, which
    set their own." (a project only in Preview is named as Preview) with a **Turn off everywhere** link); **Where it runs** (`WhereItRuns`), the shared `ProjectTable`: a Stacked header row, **All projects**, over one row
    per project. All projects is the board's scope and each project row an override, written only where it differs
    from the board (a dot marks one; when the table is collapsed, "N differ" counts them). The rows are the project's
    effective state. The header shows what they add up to, so on, off or the middle position (`columnState`, the
    list's tint): a click on on or middle switches the column off (`whereOffEverywhere`, which also clears epics set
    On), a click on off turns it on for every project (`whereOnEverywhere`, in the mode `restoreMode` gives), and when
    that would drop switches a person set it asks first (`headerLoss`, `HeaderClearDialog`). "New projects: on." under
    the table says what the stored board value gives, which a mixed header can't. Epics are not in the table: they
    stay in the board's epic popover, and an epic's own setting still beats its project's. Past `PROJECT_CHIPS_MAX`,
    8 projects, a search box shows above the rows; about ten rows fit before they scroll, with the header outside the
    scroll area and both reserving the same scrollbar gutter so the columns stay in line. Clicking a project row
    expands it, with one labelled **Preview** switch (`whereProjectPreview`, nothing stored when the project matches
    the board); in Preview the row's switches turn amber and it shows a badge. An automation with `needsRepo` (Start
    planned tasks, Review PRs, Fix PRs, Merge ready PRs) leaves out the General project, which the board names with
    `generalProjectId` on its snapshot. Only the table leaves it out: no row's switch can reach it, and a header click clears General's own setting along with the rest. It reads `useAutopilotModes` and the board's projects and
    unarchived epics (epics only for an automation with `epicScope`), writes through `useApplyWhere` (one PUT per write,
    shown at once and refetched on error), and a blocked automation can't be switched on or into Preview from it: anything that would is disabled and shows why;
    **Settings**, the fields whose `tier` is `essential`; and **Advanced**, closed, with every other field.
    Its heading says how many differ from their default ("Agent, Fix skill · 2 changed", `advancedChangedCount`). A
    field without a tier is advanced. Every row has one short description line, the rest behind an info button
    (`InfoHover`), as docs/reference/style.md asks. A custom automation's trigger and action are edited in its editor (**Edit**,
    `/settings/autopilot/custom/<id>`).
  - **Quick setup as the empty state**: while nothing is on at any scope (`isOffEverywhere` for every row), the tab shows
    [Quick setup](#quick-setup) above Needs you.
  - At phone width the card shows one side at a time: the list, then the detail with an **All automations** link back.
#### Advanced overrides

Every automation's Advanced section uses one pattern (`ModelLine`, `AgentDefaultsLine` and `AutomationField` in
`AutomationsSplit.tsx` and `AutomationRows.tsx`, with the helpers in `automationList.logic.ts`):

- **Closed**: one short line on where the value comes from, a "Now: …" status and **Override** on the right. The model
  comes from Agents → Operations; runner, budget, timeout and T3 access from Limits & safety's
  [agent defaults](#agent-defaults).
- **A field's reset** (`SettingResetButton`, ↶) shows by its label only while the value differs from its default
  (`fieldChanged`; the default is `fieldDefault`: the board's agent default for those four keys, Inherit for the model,
  else the automation's own), and resets that field alone. Its tooltip names the default ("Reset to $5",
  `fieldValueText`). Setting the default back by hand saves no key, so the ↶ hides and it follows the default again.
  Resetting one keeps the group open.
- **The group** ("Runner, budget, timeout and T3 access") says "N set here, the rest from Limits & safety" while
  overriding, and its control becomes **↶ Reset**, which clears all four and closes it: also the way out when nothing
  changed. Its field rows are tinted rather than indented, since an indent would push a row in the narrow detail pane
  under its container breakpoint and stack its control.
- **The model** is one row, so its ↶ shows the whole time it is overridden; that is its way back to the one-line row.
- Controls follow docs/reference/style.md: one right edge, numbers in `UnitInput`, selects at `SETTINGS_TEXT_WIDTH`, the
  model picker at `SETTINGS_PICKER_WIDTH`.

The **Merge ready PRs** detail (`MergeTargets.tsx`) follows the same rule: what an integration branch is sits behind the
**Merges into** heading's info button (`DetailSection`'s `info`), each target is one line with one fact from the board
(`epicsStatus`, `flaggedStatus`), and Ready means is one line with the full definition behind its info button.

#### The Add gallery

`AddAutomationDialog` (`components/autopilot/`), opened by **+ Add automation**, is one place to start anything:

- **Quick setup**, a row with **Choose…** that opens [the card](#quick-setup) inside the dialog.
- **Quickest: ask your agent**, with the [Ask an agent](#ask-an-agent) menu.
- **Recipes** (`AUTOMATION_RECIPES`, `automationExamples.ts`): ready-made custom automations as bundles. A card opens the
  import page with `?recipe=<id>`, where the bundle is read like a shared file and saves in Preview. They are plain
  custom automations; nothing marks one as a recipe afterwards. A recurring-task rule is not a recipe: it needs a
  project and a template.
- **Import a file** (the import page) and **Start from scratch** (the editor, `/settings/autopilot/custom/new`).

Built-ins that are switched off stay in the main list, dimmed, so the gallery doesn't repeat them.

#### Quick setup

`QUICK_SETUP_PRESETS` (`packages/contracts/src/quickSetup.ts`) names three one-off presets: **Notify** (Digest, Remind
me about stuck tasks, Unblock dependents, Auto-archive Done), **Assist** (Review PRs, Fix PRs, Digest, stuck-task
reminders, Auto-archive) and **Hands-off** (Start planned tasks, Orchestrate, Review PRs, Fix PRs, Merge ready PRs,
stuck-task reminders, Auto-archive). Quick setup writes only each automation's mode: Merge ready PRs' Into main setting, like every other config, is left as it is.

`quickSetupChanges(level, state)` is pure and drives both the list the card shows and the writes it makes
(`quickSetupWrites`): each preset automation that is off or inherits at the **board** scope is switched on there; one
already On or in Preview is listed as "already on" and left alone; one with `blocked` is listed and skipped. A project
that switches one Off for itself is named in the row ("Stays off in …"), since the board write doesn't override it.
Automations that start an agent or act on GitHub start in **Preview** while "Start agent automations in Preview"
(on by default) is on; the rest start On.

Apply (`useApplyQuickSetup`) sends the writes one after another through the board scope's `PUT`, since the server has
no batch; a refused write is reported in one toast and doesn't stop the others. **Nothing stores the level**: the writes
are ordinary board switches, and the next Quick setup reads what is on then.

#### Ask an agent

There is no chat box. `AskAgentMenu` (`handoff/HandoffActions.tsx`) hands a prompt to the user's own agent as **New T3
Code thread…** (one item per project that can start one, `canStartProjectT3Thread`; the dialog's `prompt` launch kind
shows the prompt for editing first and starts it in a project thread linked to nothing) or **Copy prompt**. It sits
beside **Add automation** (`createAutomationPrompt`), as **Ask an agent to change this** in each automation's detail
header (`changeAutomationPrompt`) and as **Ask an agent to fix** on a failed run in Needs you and the Runs tab
(`fixRunPrompt`), all in `packages/contracts/src/automationPrompts.ts`.

The prompts name the `aboard-automations` skill and `draft_automation`. A custom automation's prompt carries its id and
definition (as a shared-file bundle, cut at 6,000 characters), and the agent drafts a replacement for the user to
review; a built-in's tells the agent it can't change settings and should say which to change. A fix prompt carries the
run's summary, error, exit code and the last lines of its output, and `retry_autopilot_run` when the run was on a
task. They all say a draft isn't active until the user imports it. A session in a CLI harness isn't offered: those
launchers are task- and planning-specific.

- **Runs** (`/settings/autopilot/runs/$automation`): the [run history](#run-history) of every automation (`all`) or
  one.
- **Limits & safety** (`/settings/autopilot/limits`, `AutopilotLimits`): spending and timing (concurrency, the daily
  caps, quiet hours), the defaults for agent runs ([agent defaults](#agent-defaults), with a link to Agents →
  Operations for the models), **Advanced** (`autopilot.limits.advanced`: **Preview everything**, `engine.dryRun`, and
  worktree retention), and the board's variables. A number that is out of range is put back with a toast; an empty cap means
  no cap.

Old links still work: `redirectSettingsTarget` sends `autopilot.engine.*` to the limits rows or, for
`autopilot.engine.automation-<key>` and `autopilot.engine.orchestrate`, to `autopilot.automations.<key>` (which picks
it), and `autopilot.custom` to the list (its variables to Limits & safety). The old Dry run and Safety anchors go to
Preview everything and Advanced. The router redirects such a hash to the
tab's path. Orchestrate's **Countdown on lanes** (`showAutopilotTimer`, a per-browser display preference) is
**Autopilot countdown on lanes** in Settings → Appearance.

The fields are a form generated from the automation's `fields`: a switch, number, text, 24-hour time or select per
field, and for `skill` the review skill picker (built-in skill plus skills found on disk; a skill is stored as a
`ReviewSkillRef`, and an unset one is the built-in skill, labelled with the field's `builtinLabel` when it has one,
such as the digest's own skill). The board's fields are edited in the detail, as above. With a project chosen in the
settings scope sentence (`?project=`, see [board-layout.md](board-layout.md#the-settings-page)), each list row is
`ProjectListRow`: **On here**, **Preview here** or **Off here** and a switch that writes `scopeToggle` for that project
through `useApplyWhere`, the same writes as the lane's popover. The detail gains an **In <project>** section with the
same switch. A project no longer has a form for its own config: a value already stored for a project still applies
over the board's, so that section says the project sets its own and has **Clear own settings** (it saves the scope's config as empty, which the
server turns into removing the row when the mode is Inherit); nothing in the UI sets one. The lane and epic popovers are the widget's compact form (`WhereRow`, see
[board-layout.md](board-layout.md#autopilot-on-the-board)). Config set at a scope is sent whole (the server replaces
it), so editing one key sends the scope's other keys with it; the reset button beside a field's title (shown only
while the key is set at that scope) removes the key so it inherits.

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
| `apps/server/src/autopilot/pushGuard.ts` | The worktree's pre-push hook and the hooks that pass on to the repository's |
| `apps/server/src/autopilot/repoGate.ts` | One `git fetch` per repository at a time: Autopilot's T3 launches and headless worktrees |
| `apps/server/src/integrations/headlessAgent.ts` | `claude -p` arguments for agent runs, the push deny rules, the outcome, the driver interface |
| `apps/server/src/integrations/headlessDrivers.ts` | The Codex and Copilot CLI drivers, capabilities and the fallback to Claude Code |
| `apps/server/src/mcp/runTokens.ts`, `mcp/runTools.ts` | Run tools: the tokens, `/mcp/run` and the tool sets |
| `apps/server/src/integrations/gitHost.ts`, `githubReads.ts` | `GitHost`, the paging helpers, and GitHub's reads |
| `apps/server/src/integrations/gitHosts.ts` | The `GitHosts` registry and `gitHostActions`, what `ctx.gitHosts` is |
| `apps/server/src/autopilot/engine.ts` | The pass, the event and tick wiring |
| `apps/server/src/autopilot/limits.ts` | `agentHold`: quiet hours, concurrency and the daily caps, for the engine and Orchestrate's state |
| `apps/server/src/autopilot/automations/index.ts` | The catalogue |
| `apps/server/src/db/migrations/022_autopilot_run_output.sql` | `autopilot_runs.output_json`, an action's structured result |
| `apps/server/src/autopilot/automations/autoArchive.ts` | Auto-archive Done |
| `apps/server/src/autopilot/automations/startPlanned.ts` | Start planned tasks |
| `apps/server/src/autopilot/automations/orchestrate.ts` | Orchestrate: the schedule, Run now, its state, the tools it gets and `orchestratePrompt` |
| `apps/server/src/mcp/tools/autopilot.ts` | `retry_autopilot_run`, `draft_automation` |
| `apps/server/src/autopilot/reminders.ts` | The quiet-task, waiting-thread and unblocked reminders (`sendReminders`) |
| `apps/server/src/autopilot/automations/reviewPrs.ts` | Review PRs: the trigger, the prompt, the verdict and the hand-off, carried verdicts and resolution reviews |
| `apps/server/src/autopilot/headMove.ts` | `classifyHeadMove`: whether a PR's head moved only by merging its base in, and whether git made those merges on its own |
| `apps/server/src/autopilot/automations/repoPrs.ts`, `repoPrAssess.ts` | Review PRs' other people's PRs: settings, the poll, which PRs and their mode and gate, the prompt, posting and hand-offs |
| `apps/server/src/integrations/githubRepoPrs.ts` | GitHub's reads and writes for other people's PRs: the open PRs, one PR in full, `unchangedSince`, comments |
| `packages/contracts/src/repoPrReview.ts` | The other-people's-PR verdict, run output, markers, `/autopilot` commands and sensitive paths |
| `apps/server/src/autopilot/automations/fixPrs.ts` | Fix PRs: the triggers, batching, the limits and the fix prompt |
| `apps/server/src/autopilot/automations/mergeEpicPrs.ts` | Merge ready PRs: Into epic branches (the merge, the epic's draft PR and `epicPrBody`) and the dispatch to Into main |
| `apps/server/src/autopilot/automations/mergeIntoMain.ts` | Merge ready PRs' Into main: candidates one per repository, the hold notice and the merge through `mergeAutoMergeTask` |
| `apps/server/src/autopilot/epicBranch.ts` | `ensureEpicBranch`: making an epic's integration branch on origin |
| `packages/contracts/src/runThreads.ts` | `t3RunWorking`: whether a T3 thread a run handed work to is still working on it, for Start planned, Fix PRs and the PR row |
| `apps/server/src/autopilot/threads.ts` | `threadSeen`: whether the live poll has seen a thread lately |
| `packages/contracts/src/prReview.ts` | The review verdict, `PrReviewRunOutput`, `currentPrReview`, the threshold rules, the header |
| `apps/server/src/integrations/githubHost.ts` | GitHub's `postReview` (the comment review, with its head check and inline fallback), `ensurePr`, `setPrBody`, review threads and `agentHints` (the fix prompt's `gh` commands) |
| `apps/server/src/integrations/prMerge.ts` | `mergeIntoEpicBranch`, `checkAutopilotMergeTarget`, `epicMergeMethods` |
| `apps/server/src/autopilot/automations/recurring.ts`, `services/recurring.ts` | Recurring tasks: the automation, and the rules' service |
| `packages/contracts/src/recurring.ts` | Rule and schedule schemas, `nextDue`, `latestDue` |
| `packages/contracts/src/customAutomations.ts` | Custom triggers, filters and actions, placeholders, the shell environment, the definition check |
| `apps/server/src/autopilot/custom.ts`, `services/customAutomations.ts` | Custom automations as catalogue entries, and their service |
| `apps/server/src/integrations/shellCommand.ts`, `scriptRunner.ts`, `captureProcess.ts` | Running a shell or script action, and the spawn they share |
| `packages/contracts/src/quickSetup.ts` | Quick setup's presets and `quickSetupChanges` |
| `packages/contracts/src/automationPrompts.ts` | The Ask an agent prompts: create, change this, fix this run |
| `apps/web/src/components/autopilot/AddAutomationDialog.tsx`, `QuickSetup.tsx`, `AskAgentButtons.tsx` | The Add gallery, the Quick setup card, and the change and fix menus |
| `packages/contracts/src/automationVariables.ts` | Variables: the schema and `effectiveVariables` |
| `packages/contracts/src/automationSdk.ts` | What a script can read, and the snippets the editor's panel shows |
| `apps/server/src/integrations/gitRemote.ts` | `remoteRepo`, `repoWebUrl` and the cached repository URL per folder |
| `apps/server/src/db/migrations/036_project_variables.sql` | `projects.variables_json`, a project's variable overrides |
| `apps/web/src/components/autopilot/VariablesEditor.tsx`, `VariablesSection.tsx`, `variables.logic.ts`, `SdkStatusBar.tsx`, `InsertChips.tsx` | The variables editors, the "Variables it reads" list, the insert chips and the status line |
| `apps/web/src/components/autopilot/CustomAutomation*.tsx` | The custom automation editor and import page |
| `apps/web/src/components/autopilot/ScriptField.tsx`, `ScriptEditor*.tsx`, `scripts.logic.ts` | The script editor (CodeMirror, lazy), language notes, starters, the test run panel |
| `apps/server/src/services/testScript.ts` | Running a draft script once for the editor's test run |
| `packages/contracts/src/automationBundle.ts`, `automationExamples.ts` | The shareable file (version 2 with a script), and the shipped example |
| `apps/server/src/autopilot/reviewRepoPrs.test.ts` | The example's bundle, and its script run against a fake `gh` |
| `packages/contracts/src/automationDrafts.ts`, `apps/server/src/db/repos/autopilotDrafts.ts` | Agents' drafts: the input, the check, the caps, and their table (migration 037) |
| `apps/server/src/autopilot/automations/digest.ts`, `autopilot/digest.ts` | Digest of what changed: the automation, making a digest (plain, summarised, the fallback) and "digest now" |
| `apps/server/src/autopilot/digestBuilder.ts`, `digestConfig.ts` | The plain digest's Markdown, and the automation's config |
| `apps/server/src/services/digests.ts`, `db/repos/autopilotDigests.ts` | Collecting the period's activity, storing digests, the inbox notification |
| `packages/contracts/src/digest.ts` | `Digest`, `dueDigestSlot` |
| `apps/web/src/components/recurring/` | The rule rows (shared by the project page and Settings → Autopilot), editor and examples |
| `apps/server/src/http/routes/autopilot.ts` | The REST routes |
| `packages/contracts/src/autopilotRunHistory.ts` | The run history's filter, query and page, and the delete's input, result and kept reasons |
| `apps/server/src/db/migrations/034_autopilot_runs_automation_index.sql` | The index the history page's filter and paging read |
| `apps/web/src/components/autopilot/RunHistory.tsx`, `RunHistoryRow.tsx`, `runHistory.logic.ts` | The run history page, a run's row, and the URL-to-filter logic |
| `apps/web/src/components/autopilot/AutopilotPage.tsx` | Settings → Autopilot's tabs, the status strip and Needs you |
| `apps/web/src/components/autopilot/AutomationsSplit.tsx`, `automationList.logic.ts` | The list and detail: groups, rows, dimming, the Advanced section, its override pattern and change count |
| `apps/web/src/components/autopilot/AutopilotSettingsSection.tsx` | The Limits & safety tab, and a project's read-only Autopilot list |
| `packages/contracts/src/autopilotSentence.ts` | `automationSentence`, `limitsSummary`, `todaySummary` |
| `apps/web/src/state/autopilotRunHistory.ts` | The history's infinite query, the delete preview and the delete |
| `apps/web/src/components/autopilot/` | The pill, epic button, their shared popover (`ScopePopover`), badge, panel section and settings (`autopilot.logic.ts` holds the tested logic) |
