# 0004 A task needs a plan to leave Ideas

Status: Accepted

## Context

The board exists so that someone (a person or a fresh agent) can see where a task is up to and pick it up.
That only works if work in progress has a plan. But ideas come up mid-task and should cost one call to
capture, with no plan.

## Decision

- Anything may sit in Ideas without a plan.
- Moving a task to any other status requires at least one plan step. The service throws
  `PLAN_REQUIRED` (HTTP 422) otherwise, and MCP adds a hint to call `set_plan` first.
- A plan can't be emptied (by `set_plan`, deleting a phase or deleting a step) while the task is out of
  Ideas.
- `create_task` requires a plan and lands in Planned; `create_idea` needs none and lands in Ideas.
- Closing a task without doing it (`close_task`: completed elsewhere, duplicate, won't do) moves it to
  Done without a plan.

## Consequences

- Every card outside Ideas has a current step and progress.
- The gate is enforced in services, so UI drags, REST and MCP all hit it. The UI turns the error into a
  "Write plan" prompt.
- Agents have to plan before implementing, which the tool descriptions and the shipped skill explain.
- Rules are in [features/task-lifecycle.md](../features/task-lifecycle.md) and
  [features/plans.md](../features/plans.md).
