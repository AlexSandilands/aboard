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
follows its tasks, and it can't be closed. See [epics.md](epics.md).

### Creating

- `add_to_backlog` (MCP) or **New task** (UI): no plan, lands in Backlog.
- `create_task` (MCP): requires a plan and lands in Planned. Like `POST /api/tasks`, it lands in Backlog
  instead when no phase of the plan has a step.
- New tasks go to the end of their lane. Links passed at creation are added in the same write, and Jira
  keys in the title are linked automatically (on later title edits too).
- MCP tools find the project by `projectId` or by `workspacePath`: the project whose folder contains the
  path, deepest first. `add_to_backlog` and `create_task` create a project for an unknown path (at the
  nearest folder with a `.git`, else the path itself) and unarchive an archived match. Other write tools
  return `NOT_FOUND` for an unknown path; read tools treat it as an empty project.

### The plan gate

A task can leave Backlog only if its plan has at least one step
([ADR 0004](../decisions/0004-plan-gate.md)). Otherwise `move` throws `PLAN_REQUIRED` (HTTP 422):

- MCP's `move_task` adds a hint: call `set_plan` and retry, or use `close_task`, which needs no plan.
- The UI shows a toast with **Write plan** when a drag is refused, and opens the plan editor when the
  status menu is.

The plan side of the gate (a plan can't be emptied outside Backlog) is in [plans.md](plans.md).

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
Unarchiving puts the task at the end of its lane.

### Deleting

Permanent, and only for archived tasks: archive first, then delete (task menu, `DELETE /api/tasks/:id` or
`delete_task`). The plan, links, events and review rounds go with it. Tasks resolved by it lose the link,
not their resolution.

### Numbering

Tasks get a global, increasing `number`, shown as `#42`. It comes from the `counters` row
`task_number`, incremented inside the creating transaction (so a rolled-back create releases it). The
counter is a high-water mark: numbers of deleted tasks are never reused. Anywhere a task is referenced
(REST `:id`, MCP `task`, `byTask`), a uuid, `#42` or `42` is accepted.

### Ordering and moving between projects

Cards are ordered within a lane (project and status) by a fractional-index `position`. Moves take
`beforeId` / `afterId` (MCP: `beforeTask` / `afterTask`) and only that card's position changes. Moving a
task to another project is an explicit edit (`projectId`, or MCP `moveToProjectId` /
`moveToWorkspacePath`, never auto-created) and puts it at the end of the same-status lane there.

### Attention

Derived when cards are built (`deriveAttention` in `packages/contracts/src/derive.ts`), never stored. A
task needs attention when it has:

- a blocked step;
- an open or draft PR with failing checks, changes requested, or conflicts;
- a T3 thread waiting for input or approval, or failed;
- a local review that stalled, got stuck, failed, or was reviewed by the board with nobody fixing it.

These drive the card's ring and the sidebar's **Needs attention** list.

### Missing links

Task results over MCP end with **Missing links** while the task is open: Jira keys in its title or
description that aren't linked yet, and a T3 thread when it has none. Agents act on tool results more
reliably than on instructions they read once.

## Decisions

- **Closing is a status, not archiving.** Resolved tasks stay visible in Done with who resolved them;
  archiving is only for tidying. That's why delete requires archive but close doesn't.
- **Numbers are never reused.** A `#N` in a commit, a PR or a note should never point at a different task
  later, so the counter only goes up even after deletes.
- **Backlog, not Ideas.** Not everything in the first column is an idea: some are known to-dos, Jira
  tickets or GitHub issues. "Backlog" fits all of them, and the MCP tool became `add_to_backlog` with no
  `create_idea` alias, since an alias would keep the old word alive in agents' tool lists.
- **Moving between projects is explicit.** A drag across lanes isn't allowed; changing project is a field
  edit, so a mis-drop can't move work to another repo.

## Code map

| File                                        | What it does                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `apps/server/src/services/tasks.ts`         | `create`, `update`, `move`, `close`, `delete`, `addNote`, `resolveId`, search  |
| `apps/server/src/services/core.ts`          | `write` (transaction, events, publish) and `positionAmong`                     |
| `apps/server/src/services/projects.ts`      | Project resolution from a workspace path                                       |
| `apps/server/src/db/repos/tasks.ts`         | Task SQL, `nextNumber`, `lane`, `resolvedBy`                                   |
| `apps/server/src/db/migrations/002_task_resolution.sql`, `003_task_number_counter.sql` | Resolution columns and the number counter |
| `apps/server/src/db/migrations/006_status_backlog.sql` | Renames the `idea` status to `backlog` (rebuilds `tasks`) |
| `apps/server/src/mcp/tools/tasks.ts`        | `add_to_backlog`, `create_task`, `move_task`, `close_task`, `update_task`, `delete_task`, `add_note` |
| `packages/contracts/src/schemas.ts`         | `TaskStatus`, `TaskStatusInput`, `TaskResolution`, `CloseTaskInput`, `MoveTaskInput`              |
| `packages/contracts/src/derive.ts`          | `deriveAttention`, progress, current step                                      |
| `apps/web/src/components/task/CloseTaskDialog.tsx`, `ResolutionCallout.tsx` | Closing and "Also resolved" in the panel           |
