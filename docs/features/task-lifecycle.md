# Task lifecycle

How a task moves across the board: its statuses, the plan gate, closing without doing the work,
archiving, deleting and numbering. The rules live in `apps/server/src/services/tasks.ts`, so the UI, REST
and MCP all behave the same.

## How it works

### Statuses

`backlog → planned → in_progress → review → done`, shown as Backlog, Planned, In Progress, Review and Done.
Any move in any direction is allowed, subject to the plan gate. `status_changed_at` is set only when the
status really changes. A move logs `status_changed`; closing logs `closed` instead.

The first column was called Ideas (`idea`) until migration 006 renamed it. Status inputs (REST and MCP
`move_task`, `list_tasks`) still read `idea` as `backlog` through `TaskStatusInput`, so agents with older
instructions keep working; outputs only ever say `backlog`.

An epic is a task of kind `epic` that groups others. It skips most of this: it has no plan, its status
follows its tasks (an epic delivered through an integration branch stays in Review until the branch has merged into the
default branch), it can't be closed, and it can't be archived while any of its tasks is open. See [epics.md](epics.md).

### Creating

- `add_to_backlog` (MCP) or **New task** (UI): no plan, lands in Backlog.
- `create_task` (MCP): requires a plan and lands in Planned. Like `POST /api/tasks`, it lands in Backlog
  instead when no phase of the plan has a step.
- A ticket key or URL of a configured [ticket system](ticket-systems.md), or a GitHub issue URL, as `sourceUrl` on `POST /api/tasks` (the palette's Import row): lands in
  Backlog titled after the issue, and its details are filled in in the background
  ([issue import](issue-import.md)).
- `add_to_backlog`, `create_task` and `POST /api/tasks` can set the task's Autopilot flag at creation; it
  defaults to unset ([autopilot.md](autopilot.md#the-per-task-flag)).
- A `template` (id or name) on `POST /api/tasks`, or on either MCP create tool: the template fills in what the
  input leaves out, and the task lands in Backlog unless `status: "planned"` is asked for ([templates](templates.md)).
- New tasks go to the end of their lane. Links passed at creation are added in the same write, and ticket
  keys in the title are linked automatically for systems with **Link keys in titles** on. Those links are marked `auto`.
  Editing the title links only the keys it adds, so a link someone removed isn't brought back by an edit that leaves
  its key alone, and removes the `auto` links whose key left the title. Links added on request are never removed
  automatically; agents take a wrong one off with `unlink`.
- MCP tools find the project by `projectId` or by `workspacePath`: the project whose folder contains the
  path, deepest first. For a path inside a linked git worktree (T3 Code's, Claude Code's, `git worktree
  add`) the same path in the main checkout is matched instead, so `<worktree>/apps/web` finds a project at
  `<main>/apps/web` or `<main>`. A project bound to the worktree itself (or a folder in it) still wins; any
  other match of the literal path doesn't, since Claude Code's worktrees sit inside the repo and would
  otherwise always land in its root project. `mainCheckoutOf` reads git's files rather than running git: a `.git` file whose
  `gitdir` has a `commondir` pointing at a `.git` folder. Submodules (no `commondir`) and worktrees of bare
  repositories are left alone. `add_to_backlog`, `create_task` and `create_epic` create a project for an
  unknown path (at the nearest folder with a `.git`, else the path itself; for a worktree, the main
  checkout's root, never the worktree) and unarchive an archived match. Their result then starts with "Created a
  NEW project …" and how to move the task, so an agent sees a stray lane in the same turn. Other write
  tools return `NOT_FOUND` for an unknown path; read tools treat it as an empty project. Adding a project
  from the UI takes the folder as given.
- **The General project** is a lane with no folder, for work that belongs to no code project. `startServer`
  (not `createContext`, so tests and seeds start empty) calls `projects.ensureGeneral()`, which makes it the
  first time only and stores its id under the `generalProjectId` setting (exported in backups, so a restore
  doesn't make a second one; a dump from before General existed has no such id, so restoring one gives the board a new General). The user can rename, archive or delete it; later starts never bring it back.
  `projects.general()` does: it returns the stored project, unarchiving it, or makes it again when it was
  deleted. It is what `POST /api/projects/general` (the "New general task" button and palette action) and the
  `general: true` argument of `add_to_backlog` and `create_task` call. `general: true` is refused together with
  `workspacePath` or `projectId`, and leaving all three out still fails, so work in a repo never lands there by
  accident. A new project is placed before General while General is the last lane, so it stays last until the
  user moves it. A task moves out of General like between any two projects (below). General has no folder, so
  hand-off to a T3 thread or terminal and Autopilot runs that need a checkout refuse with a clear message.

### The plan gate

A task can leave Backlog only if its plan has at least one step
([ADR 0004](../decisions/0004-plan-gate.md)). Otherwise `move` throws `PLAN_REQUIRED` (HTTP 422):

- MCP's `move_task` adds a hint: call `set_plan` and retry, or use `close_task`, which needs no plan.
- The UI shows a toast with **Write plan** when a drag is refused, and opens the plan editor when the
  status menu is.

The plan side of the gate (a plan can't be emptied outside Backlog) is in [plans.md](plans.md).

A **manual task** (`tasks.manual`, migration 035) skips the gate: it is a to-do for a person, not code, so it can
sit in any column with no plan. See [Manual tasks](#manual-tasks).

### Manual tasks

A boolean column, not a third `kind`, so a manual task is still a task: it can sit in an epic, block code tasks and
be blocked by them, and live in any project, General included. The rules are in `services/tasks.ts`:

- No plan gate in `create`, `move` or `plans.gate` (deleting its last step outside Backlog is allowed).
- It can't be flagged for Autopilot or auto-merge (`VALIDATION`); turning a task manual clears both flags, logged
  as one `updated` entry naming `manual`, `autopilot` and `autoMerge`. An epic can't be manual, and `makeEpic`
  refuses a manual task.
- Turning it back into a code task outside Backlog needs a plan, or it would sit past the gate with none.
- `reviews.effectiveAutoReview` is false for it, so entering Review opens no round, and `openRound` refuses one
  (Run review, `start_review`). Turning a task manual closes a round still pending, running or stalled as `failed`, its
  review raises no attention, and the review watchdog skips it.
- Creating one skips any T3 thread or agent session link passed with it (agents in T3 Code pass their thread on
  every create) instead of refusing the whole create.
- Agents leave it alone: `handoffModeError` refuses every hand-off mode (the prompt, `start_task_thread`, the
  terminal launcher), `links.add` refuses an `agent_session` or `t3_thread` link, and `planTaskProblem` keeps it out of planning
  sessions. The web hides the hand-off menu (`showHandoffActions`).
- Autopilot skips it in every automation that works on tasks (see [autopilot.md](autopilot.md#manual-tasks)),
  except the unblocked notification and Auto-archive.

### Entering Review

- If every polled PR of the task is merged or closed (at least one merged), the move goes straight on to
  Done, as actor `github`. Not when the task comes back from Done (a deliberate reopen), nor for an
  archived task. See [github-prs.md](github-prs.md).
- If the task is still in Review and local review applies to it, a review round opens. See
  [local-review.md](local-review.md).

### Closing without doing it

`close_task` (MCP), `POST /api/tasks/:id/close`, or the task menu in the panel:

| Resolution  | Meaning                           | `byTask`             |
| ----------- | --------------------------------- | -------------------- |
| `completed` | Another task already delivered it | Required             |
| `duplicate` | Another task covers the same work | Required             |
| `wont_do`   | No longer wanted                  | Must not be given    |

- The task moves to Done with no plan needed, and logs `closed`.
- It can't be closed against itself, or against a task that is itself closed against it.
- The other task's detail lists it under **Also resolved** (`detail.resolves`); this task's card shows
  "Done by #N" or "Duplicate of #N".
- **Reopening:** any later status change clears the resolution and the link.
- Deleting the other task keeps the resolution but drops the link, and logs `resolver_deleted` on this
  task.

### Archiving

Archive clears a card away without resolving it. `archived_at` is set and the position kept. Archived
tasks drop out of the board and lists unless asked for (`includeArchived`, **Show archived**).
Unarchiving puts the task at the end of its lane. Archiving an epic archives its Done tasks with it (same
`archived_at`, `archived` logged with `withEpic`), and unarchiving the epic brings back the tasks archived with it,
not ones archived on their own earlier. Unarchiving a task, or reopening one out of Done, inside an archived epic
unarchives that epic too and leaves its other tasks archived ([epics.md](epics.md#joining-and-leaving)). The Autopilot **Auto-archive Done** automation can archive
tasks that have sat in Done for N days (as the actor `autopilot`), and a finished epic together with its tasks
(its tasks are never archived on their own, so the epic stays Done; a Done task whose epic is already archived counts as
loose); see [autopilot.md](autopilot.md#automations).

### Deleting

Only the user deletes: the task menu's **Delete…**, the bulk menu's **Delete N tasks…**, the `task.delete` shortcut
(Delete, on the focused card or the open panel) or REST. There is no MCP tool; agents close or archive. Any task can
be deleted, archived or not, and every delete confirms first and then offers **Undo** in a toast.

A delete is a move to the trash, not a removal: `tasks.deleted_at` (migration 042) is stamped and the row stays.
Every read in `db/repos/*` skips a stamped row unless its name says otherwise (`getAny`, `byNumberAny`, the trash
functions), so the task is gone from the board, lists, search, `#N` lookups, relations, the PR poller, Autopilot,
stats and notifications without each caller checking. Rows that hang off a task (plan, links, events, reviews) stay
and come back with it; queries over them that don't join `tasks` use `liveTask(column)` from `db/repos/sql.ts`. A
reference to a trashed task (`#N` or its id) fails with `NOT_FOUND: Task #N was deleted…`, never another task.

- **Delete** (`tasks.delete(refs, {withTasks})`, `DELETE /api/tasks/:id?withTasks=1`, `POST /api/tasks/bulk-delete`):
  one write and one stamp per call, later than any stamp already in the trash, so two deletes never share one. Epics go
  last, so an epic picked together with one of its tasks takes that task with it (same stamp, same parent). Logs
  `deleted`, publishes `task.deleted`, republishes the cards that block it, are blocked by it or were closed against it,
  and logs `child_removed` (`deleted`) on its epic, which re-derives. Returns the ids that went, for Undo.
- **An epic** is deleted alone or **with its tasks** (the dialog's switch). With them, its tasks (archived ones
  included) get the epic's stamp, `deleted` with `withEpic`. Without, they are left loose at once
  (`epic_changed` with `epicDeleted`), and restoring the epic doesn't take them back.
- **Restore** (`tasks.restore(refs)`, `POST /api/tasks/restore`, the toast's Undo, Settings → **Recently deleted**):
  clears the stamp and puts the task at the end of its lane in the same status (an archived one keeps its place),
  logs `restored`, and republishes it. It rejoins its epic while that one is live, unarchived and in the same
  project; otherwise it comes back loose. An epic brings back the tasks that share its stamp
  (`trashedWith`), not ones deleted on their own. Epics are restored first, so an Undo's full id list (an epic
  and its tasks) works in any order. A task already back is skipped, so a stale Undo still restores the rest; one purged since is `NOT_FOUND`.
- **Purge** (`tasks.purge(refs)`, Settings → **Delete now**, `POST /api/tasks/trash/purge`; `purgeExpired()` at
  startup and every hour in `server.ts`) removes the row for good: the plan, links, events, review rounds and
  relations cascade, an epic takes the tasks deleted with it, tasks closed against it keep their resolution and log
  `resolver_deleted`, tasks it blocked or was blocked by log `blocker_deleted` / `blocked_deleted`, and its pasted
  images go after the commit. The scheduled purge acts as `trash`.
- **Retention** is the board setting `trashRetentionDays` (default 30, 1–365, exported in backups). `GET
  /api/tasks/trash` lists the trash, newest first, with each task's `purgeAt` and the epic it went with.

### Numbering

Tasks get a global, increasing `number`, shown as `#42`. It comes from the `counters` row
`task_number`, incremented inside the creating transaction (so a rolled-back create releases it). The
counter is a high-water mark: numbers of deleted tasks are never reused, and a task in the trash keeps its number. Anywhere a task is referenced
(REST `:id`, MCP `task`, `byTask`), a uuid, `#42` or `42` is accepted.

### Ordering and moving between projects

Cards are ordered within a lane (project and status) by a fractional-index `position`. Moves take
`beforeId` / `afterId` (MCP: `beforeTask` / `afterTask`) and only that card's position changes. Moving a
task to another project is an explicit edit (`projectId`, or MCP `moveToProjectId` /
`moveToWorkspacePath`, never auto-created) and puts it at the end of the same-status lane there.

### Attention

Derived when cards are built (`deriveAttention` in `packages/contracts/src/derive.ts`) from board state, except an
agent's request, which is stored on the task. A task needs attention when it has:

- a blocked step;
- an open or draft PR with failing checks, changes requested, or conflicts;
- an agent session waiting for input or approval, or failed (see [Sessions](#sessions-any-provider));
- a local review that stalled, got stuck, failed, or was reviewed by the board with nobody fixing it;
- a standing request from an agent (`request_attention`, see [notifications](notifications.md#agent-requests)).

These drive the card's ring and the sidebar's **Needs attention** list. Every task keeps its own reasons (and its
card's ring), but the list shows one row per waiting or failed T3 thread, not per task: tasks linked to the same
thread (a bulk planning session) collapse into a row with the thread's title and the task numbers, which `attentionItems`
(`apps/web/src/components/board/board.logic.ts`) groups by `environmentId:threadId`. The row opens the first task,
each number its own. A thread with one task stays a task row, and a grouped task with another reason (failing
checks, a blocked step) keeps a row of its own for it. Grouping follows the tasks' reasons, not the links' statuses, so
a task whose flag for the thread was dismissed isn't in the row.

#### Sessions, any provider

A waiting or failed session raises `session_needs_input` or `session_failed` whatever runs it. `sessionHealth(link)`
(`packages/contracts/src/sessionHealth.ts`) reads a `t3_thread` or `agent_session` link's snapshot as `working`,
`waiting`, `failed`, `ok` or `unknown`, with the noun the flag uses ("Thread failed", "Session failed"). It has one
reader per link kind: a new provider is added there and attention, its labels and its dismissal follow.

- A failed session stops flagging once its task is **Done**: the work finished, so the failure is history. In Review it
  still flags until dismissed. A session waiting on the user flags in any status.
- An Autopilot run's session (`finished` or `failed`, which only a run sets) raises no session flag: the `autopilot`
  reason already reports the run.
- Terminal sessions (Claude Code, Codex, Copilot CLI) have no failure the board can read today, so in practice only T3
  threads raise `session_failed`.

#### Dismissing flags

The user can dismiss any flag, one at a time or all of a task's at once, without unlinking what raised it (so a failed
thread's usage still counts). Every reason carries a `key` (what raised it) and a `fingerprint` (the state that
raised it). A dismissal stores both (`attention_dismissals`, one row per task and key) and hides the reason only while
its fingerprint is unchanged, so a new failure brings the flag back. Nothing is hidden for good.

| Reason                                    | Key                                  | Fingerprint                                          |
| ----------------------------------------- | ------------------------------------ | ---------------------------------------------------- |
| Session failed or waiting                 | `link:<linkId>`                      | The status and the session's last activity           |
| PR checks, changes requested, conflict    | `pr:<linkId>:checks\|changes\|conflict` | The head commit (`headOid`), else the PR's `updatedAt` |
| Blocked steps                             | `steps`                              | The blocked steps' ids, sorted                       |
| Review stalled, stuck, failed, unattended | `review`                             | The state and the round                              |
| Import failed                             | `import`                             | The error and when the import last changed           |
| Agent request                             | `request`                            | When it was asked                                    |
| Autopilot                                 | `autopilot`                          | The message                                          |

- `deriveAttention` returns the standing reasons and the dismissed ones apart. `TaskSummary.attention` has only the
  standing ones, so the card, the sidebar, the Needs attention filter, MCP results and Orchestrate
  (`orchestrateNeedsLooking`) all stop seeing a dismissed flag. `dismissedAttention` carries the hidden ones, with who
  dismissed them and when, for restoring.
- `POST /api/tasks/:id/attention/dismissals` dismisses the reason with the body's `key`, or every standing reason
  with no key. `DELETE` on the same path restores one (`?key=`) or all. `AttentionService` (`services/attention.ts`)
  does both. A key the task isn't flagged for is `CONFLICT`; dismissing one already dismissed does nothing.
- The agent's request and the Autopilot flag keep their own dismissal: dismissing them clears the request
  (`attention_cleared`) and sets `dismissed_at` on the task's flagged runs, as their own buttons do, and neither can be
  restored.
- Dismissing marks the matching notifications read (the PR's `checks:` and `changes:` keys, the thread's keys, the
  task's `review_finished` or `autopilot_failed`).
- The activity log gets `attention_dismissed` and `attention_restored`, each with the flags' messages.
- **Only the user dismisses.** There is no MCP tool: a flag is how a problem reaches the user, so an agent can't
  silence one. Agents clear their own request with `request_attention(clear: true)`.
- Rows are never pruned: one that matches no current reason is ignored, and dismissing the same key again replaces it.
  They cascade with the task and are part of its [backup](backup.md) bundle.
- In the UI, **Dismiss all warnings** is in the card's right-click menu and the task panel's More menu
  (`TaskMenuItems`), shown while the task has a flag.

### Missing links

Task results over MCP end with **Missing links** while the task is open: ticket keys (of the configured systems) in its
description that aren't linked yet (and in its title, for a system that doesn't link title keys itself), a T3 thread or the caller's session when it has none and the task is in progress (see [agent sessions](agent-sessions.md#how-an-agent-links-itself)), and a PR when the local review loop has
ended but none is linked. Agents act on tool results more
reliably than on instructions they read once.

## Decisions

- **Closing is a status, not archiving.** Resolved tasks stay visible in Done with who resolved them;
  archiving is only for tidying.
- **Deleting goes through a trash.** It used to be permanent and only for archived tasks, so deleting took two
  steps and a slip lost the work. Now any task can be deleted in one, because it can be undone: the trash keeps it
  for the retention period. A stamp on the row rather than a separate table keeps the plan, links and history in
  place for a restore, and filtering in the repos means no caller can forget to hide it.
- **Only the user deletes.** Agents close (which keeps the why) or archive, so the trash only holds the user's own
  deletes, and nothing an agent does can empty a task of its history.
- **Numbers are never reused.** A `#N` in a commit, a PR or a note should never point at a different task
  later, so the counter only goes up even after deletes.
- **Backlog, not Ideas.** Not everything in the first column is an idea: some are known to-dos, Jira
  tickets or GitHub issues. "Backlog" fits all of them, and the MCP tool became `add_to_backlog` with no
  `create_idea` alias, since an alias would keep the old word alive in agents' tool lists.
- **Manual is a flag, not a kind.** A third `kind` would have meant rebuilding the table and teaching every
  `kind === "task"` check about it, and a manual task wants everything a task has (epics, relations, columns).
  The flag only turns things off.
- **Moving between projects is explicit.** A drag across lanes isn't allowed; changing project is a field
  edit, so a mis-drop can't move work to another repo.

## Code map

| File                                        | What it does                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `apps/server/src/services/tasks.ts`         | `create`, `update`, `move`, `close`, `delete` / `restore` / `purge` (the trash), `addNote`, `resolveId`, search  |
| `apps/server/src/services/core.ts`          | `write` (transaction, events, publish) and `positionAmong`                     |
| `apps/server/src/services/projects.ts`      | Project resolution from a workspace path                                       |
| `apps/server/src/db/repos/tasks.ts`         | Task SQL (skipping trashed rows), `nextNumber`, `lane`, `resolvedBy`, the trash queries |
| `apps/server/src/db/migrations/042_task_trash.sql` | `deleted_at`, the trash's stamp |
| `apps/server/src/db/migrations/002_task_resolution.sql`, `003_task_number_counter.sql` | Resolution columns and the number counter |
| `apps/server/src/db/migrations/006_status_backlog.sql` | Renames the `idea` status to `backlog` (rebuilds `tasks`) |
| `apps/server/src/mcp/tools/tasks.ts`        | `add_to_backlog`, `create_task`, `move_task`, `close_task`, `update_task`, `add_note` |
| `packages/contracts/src/schemas.ts`         | `TaskStatus`, `TaskStatusInput`, `TaskResolution`, `CloseTaskInput`, `MoveTaskInput`              |
| `packages/contracts/src/derive.ts`          | `deriveAttention`, progress, current step                                      |
| `packages/contracts/src/sessionHealth.ts`   | `sessionHealth`: a session link's state, whatever runs it                      |
| `apps/server/src/services/attention.ts`, `db/repos/attentionDismissals.ts`, `db/migrations/051_attention_dismissals.sql` | Dismissing and restoring flags |
| `apps/web/src/components/task/CloseTaskDialog.tsx`, `ResolutionCallout.tsx` | Closing and "Also resolved" in the panel           |
| `apps/web/src/components/task/TaskMenuDialogs.tsx`, `deleteTasks.logic.ts` | The delete confirmation and its Undo toast |
| `apps/web/src/components/settings/RecentlyDeletedSection.tsx` | Settings → Recently deleted and the retention setting |
