# MCP

Agents use the board through an MCP server at `/mcp` on the board's port. The tools cover what an agent
needs in a session: orient, read a task, add to the backlog, plan, keep steps current, link work, move the
task along, run local review rounds and leave a handover note.

## How it works

### Transport

Stateless streamable HTTP (`apps/server/src/mcp/server.ts`). Each `POST /mcp` gets a fresh `McpServer` and
transport, with no session id, and the reply is plain JSON because no tool streams progress. `GET` and
`DELETE /mcp` return 405. The localhost guard and the optional token apply as for REST
([ADR 0003](../decisions/0003-localhost-guard.md)).

The server sends short **instructions** (`INSTRUCTIONS` in `server.ts`) that sum up the workflow: orient,
`get_task` before resuming, plan before leaving Backlog (with a suggested model tier, and suggest labels if
the task has none), keep
steps current, link the Jira issue and the T3 thread, finish with `add_note`.

### Tools

| File               | Tools                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `tools/read.ts`    | `board_overview`, `list_projects`, `list_tasks`, `get_task` (all read-only)                             |
| `tools/tasks.ts`   | `add_to_backlog`, `create_task`, `move_task`, `close_task`, `update_task`, `delete_task`, `add_note`       |
| `tools/plans.ts`   | `set_plan`, `update_plan`, `add_steps`, `update_step`                                                   |
| `tools/links.ts`   | `link` (PR URL, Jira key, URL, a T3 thread `{environmentId, threadId}` or bare thread ID; idempotent)    |
| `tools/reviews.ts` | `start_review`, `submit_review`, `resolve_finding` (see [local-review.md](local-review.md))             |

`add_to_backlog`, `create_task` and `update_task` take `labels` (`update_task` replaces the list), and
`list_tasks` filters by any of several `labels`. `board_overview` ends with **Labels in use** and their
counts. See [labels.md](labels.md).

`set_plan`, `create_task` and `update_task` take `suggestedModel: {tier, reason}`: the model tier for
implementing the task. `set_plan` keeps the current one when it's omitted; `update_task` clears it with
`null`. See [agent-handoff.md](agent-handoff.md#suggested-model).

Every tool validates its input with zod and calls a service; none holds rules of its own
([ADR 0001](../decisions/0001-service-layer.md)).

### Projects

Project-scoped tools take `projectId` or `workspacePath` (the agent's cwd). Write tools need one of them.
Read tools treat an unknown path as an empty project rather than an error. `add_to_backlog` and
`create_task` create the project when the path is new. See [task-lifecycle.md](task-lifecycle.md#creating).

### Who did it

Each write is logged with an actor, resolved in this order: the tool's `actor` argument, the client name
from `initialize`, the first meaningful product token of the User-Agent (generic HTTP clients are
ignored), then `agent`. The User-Agent step exists because a stateless server doesn't see the
`initialize` client info on later calls. `submit_review` defaults to `<actor> (reviewer)`. REST uses the
`ACTOR_HEADER` header instead, defaulting to `user`.

### Results

Results are plain text, with no `structuredContent`: Claude Code shows `structuredContent` instead of the
text when both are present.

- Most mutating tools return a headline plus the full task render without the activity log: status,
  labels, progress, current step, description, plan context, the plan with step ids
  (`1.2 [x] Title  (id: …)   <- current`), step notes, review state, links and **Missing links**. `add_to_backlog`, `link`, `add_note` and
  `delete_task` return one line; `start_review` and `submit_review` return the review brief or result.
- `get_task` returns the same render plus recent activity (`events`, default 10) and a pointer when a
  review round is waiting.
- **Missing labels** appears in `set_plan`, `create_task` and `get_task` results when the task has no
  labels and is still open. It names the labels in use and asks the agent to suggest 1–3 and wait for
  the user before calling `update_task`. Other mutation results leave it out (`taskResult`'s
  `planningHints` option).
- **Missing suggested model** appears in `set_plan` and `create_task` results for a planned, open task with
  no suggested model, asking the agent to set one with `update_task`. Unlike labels it needs no approval, and
  `get_task` leaves it out so implementing agents aren't nagged. The task render shows
  `Suggested model: deep (reason)` once set.
- `list_tasks` and `board_overview` print one line per task (`summaryLine`), labels after the title:
  `#42 Title [ui] — 3/7, at 2.1 Write tests · PR #12 open`.
- Errors come back as `isError` results reading `CODE: message`. `move_task` adds a hint to
  `PLAN_REQUIRED` (call `set_plan`, or use `close_task`); `set_plan` adds one to `CONFLICT` (use
  `update_plan`, or pass `allowDeletes`). When a `set_plan` call deleted steps, its result says
  `Deleted N step(s): 1.2 Title, …`. See [plans.md](plans.md#writing-a-plan).

### Writing tool descriptions

Descriptions are written for agents, and they are most of what an agent knows about the board:

- Say **when** to call the tool, not only what it does (`get_task` is "the 'where was I' call", and the
  instructions say to call it before resuming).
- Say what good input looks like: 1–4 phases of 3–8 concrete, verifiable steps.
- Lead with the hazard when a tool is destructive: `set_plan` opens with "REPLACES the whole plan" and
  points to `update_plan`, because agents grabbed it for bulk updates when nothing else did that.
- Explain the gate where it bites (`create_task`, `move_task`), and point to the cheap path
  (`add_to_backlog`, `close_task`).
- Put guidance agents must act on in **results** too (Missing links, Missing labels, review loop
  instructions): agents follow a result they just got more reliably than instructions read once. Show
  it only where it applies, or agents learn to skip it.
- `get_task` must not tell a reviewer to start a reviewer: the review loop instructions come only from
  `move_task` and `start_review`.

### The shipped skill

`skills/aboard/SKILL.md` (a Claude Code skill) and `skills/aboard/AGENTS-snippet.md` (for other agents'
`AGENTS.md`) teach the same workflow in more depth. They ship to other projects and aren't loaded by the
app, and no test ties them to the tool descriptions. When you rename a tool, change its arguments or change
the workflow, update both, plus `INSTRUCTIONS`.

`skills/aboard-review/SKILL.md` is different: it must match `BUILTIN_REVIEW_SKILL_BODY` in
`packages/contracts/src/reviewPrompt.ts`, the review skill the server hands out, and
`apps/server/src/skills.test.ts` enforces it. Change both together.

## Decisions

- **Stateless.** No sessions to track or expire; any request can arrive on its own, which suits agents
  that reconnect often. The cost is the lost client name, worked around through the User-Agent.
- **Text, not JSON.** Agents read text plans and summaries well, and step ids in the text let them act
  without another call.
- **A cheap path for everything.** `add_to_backlog` and `close_task` need no plan, so the gate never pushes
  an agent into faking one.

## Code map

| File                                  | What it does                                                         |
| ------------------------------------- | -------------------------------------------------------------------- |
| `apps/server/src/mcp/server.ts`       | `registerMcp`, transport, `INSTRUCTIONS`, actor resolution           |
| `apps/server/src/mcp/shared.ts`       | `run` (error mapping), shared fields, `planFromArgs`, project lookup  |
| `apps/server/src/mcp/format.ts`       | Text renders: `renderTaskDetail`, `summaryLine`, `missingLinkHints`, `labelHint`, `suggestedModelHint` |
| `apps/server/src/mcp/tools/*.ts`      | The tools                                                            |
| `apps/server/src/mcp/mcp.test.ts`, `reviews.mcp.test.ts` | End-to-end tests through the MCP SDK client           |
| `skills/aboard/`                      | The skill and `AGENTS.md` snippet shipped to agents                  |
| `skills/aboard-review/SKILL.md`       | The review skill, kept identical to `BUILTIN_REVIEW_SKILL_BODY`      |
