# Autopilot

Board task: #79 (engine core), in epic #101.

Autopilot lets the board act on its own: a catalogue of automations, each switched on or off per project or for
the whole board, that watch the board and act when something needs doing. The engine is deterministic code in
the server. It never calls an LLM itself; an automation whose action needs one starts an agent through a runner.
The rules every automation lives under are in [ADR 0008](../decisions/0008-autopilot-engine.md).

This doc covers the engine, the per-task flag, the automations that have landed (below) and the settings UI. The rest
of the catalogue is each its own task in the epic, and so are the runners (#85). Until a runner is configured, every
agent action fails with "No agent runner is available yet".

## How it works

### Switches and scopes

Each automation has a mode at each scope: **Inherit**, **On** or **Off**. The most specific scope that isn't
Inherit wins: project over board. With nothing set anywhere, an automation is off.

| Board | Project | Effective      |
| ----- | ------- | -------------- |
| —     | —       | Off (default)  |
| On    | Inherit | On (board)     |
| On    | Off     | Off (project)  |
| Off   | On      | On (project)   |

Each automation also has config (a skill, a budget, a number of days). Config keys merge the same way, board
first and project last, over the automation's defaults, whatever the modes: a project can tune an automation
the board switches on. `resolveAutopilot` in `packages/contracts/src/autopilot.ts` is the rule, and
`describeInherited` gives the UI its "Inherit (On from board)" label.

Rows live in `autopilot_settings`, keyed by scope and automation. The board scope has an empty `scope_id`. An
epic scope can be stored but isn't resolved yet (#93), and the service refuses to set one. Deleting a project
(or an epic) deletes its rows, through triggers, since `scope_id` can't carry a foreign key.

### Engine settings and pause

Engine-wide settings are one `autopilotEngine` key in the `settings` table, and Pause all is
`autopilotPaused`:

| Setting                | Default         | Meaning                                                              |
| ---------------------- | --------------- | -------------------------------------------------------------------- |
| `maxConcurrent`        | 1               | Agent runs going at once                                             |
| `dailyRunCap`          | none            | Agent runs started per local day                                    |
| `dailySpendCapUsd`     | none            | What agent runs created today may cost before no more start          |
| `quietHours`           | off, 22:00–07:00 | No agent runs start in the window (local time; may wrap midnight; equal ends are no window) |
| `dryRun`               | off             | Record what would run, and do nothing                                |
| `prReviewRounds`       | 3               | Rounds the PR review automation runs per PR                          |
| `prFixThreshold`       | major           | The lowest finding severity the PR automations ask an agent to fix   |

Quiet hours and the caps only hold back automations with `needsAgent`; board-only actions (archiving a card)
go ahead. **Pause all** stops every new run; runs already going finish. Backups carry the engine settings but not
the pause, so a restore never lifts it.

### A pass

The engine (`apps/server/src/autopilot/engine.ts`) runs a pass a second after a burst of board events, every
60 seconds, and when Autopilot settings change. PR and T3 thread snapshots reach it as `task.upserted` events,
so they need no hook of their own. Events published while the engine itself writes start no pass. A pass:

1. Stops if paused.
2. For each automation, works out the projects where it's on (and whether it's on for the board itself) and
   skips it if it's on nowhere.
3. Calls the automation's `check`, which returns candidates: a dedupe key, a one-line summary, and usually a
   task.
4. Drops candidates outside the scopes it's on in, and candidates whose dedupe key already has a run.
5. In dry-run, records a `skipped` run with "Would …" as its summary and moves on.
6. For agent automations, holds the candidate in quiet hours, at the concurrency cap or at a daily cap. Held
   candidates aren't recorded, so a later pass picks them up.
7. Records a `queued` run, marks it `running`, and calls the action. Agent actions go on in the background;
   board-only actions are awaited, one after another.

A run is never retried: once a dedupe key has a run, whatever its outcome, that candidate is done. A key that
should act again changes (`review:pr:<headSha>`, `start:<taskId>:<statusChangedAt>`). Dry-run runs are deduped
apart from real ones (the unique key is automation, dedupe key and `dry_run`), so turning dry-run off doesn't
hide work it only previewed.

### Runs

`autopilot_runs` holds one row per run: `queued → running → succeeded | failed | skipped`. The runner fills in
`runner`, `session_id`, `thread_url`, `worktree_path` and `cost_usd`. Runs are history, so backups leave them out.

- A task's runs log `autopilot_run` activity under the actor `autopilot`: when it starts, when it ends, and
  once for a dry-run preview.
- Every change to a run publishes `autopilot.changed` with the pause state and the runs in flight; the board
  snapshot carries the same `autopilot` object, so lanes and cards can show what's running.
- An action that throws fails its run and flags it **needs attention**. The server marks runs a restart left
  `queued` or `running` as failed and flagged, at startup, whether or not the pollers run.

### Needs attention

A flagged run puts an `autopilot` attention reason on its task, with the run's error. It isn't cleared by a
write: `autopilotRuns.attentionFor` stops reporting it once the task changes status after the run, or a later
real run of the same automation on the task succeeds.

### The per-task flag

`tasks.autopilot` is a nullable integer like `auto_review`: null is **Default**, 1 is **On** and 0 is **Off**.
Default never auto-starts a task; only On does, so an automation that starts work (Start planned tasks) checks
for `task.autopilot === true` on top of its scope being on. The flag does nothing by itself.

- The user sets it in the task panel's Details section. Agents set it with `autopilot: "default" | "on" | "off"`
  on `update_task`, `create_task` and `add_to_backlog`, and only after the user has said so. A change is logged
  as an `updated` activity entry naming `autopilot`.
- After `set_plan` or `create_task`, when Start planned tasks resolves On for the task's project and the flag is
  Default, the result says **Autopilot flag not set** and tells the agent to ask the user (`autopilotFlagHint`).
  Without the automation switched on there is nothing to opt into, so there's no hint.
- Backups carry the column (the dump is `SELECT *` and the restore inserts by column name); a dump from before
  the column restores with every task at Default.
- Agents can flag tasks but still can't change any Autopilot setting.

### API

REST only, for the UI. There is no MCP tool, so agents can't switch Autopilot on, lift its limits or unpause it.

| Route                                           | Does                                                   |
| ----------------------------------------------- | ------------------------------------------------------ |
| `GET /api/autopilot`                            | Pause, engine settings and the catalogue (with each automation's field descriptors and defaults) |
| `PATCH /api/autopilot/engine`                   | Updates engine settings; `quietHours` may be partial   |
| `POST /api/autopilot/pause`, `/resume`          | Pause all, and back                                    |
| `GET /api/autopilot/board`, `/projects/:id`     | Each automation at that scope: its own mode and config, and what it resolves to |
| `PUT /api/autopilot/board/:automation`, `/projects/:id/:automation` | Sets mode and/or config; Inherit with no config removes the row |
| `GET /api/autopilot/runs?taskId=` or `?projectId=` | Runs, newest first (`limit`, default 50)            |

### Automations

**Auto-archive Done** (`auto_archive`, #91; `automations/autoArchive.ts`). Needs no agent and is off until switched
on. Archives (never deletes) a task that has been in Done for more than `days` days (default 14, minimum 1, set
per scope), logged as `archived` plus the note "Archived by Autopilot after N days in Done" under the actor
`autopilot`. It skips epics, tasks in an epic (archiving them would send a finished epic back to Backlog) and
tasks with an open, draft or not-yet-polled PR. The dedupe key is `archive:<taskId>:<statusChangedAt>`, so a
manual unarchive sticks until the task leaves Done and comes back.

**Unblock dependents** (`unblock_dependents`, #92; `automations/unblockDependents.ts`). Needs no agent and is off until
switched on, with no settings. When the last unfinished blocker of a task reaches Done (or is closed as completed or
duplicate), it logs a note "Unblocked: #N finished" on the dependent and sends an `autopilot_notice` notification.
A partially unblocked dependent waits. It starts nothing: a flagged Planned dependent just becomes eligible for Start
planned tasks on the next tick. It only reports blockers that finished in the last 24 hours, so switching it on doesn't announce old work. The scope is the dependent's project. The dedupe key is
`unblock:<dependentId>:<latest blocker statusChangedAt>`, so reopening a blocker and finishing it again notifies
again, while two blockers finishing together give one notification.

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
  these settings ("Recurring tasks…", `openProjectSettings(id, "recurring")`), scrolled to the section.

#### Recurring rules API

REST only, like the rest of Autopilot:

| Route                                    | Does                                                           |
| ---------------------------------------- | -------------------------------------------------------------- |
| `GET /api/projects/:id/recurring`        | The project's rules, each with `nextDueAt`                     |
| `POST /api/projects/:id/recurring`       | Creates one (`name`, `templateId`, `schedule`, `flagAutopilot`, `enabled`); 409 on a name the project has |
| `PATCH /api/recurring/:id`               | Edits it                                                       |
| `DELETE /api/recurring/:id`              | Deletes it; tasks it made stay                                 |

Every change publishes `autopilot.changed`, which the web app uses to refetch the rules.

### Writing an automation

One file under `apps/server/src/autopilot/automations/`, added to `AUTOMATIONS` in its `index.ts`, wrapped in
`defineAutomation`:

- `key`: stored in settings and runs, so never renamed. Start planned tasks must use `AUTOPILOT_START_PLANNED`.
- `needsAgent`: whether the action starts an agent, and so counts against the caps.
- `schema`, `fields`, `defaults`: the config, parsed with zod over the defaults; `fields` describe the form the
  UI renders (boolean, number, text, select, skill).
- `check(ctx)`: reads the board and returns candidates, only for `ctx.projects` (and the board when `ctx.board`
  is set). It must be cheap: it runs every pass.
- `act(candidate, ctx)`: does the work, with `ctx.actor` as the actor of any change, and returns the outcome.
  Agent work goes through `ctx.runner.start`; `ctx.update` records runner details while it runs. Return
  `needsAttention: true` for a failure the user should see.

An automation must never merge, close or delete tasks, force-push or push to the default branch.

### The UI

How Autopilot looks on the board (the lane pill, the header pause button, the card badge and the task panel's
Autopilot section) is in [board-layout.md](board-layout.md#autopilot-on-the-board). The settings are in
`components/autopilot/`:

- **Settings → Autopilot** (`AutopilotSettingsSection`, self-contained: it reads and writes its own queries):
  Pause all, dry run, concurrency, the daily caps, quiet hours (a switch and a start and end time), PR review
  rounds and the fix threshold. A number that is out of range is put back with a toast; an empty cap means no cap.
- **Autopilot automations** (`AutomationRows`): one row per automation with its Inherit / On / Off switch at the
  board, and a **Settings** disclosure with a form generated from its `fields`: a switch, number, text or select
  per field, and for `skill` the review skill picker (built-in skill plus skills found on disk; a skill is stored
  as a `ReviewSkillRef`, and an unset one is the built-in skill). The same rows appear in a project's settings,
  where Inherit follows the board. Config set at a scope is sent whole (the server replaces it), so editing one
  key sends the scope's other keys with it; the reset button next to a field removes the key so it inherits.
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
- **Self-made events are ignored by a depth counter** around the engine's synchronous writes, including the
  synchronous part of an action. Changes an action makes after an `await` do start a pass, which dedupe keys
  make harmless.

## Alternatives considered

| Option | Why not chosen |
| ------ | -------------- |
| A long-running agent watching the board | Costs tokens while nothing happens, and its choices can't be tested or reasoned about |
| Clearing `needs_attention` on task moves | Needs a hook in every path that changes status; deriving it can't go stale |
| Recording held candidates as queued runs | Needs queue ordering and expiry; re-checking each pass is simpler |

## Code map

| File | What it does |
| ---- | ------------ |
| `packages/contracts/src/autopilot.ts` | Modes, scopes, runs, engine settings, field descriptors, `resolveAutopilot`, `inQuietHours` |
| `apps/server/src/db/migrations/010_autopilot.sql` | `autopilot_settings`, `autopilot_runs`, the scope clean-up triggers |
| `apps/server/src/db/migrations/013_task_autopilot.sql` | `tasks.autopilot`, the per-task flag |
| `apps/server/src/db/migrations/016_autopilot_recurring.sql` | `autopilot_recurring`, the recurring-task rules |
| `apps/server/src/mcp/format.ts` | `autopilotFlagHint`, the planning-time nudge to flag a task |
| `apps/server/src/db/repos/autopilotSettings.ts`, `autopilotRuns.ts` | Their SQL, and `attentionFor` |
| `apps/server/src/services/autopilot.ts` | Settings, pause, scopes, the run lifecycle and restart recovery |
| `apps/server/src/autopilot/types.ts` | `Automation`, `Candidate`, `Runner` |
| `apps/server/src/autopilot/engine.ts` | The pass, the limits, the event and tick wiring |
| `apps/server/src/autopilot/automations/index.ts` | The catalogue |
| `apps/server/src/autopilot/automations/autoArchive.ts` | Auto-archive Done |
| `apps/server/src/autopilot/automations/recurring.ts`, `services/recurring.ts` | Recurring tasks: the automation, and the rules' service |
| `packages/contracts/src/recurring.ts` | Rule and schedule schemas, `nextDue`, `latestDue` |
| `apps/web/src/components/recurring/` | The rule list, editor and examples in project settings |
| `apps/server/src/http/routes/autopilot.ts` | The REST routes |
| `apps/web/src/components/autopilot/` | The pill, badge, panel section and settings (`autopilot.logic.ts` holds the tested logic) |
