# 0016 A machine that holds a task orders its changes, and its log holds states

Status: Accepted

Builds on [0001](0001-service-layer.md) and [0005](0005-sse-without-replay.md), which stay as they are.

## Context

A task can be worked on by an agent on another machine (epic #178,
[remote machines](../features/remote-machines.md#held-tasks)). The board that owns the task may be off, or out of
reach, while that agent works, and the user may edit the same task on the board meanwhile. Until now a task had one
database and [0001](0001-service-layer.md)'s one path for every change, so there was nothing to reconcile.

Two databases changing one task need an answer to three things: who decides the order of changes, what travels
between them, and what the board shows of an edit the other side hasn't seen.

## Decision

- **One writer at a time.** The board owns every task. While a machine holds one, that machine orders every change
  to it; the board's row is a copy of what the machine last said, plus the board's own edits not yet answered.
- **The machine keeps a log of states.** Every write to a held task appends the task's whole state after the
  change, with the activity the change wrote, in the same transaction. The board applies entries in order, each
  once, and never re-runs the rules that produced them.
- **Every change to a task goes through a service method that `services/heldEdits.ts` wraps.** On a board, an edit
  to a held task is applied at once and queued for the machine in one write; the machine's log entry for it is what
  stays. A method that changes a task without a route there is overwritten by the machine's next entry.
- **A board reads every log format ever written.** Entries carry their format; a new format comes with an upgrader
  from the one before and a fixture that is never edited
  ([the log's format](../features/remote-machines.md#the-logs-format)).
- **A task's number never changes, and may carry a machine's prefix.** `#E7` is two fields. Code prints a number
  with `taskLabel` and reads one with `parseTaskNumberRef`; `#${task.number}` is wrong for a task a machine
  numbered.

## Consequences

- Replay is safe to repeat and needs no agreement on ids or clocks, at the cost of entries a few kilobytes each
  (dropped once applied).
- Rules run once, where the change was made. What only a board can derive (an epic's status, the place in a lane)
  is derived when an entry is applied; what a machine can't know (the task's epic, project, archive state) stays
  out of the state and is the board's alone to change.
- An edit made on the board can be refused later, when the machine sees it. The board says so in the task's
  activity and puts the card back; nothing is merged field by field.
- Review rounds and pasted images aren't part of the state yet, so they don't travel.
- A new way of changing a task has two more things to do than before: a route in `heldEdits.ts`, and, if it adds
  state an agent on a machine should be able to change, a field in the state and a new log format.
