# Plans

A task's plan is an ordered list of phases, each an ordered list of steps with a status and notes. Plans
are how anyone returning to a task, person or agent, sees where it's up to: the panel's timeline marks the
current step, and agents get the same plan as text from `get_task`.

## How it works

### Model

- **Phase:** `id`, `title`, `position`, steps.
- **Step:** `id`, `title`, Markdown `notes`, `status`, `position`, `startedAt`, `completedAt`.
- **Plan context:** a Markdown field on the task (`plan_context`) for the approach and decisions, shown
  above the plan.

| Step status   | Text mark | Meaning            |
| ------------- | --------- | ------------------ |
| `todo`        | `[ ]`     | Not started        |
| `in_progress` | `[~]`     | Being worked on    |
| `done`        | `[x]`     | Finished           |
| `blocked`     | `[!]`     | Stuck; the task needs attention |
| `skipped`     | `[-]`     | Not needed; counts as complete |

Timestamps follow the status: moving to `in_progress` sets `startedAt` (kept if already set), back to
`todo` clears it, and `done` or `skipped` set `completedAt` (other statuses clear it).

### Derived values

Computed from the steps, never stored (`packages/contracts/src/derive.ts`):

- **Progress:** done plus skipped, over all steps.
- **Current step:** the first `in_progress` step; else the first `blocked`; else the first `todo` after
  the last done or skipped step; else the first `todo`; else none. Its label is `phase.step`, 1-based
  (`2.3`).

### Writing a plan

- `set_plan` (MCP), `PUT /api/tasks/:id/plan`, or the panel's plan editor **replaces** the plan.
  - Phases and steps that carry an existing `id` are kept, with their status and notes unless the input
    sets them. A kept step may move to another phase.
  - Anything without a matching id is new; anything omitted is deleted.
  - Positions are regenerated in input order. `context` updates the plan context only when given.
  - `suggestedModel` sets the task's suggested model tier when given, and clears it when `null`
    ([agent-handoff.md](agent-handoff.md#suggested-model)).
- Smaller edits: `add_steps` (to a phase by number or id, the last phase by default, or a new phase),
  `update_step` (status, title, notes, `appendNotes`), and REST: steps can be added, edited, moved and
  deleted; phases can be added, renamed and deleted.
- Steps are referenced by id or by their `2.3` label.

### The gate on the plan side

Outside Backlog a plan can't become empty. `set_plan`, deleting a phase and deleting a step all throw
`PLAN_REQUIRED` if they'd leave a task outside Backlog with no steps. See
[task-lifecycle.md](task-lifecycle.md) and [ADR 0004](../decisions/0004-plan-gate.md).

### Markdown plans

`parsePlanMarkdown` (`packages/contracts/src/planMarkdown.ts`) turns Markdown into a plan. `set_plan`,
`create_task` and the panel's **Paste plan** accept it, so an agent can hand over the plan it already
wrote.

- **Phases** are headings. The shallowest heading level is the phase level, unless there's a single
  heading at that level with deeper ones under it: then it's a document title and the next level down
  holds the phases.
- **Steps** are list items (`-`, `*`, `+`, `1.`, `1)`), with an optional checkbox: `[ ]`, `[x]`, `[~]`,
  `[!]`, `[-]`.
- **Notes:** deeper-indented lines and anything else after a step, up to the next step or phase, become
  its notes.
- **Context:** text before the first phase or step becomes the plan context.
- Steps before any heading go into a phase called "Plan". Fenced code blocks are never parsed. Phases
  with no steps are dropped, and a plan with no steps at all is rejected.

### As text for agents

`formatPlanText` renders the plan for MCP results, with ids so agents can update steps:

```
Phase 1: Structure
  1.1 [x] Add the migration  (id: …)
  1.2 [~] Write the service  (id: …)   <- current
```

## Decisions

- **Structured phases and steps, not a Markdown blob.** Statuses per step are what make the current step,
  progress and attention possible. Markdown is accepted as input and converted.
- **Derived, not stored.** The current step and progress are computed from step statuses, so they can't
  disagree with the plan.
- **Replace keeps ids.** `set_plan` is a full replace so agents can rewrite a plan in one call, but
  matching by id keeps the status and notes of steps that survive.

## Code map

| File                                        | What it does                                                         |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `apps/server/src/services/plans.ts`         | `replacePlan`, `gate`, phase and step edits, `resolveStepId`, `withStatus` |
| `apps/server/src/mcp/tools/plans.ts`        | `set_plan`, `add_steps`, `update_step`                               |
| `apps/server/src/http/routes/plans.ts`      | REST for phases and steps                                            |
| `apps/server/src/http/routes/tasks.ts`      | `PUT /api/tasks/:id/plan` and `POST /api/tasks/:id/phases`           |
| `packages/contracts/src/planMarkdown.ts`    | `parsePlanMarkdown`                                                  |
| `packages/contracts/src/derive.ts`          | `deriveProgress`, `deriveCurrentStep`, `formatPlanText`              |
| `apps/web/src/components/task/PlanTimeline.tsx`, `PlanPhaseGroup.tsx`, `PlanStepRow.tsx`, `PlanEditor.tsx` | The timeline and editor; logic in `plan.logic.ts` |
