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
- The hand-off menu (copy prompt, new T3 thread) is hidden on epics: the task prompt asks for a plan and a
  move, which an epic refuses. What's missing is a prompt that starts and coordinates an epic's tasks.

### Over MCP

- `create_epic` creates one, optionally with existing `tasks`, all checked before anything is written.
- `add_to_backlog`, `create_task` and `update_task` take `epic`; `list_tasks` filters by it.
- `get_task` on an epic, and `epic_overview`, list its tasks by status with each one's summary line, live T3
  thread, latest note and newest activity: enough to monitor tasks however they were started. The epic's
  render explains that it has no plan instead of asking for one.
- List lines mark epics `[epic]` with their roll-up, and tasks in one with `in epic #N`. `board_overview`
  counts only tasks and lists open epics per project.

## Decisions

- **Derived and stored status.** Deriving keeps an epic honest without anyone moving it, and storing it
  means every list, filter and count works unchanged. The cost is that every change to a task's status,
  epic, project or archive state must call `syncEpic`.
- **Furthest-back open task sets the column.** An epic in Review whose last task hasn't started would claim
  more than it has done; the furthest-back task is where attention is needed.
- **Bands span only their tasks' columns.** From the user's sketch: the band reads as "this feature is
  between Planned and Review" at a glance, and short bands don't push the loose cards far down.
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
| `apps/server/src/mcp/tools/tasks.ts`, `tools/read.ts`  | `create_epic`, `epic` arguments, `epic_overview`                      |
| `apps/server/src/mcp/format.ts`                        | `renderEpicChildren`, epic lines and events                           |
