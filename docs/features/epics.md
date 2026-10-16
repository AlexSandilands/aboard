# Epics

Board task: #7.

An epic groups the tasks of a large feature ("One-page checkout") that would otherwise be scattered across a
project's lane. It shows as a band across the columns its tasks are in, with a roll-up of how far they've got,
and agents can create epics, put tasks in them and see every task's state in one call.

## How it works

### An epic is a task

An epic is a `tasks` row with `kind = 'epic'`; its tasks point at it with `parent_id`
([ADR 0007](../decisions/0007-epic-is-a-task-kind.md)). So it has a `#N`, a description, labels, links (such
as the T3 thread coordinating it), notes and activity like any task. What differs:

| Rule                                 | Enforced in                                                    |
| ------------------------------------ | -------------------------------------------------------------- |
| No plan: `set_plan`, adding a phase and creating one with a plan are refused | `noPlanOnEpic` in `services/plans.ts`, `create` in `services/tasks.ts` |
| No status of its own: `move` refuses a status change (reordering within the column is fine) | `move` in `services/tasks.ts` |
| Can't be closed, reviewed, or moved to Done by its PRs merging | `close`, `reviews.openRoundIn`, `links.completeIfPrsDone` |
| Epics don't nest                     | `create` / `update` in `services/tasks.ts`                     |
| A task and its epic share a project  | `epicFor` in `services/tasks.ts`                               |
| Can't be archived (so can't be deleted) while it has open tasks | `update` in `services/tasks.ts` |

Errors are `VALIDATION` with a message that says what to do instead (plan the tasks, move the tasks).

### Status follows the tasks

An epic's status is derived from its tasks that aren't archived (`deriveEpicStatus` in
`packages/contracts/src/derive.ts`): the furthest-back status any of them is in, Done once every one is done or
closed, Backlog while it has none. It is stored on the row, so lists, filters and column counts read it like
any other status.

`syncEpic` in `services/tasks.ts` recomputes it in the same write whenever a task joins or leaves the epic,
changes status, is closed or reopened, archived or unarchived, moved to another project, or deleted. A change
logs `status_changed` on the epic with `fromChildren: true` ("follows its tasks" in the activity log) and
moves the epic to the end of its new column.

### Joining and leaving

- `epicId` on create or update (uuid, `#N` or `N`) puts a task in an epic; `null` takes it out. Each change
  logs `epic_changed` on the task and `child_added` / `child_removed` on the epic.
- Moving a task to another project takes it out of its epic, unless the same update names an epic there.
- Moving an epic to another project takes its tasks with it.
- `create_epic` creates the epic and adds its `tasks` in one write (`tasks.createEpic`), and refuses a task
  already in another epic rather than moving it.
- Renaming an epic republishes its tasks, whose cards and panels show its title.
- An epic is archived only once none of its tasks is open: an archived epic leaves the board, and its open
  tasks would show loose while still claiming it. Restoring an epic from a backup takes back only the tasks
  still in its project.
- Deleting an epic leaves its tasks loose (`ON DELETE SET NULL`) and logs `epic_changed` with
  `epicDeleted` on each. Deleting a task logs `child_removed` with `deleted` on its epic.
- The roll-up (`rollup` on `TaskSummary`: total, done and a count per status) ignores archived tasks; the
  epic's detail (`children`) still lists them.

After commit, a changed task also sends `task.detail_changed` for its epic, whose panel lists the tasks'
cards (`flush` in `services/core.ts`).

### On the board

Each lane stacks its epic bands above the loose cards, oldest epic first (`buildLanes` in `board.logic.ts`):

- A band covers only the columns from its first task's to its last's (`bandSpan`); an empty epic sits in
  Backlog. Each band gets its own grid row, and its cells sit on the lane's columns through a CSS
  `subgrid`, so its cards line up with the loose cards below.
- The header shows `#N`, the title, a roll-up bar and `done/total`; clicking it opens the epic's panel. It
  folds to the header alone (`collapsedEpics` in the board view store, per browser). One column wide, the
  roll-up moves under the title.
- Drag and drop is per **row**: a project's loose cards, or one band (`Row` in `board.logic.ts`; the drag
  data carries `rowId`). Cards change status by dragging within their band, but not across a band's edge;
  that is refused like a drag into another project. While a band's card is dragged, the band covers every
  column so the card can go anywhere.
- Filters keep the tasks that match in their band, and all of an epic's tasks when the epic itself matches.
  `?epic=<id>` shows only that band, with a chip in the board header to clear it.
- Under bands, a lane with no loose cards hides its empty loose row.

### In the panel

- An epic's panel shows **Tasks** where a task shows where it's up to (`EpicChildren.tsx`): the roll-up, then
  each task by status with its progress, current step, attention and live T3 thread. **Show on board** sets
  `?epic=`, **Add task** opens the palette with the epic preselected.
- The status in the top bar is read-only (`Epic · Backlog`), and Plan, Local review, Reopen and Close as… are
  hidden.
- A task's panel shows its epic as a chip under the title, and **More actions → Epic** moves it into another
  open epic in its project, out of its epic, or into a new one.
- **New epic…** is in the command palette and the lane header.
- The hand-off menu offers the epic's one prompt, the orchestrating prompt: **Copy prompt to start its tasks**,
  and **New T3 Code thread…** without **Plan with me** (see [Orchestrating](#orchestrating-an-epic)).

### Over MCP

- `create_epic` creates one, optionally with existing `tasks`, all checked before anything is written.
- `add_to_backlog`, `create_task` and `update_task` take `epic`; `list_tasks` filters by it.
- `get_task` on an epic, and `epic_overview`, list its tasks by status with each one's summary line, live T3
  thread, latest note and newest activity: enough to monitor tasks however they were started. The epic's
  render explains that it has no plan instead of asking for one.
- List lines mark epics `[epic]` with their roll-up, and tasks in one with `in epic #N`. `board_overview`
  counts only tasks and lists open epics per project.

### Orchestrating an epic

The point of an epic is to start its tasks together rather than one by one. Handing off an epic (the hand-off
menu, or `get_handoff_prompt` over MCP) gives the agent an **orchestrating prompt** (`taskHandoffPrompt` with
mode `orchestrate`, in `packages/contracts/src/handoff.ts`). The agent that runs it is the **orchestrator**:

1. It reads `epic_overview`.
2. It drafts plans for tasks still in Backlog, shows them to the user together, and once the user approves
   saves each with `set_plan` and moves it to Planned. No task starts before its plan is approved.
3. It works out which tasks can run in parallel and tells the user the order.
4. It starts each task by the first route the harness supports:
   - **T3 Code threads**, when `epic_overview` says T3 Code is available: `start_task_thread(task)` per task (see
     [below](#t3-code-threads)).
   - **Subagents** (Claude Code's Agent tool, Copilot CLI's subagents or the equivalent), one per task, each
     given `get_handoff_prompt(task, subagent: true)`, on its own git worktree and branch when they run in
     parallel.
   - **Manual**: the prompts from `get_handoff_prompt(task)` for the user to paste into new sessions.
5. It monitors through `epic_overview`, which shows what every route writes over MCP: progress, current step,
   blocked steps, review rounds and notes. It talks to a T3 thread with `message_task_thread`, to a subagent
   directly where the harness allows it, and to any other session through `add_note` on its task, which that
   session reads on its next `get_task`.
6. It runs the review loop for subagent tasks (below), and leaves an `add_note` handover on the epic.

The prompt names harnesses only as examples, so the same text reads right in any of them.

#### T3 Code threads

Starting threads with no one watching is off until the user turns on **Settings → T3 Code → Let agents start
threads** (`agentT3Threads`). Unlike the launch dialog, nobody sees the model or access before the agent starts,
and messages land in threads as if the user had typed them.

`epic_overview` starts with a line saying whether an agent can start threads for the epic's project
(`t3LaunchBlocker` in `apps/server/src/mcp/shared.ts`). That needs T3 running, a token set, the setting on and a
project folder, the same checks as the board's **New T3 Code thread…**. Whether T3 knows the project, or has a model
ready, is only found out at launch. If it can:

- `start_task_thread(task, mode?, baseRef?, startFromOrigin?)` starts a thread with the task's hand-off prompt
  (the linked-thread variant, with the mode defaulting like the menu) and links it. There is no dialog, so
  `autoLaunchSettings` (`integrations/t3Launch.ts`) picks what the dialog would start on:
  - the model: the suggested tier's model for work, else T3's default;
  - the access: T3's default, or the most the provider allows below it, never more (no supported mode at
    or below it refuses the launch);
  - the workspace: **always a new worktree**, so tasks can run side by side. It branches from `baseRef` (the
    default branch when there is none). With a `baseRef` it starts from the local branch unless
    `startFromOrigin` says otherwise, because a branch to build on is usually another task's unpushed one. A
    folder that isn't a git repository runs in the folder itself, and the result says to start such tasks one
    at a time. If T3 can't list the branches, the launch is refused rather than falling back to the shared
    checkout.

  The result names the model, access and workspace it chose, and says when the suggested model wasn't used.
- Both tools work only on a task in an epic; other tasks are started from the board. `baseRef` must look like
  a branch name (no leading `-`, `..`, spaces or the characters git refuses).
- The launch's `commandId` is derived from the task and how many threads were ever linked to it (unlinked ones
  included, so removing a link never brings an old id back). A retry after a timeout or an
  unreadable reply therefore gets the same thread back from T3 instead of a second one. The error says so and
  doesn't suggest another route.
- It refuses a task that already has a thread on it: working, waiting, asking for input or approval, or linked
  in the last two minutes and not yet polled. It says to message that thread instead. A thread that is done,
  failed, idle or settled doesn't block a new one.
- When T3 can't take the task, the error says why and points at `get_handoff_prompt(task, subagent: true)` and the
  pasted-prompt route.
- `message_task_thread(task, text)` posts into the thread busy on the task, else its newest one that isn't
  archived. It uses the same `message.dispatch` as the [review nudge](local-review.md), prefixed "From the agent
  orchestrating this task's epic (sent through the board)". Each call is a new message, so a retry can post it twice.

A Jira import run, which reads untrusted issue text, denies tools named with `message`, `dispatch`, `launch` or
`start` among its write verbs, so an injected instruction can't drive these tools.

T3 threads are top-level sessions, so they run their own review loop.

#### Subagent tasks

A subagent can't ask the user anything, and most harnesses don't let it start subagents of its own, which the
[review loop](local-review.md) needs. So a subagent gets its own variant of the work prompt
(`subagent: true`):

- when it needs an answer, it marks the step blocked with a note and reports back;
- when its `move_task` to Review opens a review round, it doesn't run the loop or open a PR: it reports the
  round number and stops;
- it ends with a short report for the orchestrator, and doesn't link a T3 thread (it has none of its own);
- the suggested model line goes to the orchestrator in `get_handoff_prompt`'s result, since only the
  orchestrator can choose the subagent's model.

The orchestrator then runs the loop for it. It reads the task first: when the board's own reviewer already
submitted the round and left blocking or major findings open, it goes straight to the fixes. Otherwise `start_review(task)` returns the brief of the round that is already
open (it doesn't open another), a fresh reviewer subagent in the task's worktree submits its findings, an implementer subagent in the
task's worktree fixes them and calls `resolve_finding`, and `start_review` opens the next round when one is due.
When the loop ends, the implementer opens and links the PR. If the board's own reviewer has already taken the round
(`start_review` says it is being reviewed), the orchestrator waits for it. The `move_task` result still describes
the loop to the subagent, so its prompt says to ignore that. Sessions the user started run their own loop.

## Decisions

- **Derived and stored status.** Deriving keeps an epic honest without anyone moving it, and storing it
  means every list, filter and count works unchanged. The cost is that every change to a task's status,
  epic, project or archive state must call `syncEpic`.
- **Furthest-back open task sets the column.** An epic in Review whose last task hasn't started would claim
  more than it has done; the furthest-back task is where attention is needed.
- **Bands span only their tasks' columns.** From the user's sketch: the band reads as "this feature is
  between Planned and Review" at a glance, and short bands don't push the loose cards far down.
- **Subagents report back at a review round.** The alternative, letting each subagent run its own loop, fails
  in harnesses where a subagent can't start subagents; it would review its own work. The orchestrator has a
  subagent tool, so it runs the loop for all of them.
- **One orchestrating prompt for every harness.** The prompt describes routes in order of preference and names
  harnesses only as examples, rather than the board guessing which harness will receive a copied prompt.
- **No dragging across a band's edge (yet).** A drop at a band's edge is easy to make by accident and would
  silently change the task's epic; the panel's Epic menu makes that change on purpose.

## Alternatives considered

| Option                                       | Why not chosen                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A separate `epics` table                     | Duplicates numbering, links, notes, labels and activity, which an epic needs as much as a task does  |
| Epics as a label                             | No roll-up, no description or links of its own, and nothing stops a task carrying two                |
| An epic as an ordinary card in its column    | Its tasks would be scattered around it; the band shows them together                                 |
| Nested epics                                 | Not needed for a feature-sized grouping, and every rule above would need a recursive version         |

## Code map

| File                                                   | What it does                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| `apps/server/src/db/migrations/009_epics.sql`          | `kind` and `parent_id` on `tasks`                                     |
| `apps/server/src/services/tasks.ts`                    | `epicFor`, `syncEpic`, joining and leaving, the epic rules            |
| `apps/server/src/services/summaries.ts`                | `parent` and `rollup` on summaries                                    |
| `packages/contracts/src/derive.ts`                     | `deriveEpicRollup`, `deriveEpicStatus`, `describeEpicRollup`          |
| `apps/web/src/components/board/board.logic.ts`         | Bands, rows, the `?epic=` filter (tested)                             |
| `apps/web/src/components/board/EpicBand.tsx`           | The band and its roll-up bar                                          |
| `apps/web/src/components/task/EpicChildren.tsx`, `epic.logic.ts` | The epic's Tasks card; the Epic menu's options (tested)     |
| `apps/server/src/mcp/tools/tasks.ts`, `tools/read.ts`  | `create_epic`, `epic` arguments, `epic_overview`, `get_handoff_prompt` |
| `packages/contracts/src/handoff.ts`                     | The orchestrating prompt and the subagent work prompt                 |
| `apps/server/src/mcp/tools/threads.ts`                  | `start_task_thread`, `message_task_thread`                            |
| `apps/server/src/integrations/t3Launch.ts`              | `autoLaunchSettings`: a launch without the dialog                      |
| `apps/server/src/mcp/format.ts`                        | `renderEpicChildren`, epic lines and events                           |
