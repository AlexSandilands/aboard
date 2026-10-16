# Autopilot

Board tasks: #79 (engine core), #85 (runners), #88 (Unstick stale tasks), #90 (digest), #94 (start planned tasks), in epic #101.

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
card itself isn't "in" an epic, so it follows its project.

An automation says whether an epic can switch it with `epicScope` (default true; `describeAutomation` sends it to the
UI). Set it false when its candidates are never tasks in an epic: Auto-archive Done (it skips them) and Recurring tasks
(per project, no task) do, and so should Digest (#90) when it lands. For those the epic's popover leaves the automation out, the
epic button's state ignores it, the epic's scope entries don't list it, `PUT` of an epic switch for it is a
`VALIDATION` error, and an epic row left over from before the flag was set is ignored (`resolve` and
`projectsWithEpicOn` skip the epic level). If Auto-archive ever starts archiving tasks in epics, flipping its flag
brings the epic switch back.

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
| `maxConcurrent`        | 1               | Agent runs going at once                                             |
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
  snapshot carries the same `autopilot` object, so lanes, epic bands and cards can show what's running. Each run
  in flight carries its task's `epicId`, read from the task when the status is built (it isn't stored on the run).
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
- After `set_plan` or `create_task`, when Start planned tasks resolves On for the task (its epic, project or the board)
  and the flag is Default, the result says **Autopilot flag not set** and tells the agent to ask the user (`autopilotFlagHint`).
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
| `GET /api/autopilot/board`, `/projects/:id`, `/projects/:id/epics/:epicId` | Each automation at that scope: its own mode and config, and what it resolves to (an epic's through its project and the board) |
| `PUT /api/autopilot/board/:automation`, `/projects/:id/:automation`, `/projects/:id/epics/:epicId/:automation` | Sets mode and/or config; Inherit with no config removes the row |
| `GET /api/autopilot/runs?taskId=` or `?projectId=` | Runs, newest first (`limit`, default 50)            |

### Automations

**Auto-archive Done** (`auto_archive`, #91; `automations/autoArchive.ts`). Needs no agent and is off until switched
on. Archives (never deletes) a task that has been in Done for more than `days` days (default 14, minimum 1, set
per scope), logged as `archived` plus the note "Archived by Autopilot after N days in Done" under the actor
`autopilot`. It skips epics, tasks in an epic (archiving them would send a finished epic back to Backlog, so an epic's
switch for this automation isn't offered, see `epicScope`) and tasks with an open, draft or not-yet-polled PR. The dedupe key is `archive:<taskId>:<statusChangedAt>`, so a
manual unarchive sticks until the task leaves Done and comes back.

**Unblock dependents** (`unblock_dependents`, #92; `automations/unblockDependents.ts`). Needs no agent and is off until
switched on, with no settings. When the last unfinished blocker of a task reaches Done (or is closed as completed or
duplicate), it logs a note "Unblocked: #N finished" on the dependent and sends an `autopilot_notice` notification.
A partially unblocked dependent waits. It starts nothing: a flagged Planned dependent just becomes eligible for Start
planned tasks on the next tick. It only reports blockers that finished in the last 24 hours, so switching it on doesn't announce old work. The scope is the dependent's project. The dedupe key is
`unblock:<dependentId>:<latest blocker statusChangedAt>`, so reopening a blocker and finishing it again notifies
again, while two blockers finishing together give one notification.

**Unstick stale tasks** (`unstick`, #88; `automations/unstick.ts`). Needs no agent and is off until switched on.
Watches tasks In Progress for two things, each reported once:

- **Quiet**: no activity for `staleHours` (default 24). Activity is any activity entry not written by `autopilot`
  (its own notes and run entries don't count), or the move into In Progress. Puts "Stale: no activity for 26h" under
  Needs attention, which clears on the next activity by anyone else (or when the task changes status). The dedupe
  key is `stale:<taskId>:<lastActivityAt>`.
- **Waiting**: the task's latest T3 thread has waited on input or approval for `waitingMinutes` (default 30), by
  the snapshot's `lastActivityAt`. The thread already shows its own Needs attention reason, so only the run and the
  notification are added. The dedupe key is `waiting:<threadLinkId>:<lastActivityAt>`.

Either way it logs a note under `autopilot` and sends an `autopilot_notice`. With `nudge` on (off by default) it
also posts `nudgeMessage` ("Continue, or report what's blocking you.") into the task's live thread through the
nudge runner; it never starts a session, and a task with no live thread just says so in the run's summary. The
nudge isn't an agent run, so quiet hours and the caps don't hold it back.

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

**Start planned tasks** (`start_planned`, #94; `automations/startPlanned.ts`). Needs an agent, so it counts against
the caps and waits out quiet hours. Off until switched on. The headline automation: it starts an agent on a task.

- **Eligible** (`notStartable` is the rule; the action re-checks it, so a flag turned off between the check and the
  action skips the run): not an epic or archived, in Planned, `task.autopilot === true` (Default and Off never
  start), a plan (`progress.total > 0`) and not `blocked` by unfinished tasks. The caps and quiet hours are the
  engine's. Candidates go in board position per project, and the engine starts as many as the cap leaves room for.
- **Dedupe** `start:<taskId>:<statusChangedAt>`: once per entry into Planned, so moving a task out and back in is the
  way to try again.
- **Action**: `ctx.runner.start` with `taskHandoffPrompt` in work mode (`linkedThread: true`: the board links the
  thread or session itself, and the model line is left out, since the tier picks the model) plus an unattended note
  (no one to ask: block the step and stop) and, for a chosen skill, a line pointing at its `SKILL.md`. `tier` is the
  task's suggested tier. The agent moves the task to In Progress itself.
- **Failure**: a runner error, or the task still in Planned when the grace period ends, counted from when the action
  began. A T3 run returns once the thread has started, so the action then waits out the rest of the grace period for
  the agent to move the task; a headless run returns when the agent is done, so it is checked once, at once. A runner
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
  waiting for you holds it until you answer, and Unstick stale tasks flags it. A headless run is a running run, which
  the engine counts. A dry run ignores this.
- **Config**: the shared runner options plus `skill` (a `ReviewSkillRef`; built-in means the default workflow, labelled
  by the field's `builtinLabel`), `baseRef` (the worktree's start; blank is the default branch) and `graceMinutes`
  (15).

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

### Runners

An agent action calls `ctx.runner.start({ run, prompt, tier, options, … })` (`autopilot/runner.ts`). The engine
binds the run's `update` into it, so the session, thread or worktree is on the run as soon as it exists, and a
run that fails afterwards still shows it. A runner throws when the work couldn't be done, and the run fails
with that error.

- **`kind: "start"`** (the default) begins a new session. The automation's `runner` option picks the runner:
  **Auto** (a T3 Code thread when T3 is detected and its live poll is ok, else headless), **T3 only** (fails
  when T3 isn't connected) or **Headless only**. Once Auto has asked T3 it never falls back to headless: the
  thread may have started even when the reply was lost.
- **`kind: "nudge"`** posts the prompt into the task's latest live T3 thread (`sendToThread`). It never starts a
  session, and fails when the task has no live thread.
- **`workspace`**: `{ baseRef }` starts a new branch from that ref (default: the default branch); `{ branch }`
  starts from an existing branch, such as a pull request's, and the agent pushes back to it. The default
  branch is refused either way.
- **No task.** A run with no task (a digest's) is headless only: `claude -p` in an empty temporary folder that is
  removed afterwards, with no worktree and no session link. T3 Code and `nudge` fail for it.
- Headless only: **`access: "none"`** gives the agent no tools at all (no built-in tools, no MCP servers), for one that
  must work from its prompt alone.
- Headless only: **`access: "read-only"`** for agents that only read (a reviewer), **`tools`** to allow more
  (`Bash(gh pr review *)`), and **`outputSchema`** for a structured answer, returned as `output`. A T3 thread
  can't be held to these, so a request with any of them runs headless under Auto, and fails under T3 only.

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

**Headless.** `claude -p` in a worktree of its own (`autopilot/worktrees.ts`):

1. `git worktree add --no-track -b autopilot/<task#>-<run8> <data dir>/worktrees/<repo>/<task#>-<run8> <start>`,
   where `<start>` is the base ref, `origin/<default branch>` or `origin/<branch>`, after a best-effort fetch.
   The new branch tracks nothing, so a bare `git push` can't land on the branch it started from. A worktree
   folder that overlaps the project's checkout is refused.
2. The board picks the session id and records it on the run, with the worktree, before the agent starts. It
   also links the session to the task as an `agent_session` link ([agent sessions](agent-sessions.md)) with the
   worktree as its folder, so the card offers Open in terminal (`claude --resume <id>`). Sessions are kept:
   there is no `--no-session-persistence`.
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
  UI renders (boolean, number, text, time, select, skill; a skill field's `builtinLabel` renames its built-in entry).
- `check(ctx)`: reads the board and returns candidates, only for `ctx.projects` (and the board when `ctx.board`
  is set). It must be cheap: it runs every pass.
- `act(candidate, ctx)`: does the work, with `ctx.actor` as the actor of any change, and returns the outcome.
  Agent work goes through `ctx.runner.start` (see [Runners](#runners)); `ctx.update` records runner details while
  it runs. Return `needsAttention: true` for a failure the user should see.

An automation must never merge, close or delete tasks, force-push or push to the default branch.

### The UI

How Autopilot looks on the board (the lane pill, the epic button, the header pause button, the card badge and the
task panel's Autopilot section) is in [board-layout.md](board-layout.md#autopilot-on-the-board). The settings are in
`components/autopilot/`:

- **Settings → Autopilot** (`AutopilotSettingsSection`, self-contained: it reads and writes its own queries):
  Pause all, dry run, concurrency, the daily caps, quiet hours (a switch and a start and end time), PR review
  rounds, the fix threshold and worktree retention. A number that is out of range is put back with a toast; an empty cap means no cap.
- **Autopilot automations** (`AutomationRows`): one row per automation with its Inherit / On / Off switch at the
  board, and a **Settings** disclosure with a form generated from its `fields`: a switch, number, text, 24-hour time
  or select per field, and for `skill` the review skill picker (built-in skill plus skills found on disk; a skill is
  stored as a `ReviewSkillRef`, and an unset one is the built-in skill, labelled with the field's `builtinLabel` when
  it has one, such as the digest's own skill). The same rows appear in a project's settings,
  where Inherit follows the board; an epic's switches (its button's popover) follow its project. Config set at a scope is sent whole (the server replaces it), so editing one
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

## Code map

| File | What it does |
| ---- | ------------ |
| `packages/contracts/src/autopilot.ts` | Modes, scopes, runs, engine settings, field descriptors, `resolveAutopilot`, `inQuietHours` |
| `apps/server/src/db/migrations/010_autopilot.sql` | `autopilot_settings`, `autopilot_runs`, the scope clean-up triggers |
| `apps/server/src/db/migrations/013_task_autopilot.sql` | `tasks.autopilot`, the per-task flag |
| `apps/server/src/db/migrations/016_autopilot_recurring.sql` | `autopilot_recurring`, the recurring-task rules |
| `apps/server/src/db/migrations/020_autopilot_digests.sql` | `autopilot_digests`, the digests |
| `apps/server/src/mcp/format.ts` | `autopilotFlagHint`, the planning-time nudge to flag a task |
| `apps/server/src/db/repos/autopilotSettings.ts`, `autopilotRuns.ts` | Their SQL, and `attentionFor` |
| `apps/server/src/services/autopilot.ts` | Settings, pause, scopes, the run lifecycle and restart recovery |
| `apps/server/src/autopilot/types.ts` | `Automation`, `Candidate`, `Runner`, `RunnerRequest` |
| `apps/server/src/autopilot/runner.ts` | The T3, nudge and headless runners and the runner choice |
| `apps/server/src/autopilot/runnerOptions.ts` | The runner options every agent automation shares |
| `apps/server/src/autopilot/worktrees.ts`, `cleanup.ts` | Headless runs' worktrees and their removal |
| `apps/server/src/integrations/headlessAgent.ts` | `claude -p` arguments for agent runs, the push deny rules, the outcome |
| `apps/server/src/autopilot/engine.ts` | The pass, the limits, the event and tick wiring |
| `apps/server/src/autopilot/automations/index.ts` | The catalogue |
| `apps/server/src/autopilot/automations/autoArchive.ts` | Auto-archive Done |
| `apps/server/src/autopilot/automations/startPlanned.ts` | Start planned tasks |
| `apps/server/src/autopilot/automations/unstick.ts` | Unstick stale tasks |
| `apps/server/src/autopilot/automations/recurring.ts`, `services/recurring.ts` | Recurring tasks: the automation, and the rules' service |
| `packages/contracts/src/recurring.ts` | Rule and schedule schemas, `nextDue`, `latestDue` |
| `apps/server/src/autopilot/automations/digest.ts`, `autopilot/digest.ts` | Digest of what changed: the automation, making a digest (plain, summarised, the fallback) and "digest now" |
| `apps/server/src/autopilot/digestBuilder.ts`, `digestConfig.ts` | The plain digest's Markdown, and the automation's config |
| `apps/server/src/services/digests.ts`, `db/repos/autopilotDigests.ts` | Collecting the period's activity, storing digests, the inbox notification |
| `packages/contracts/src/digest.ts` | `Digest`, `dueDigestSlot` |
| `apps/web/src/components/recurring/` | The rule list, editor and examples in project settings |
| `apps/server/src/http/routes/autopilot.ts` | The REST routes |
| `apps/web/src/components/autopilot/` | The pill, epic button, their shared popover (`ScopePopover`), badge, panel section and settings (`autopilot.logic.ts` holds the tested logic) |
