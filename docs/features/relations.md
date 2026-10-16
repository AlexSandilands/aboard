# Task relations

Board task: #80.

A task can wait on other tasks: "A blocks B" means B isn't ready until A is Done. Relations cross projects,
epics can take part, and they show on the card (a lock), in the panel (a Relations section) and as lines
drawn between cards when the pointer is on one. Agents set them over MCP and are told not to start a
blocked task.

## How it works

### The rule

A relation is stored once, as one row of `task_relations` (`blocker_id`, `blocked_id`, `created_at`,
`actor`); "blocked by" is the same row read from the other side. A task is **blocked** while any of its
blockers isn't in Done. Any resolution counts as finished, so closing a blocker as `wont_do` frees what it
blocked, and reopening it blocks them again. A blocker that is archived but not Done still blocks; the panel
greys it and says "archived", and the board has no card for it.

| Rule               | Behaviour                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Self-relation      | Refused (`VALIDATION`); the table also has a `CHECK`                                                           |
| Cycles             | Refused with the chain: `#5 cannot block #1: that would make a cycle (#1 blocks #4 blocks #5 blocks #1)`      |
| Archived task      | Neither end may be archived when a relation is added; removing one is always allowed                           |
| Done tasks         | Can be either end. A Done task never shows as blocked on its card                                              |
| Adding twice       | A no-op: no event, no error                                                                                    |
| Deleting a task    | Its relations go with it (`ON DELETE CASCADE`); the other tasks log `blocker_deleted` or `blocked_deleted`     |
| Deleting a project | Tasks elsewhere related to its tasks lose the relation and are refreshed                                       |

`TaskSummary` carries `blockedBy` and `blocks` (each `{id, number, title, status, archived}`, by number) and
`blocked`, derived by `isBlocked` in `packages/contracts/src/derive.ts`. Nothing is stored except the rows.
Both lists are built with the other summary fields in `services/summaries.ts`.

### Writing relations

`services/relations.ts` holds `addBlockersIn` and `removeBlockersIn`, called inside the write of
`tasks.create` (`blockedBy`) and `tasks.update` (`addBlockedBy`, `removeBlockedBy`; removals run first so one
call can swap a blocker). They take a uuid, `#42` or `42`. Each change logs on **both** tasks
(`blocker_added` / `blocks_added`, `blocker_removed` / `blocks_removed`), so the activity of each shows it.
There are no relation routes of their own: REST is `PATCH /api/tasks/:id` and `POST /api/tasks`.
A call is all or nothing: a cycle among several blockers rolls the whole update back.

A card lists the status and title of the tasks it relates to, so a change to a task also refreshes the cards
at the other end of its relations: `flush` in `services/core.ts` adds each changed task's neighbours to the
`task.upserted` events it publishes. That is how a blocker moving to Done unlocks its dependents on every open
browser.

### Backup

`task_relations` is a root file of a folder dump (`relations.json`) and a `task_relations` array in the
single-file form. A backup from before relations existed has neither, and still restores. Restoring one task
puts its relations back (those in the backup when it was deleted, those it has now when it replaces a task) for
tasks still on the board, skipping any that would now make a cycle ([backup](backup.md)).

### Agents

- `blockedBy` on `create_task` and `add_to_backlog`; `addBlockedBy` and `removeBlockedBy` on `update_task`.
- `get_task` prints **Blocked by** (each blocker with its status, and "blocked until #N are Done") and
  **Blocks**. `list_tasks`, `board_overview` and `epic_overview` add `blocked by #N` (open blockers only) to a
  blocked task's line.
- The server instructions, the skill, the AGENTS snippet and the hand-off prompts say not to start a blocked
  task. The work prompt adds that line for a blocked task; the epic's orchestrator prompt leaves blocked tasks
  out of the first wave.

An epic can block and be blocked (it shows in `get_task`, the panel and other cards' lists), but its band has
no lock and takes no part in the lines: hovering a band draws nothing, and a card related to an epic gets a
stub toward the epic's column as if it were hidden.

Starting blocked tasks automatically is the autopilot's job and reads `blocked`; nothing here starts a task.

### On the board

- **Card.** A lock in the card's top row with "Blocked by #79, #80" on hover (open blockers only). Shown while
  the task is blocked and not Done.
- **Panel.** A Relations section (reorderable and hideable like the others, collapsed when empty) with
  **Blocked by** and **Blocks** lists: number, title, status, `archived` when it has left the board, a × to
  remove, and an **Add** picker that searches the board's tasks and leaves out itself, what is already there
  and anything that would close a loop (`relationCandidates`). Adding to Blocks edits the other task.
- **Lines.** `DependencyLines` draws an SVG over the board's scrolling content. The card under the pointer, or
  else the open one, is the focus: green curves run to the tasks it unblocks when it finishes, red to the tasks
  it waits on, with an arrowhead at the blocked end. **Shift** draws the whole chain both ways, and each level
  further out is a little darker (`edgeColor`). Lines to a Done blocker are dashed and faint. A related card that
  isn't shown (in a collapsed column or lane, or filtered out) gets a short stub toward its column or lane with
  its number. Selecting a card softens its lines. The overlay takes no pointer events, scrolls with the board,
  measures again on resize and content changes, and is hidden while a card is dragged.

## Decisions

- **One row per pair.** A second table of "blocked by" rows would drift out of step. The reverse view is a
  query, and both summaries are built from the same rows.
- **Done, not "closed as completed".** A blocker that is won't-do or a duplicate can't deliver what it was
  blocking on, but leaving its dependents stuck forever is worse. Reopening it re-blocks them.
- **Cycles are refused, not tolerated.** A cycle can never be satisfied, so the lines and "ready" checks
  would have to cope with something meaningless. The error spells out the loop so the agent can pick the
  relation to drop.
- **Neighbours are refreshed in `flush`.** Listing each change's neighbours in every service would be easy to
  forget; doing it where events are published covers status moves, closes, renames, archives and deletes.
- **Relations of an archived task stay.** Archiving shouldn't release what waits on it, or an archived idea
  would silently unblock work. Close it (`close_task`) or remove the relation.

## Alternatives considered

| Option                                          | Why not chosen                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| General relation types (relates to, duplicates) | Closing already covers duplicates; blocking is the one that changes what an agent does |
| A separate `blocked` status or column           | A task is blocked by what others are doing, so it follows them; stored it would go stale |
| Lines drawn per card in the DOM                 | They would re-render with every card and can't cross lanes or columns                  |

## Code map

| File                                                   | What it does                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `apps/server/src/db/migrations/010_task_relations.sql` | The table                                                               |
| `apps/server/src/db/repos/relations.ts`                | Rows, neighbours and `path` (the cycle check)                           |
| `apps/server/src/services/relations.ts`                | Add and remove with cycle detection, activity on both tasks             |
| `apps/server/src/services/summaries.ts`, `core.ts`     | `blockedBy`, `blocks`, `blocked`; neighbours refreshed on publish       |
| `apps/server/src/services/backup/*`                    | Dump, folder file and restore of relations                              |
| `apps/server/src/mcp/tools/tasks.ts`, `mcp/format.ts`  | The arguments, and how relations render for agents                      |
| `packages/contracts/src/derive.ts`                     | `isBlocked`                                                             |
| `apps/web/src/components/board/dependencies.logic.ts`  | Chain traversal, picker candidates, colours and curve geometry (tested) |
| `apps/web/src/components/board/DependencyLines.tsx`    | The overlay: hover and Shift, measuring, stubs                          |
| `apps/web/src/components/board/TaskCard.tsx`           | The lock                                                                |
| `apps/web/src/components/task/RelationsSection.tsx`    | The panel section and picker                                            |
