# 0007 An epic is a task with kind 'epic'

Status: Accepted

## Context

Large features span several tasks, and the board needed a way to group them: show them together, roll up
their progress and let an agent see them all at once. An epic needs most of what a task has (a `#N` to refer
to it by, a description, labels, links such as the T3 thread coordinating it, notes and an activity log) but
not a plan or a column of its own. The options were a separate `epics` table, a label convention, or a kind
of task.

## Decision

- An epic is a row in `tasks` with `kind = 'epic'`. A task belongs to at most one epic through `parent_id`
  (`ON DELETE SET NULL`).
- One level: an epic has no epic, and a task in an epic is never an epic.
- One project: a task and its epic share a project.
- An epic has no plan, can't be moved between statuses, closed or reviewed. Its status is derived from its
  tasks and stored on the row.
- The rules live in the tasks and plans services ([ADR 0001](0001-service-layer.md)), so the UI, REST and MCP
  all hit them.

## Consequences

- Everything built on tasks works for epics with no new code: numbering, `resolveId`, links and their
  pollers, notes, labels, activity, SSE events, search.
- Code that handles tasks must remember epics exist: anything that sets a status, adds a plan or treats every
  task as a work item (counts, attention lists, hand-off prompts) has to check `kind`. The epic rules list
  these in [features/epics.md](../features/epics.md).
- The plan gate ([ADR 0004](0004-plan-gate.md)) doesn't apply to epics, since nothing moves them but their
  tasks.
- Every change to a task's status, epic, project or archive state must re-derive its epic's status in the
  same write (`syncEpic`).
