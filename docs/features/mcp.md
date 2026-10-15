# MCP

Agents use the board through an MCP server at `/mcp` on the board's port. The tools cover what an agent
needs in a session: orient, read a task, capture ideas, plan, keep steps current, link work, move the
task along, run local review rounds and leave a handover note.

## How it works

### Transport

Stateless streamable HTTP (`apps/server/src/mcp/server.ts`). Each `POST /mcp` gets a fresh `McpServer` and
transport, with no session id, and the reply is plain JSON because no tool streams progress. `GET` and
`DELETE /mcp` return 405. The localhost guard and the optional token apply as for REST
([ADR 0003](../decisions/0003-localhost-guard.md)).

The server sends short **instructions** (`INSTRUCTIONS` in `server.ts`) that sum up the workflow: orient,
`get_task` before resuming, plan before leaving Ideas, keep steps current, link the Jira issue and the
T3 thread, finish with `add_note`.

### Tools

| File               | Tools                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `tools/read.ts`    | `board_overview`, `list_projects`, `list_tasks`, `get_task` (all read-only)                             |
| `tools/tasks.ts`   | `create_idea`, `create_task`, `move_task`, `close_task`, `update_task`, `delete_task`, `add_note`       |
| `tools/plans.ts`   | `set_plan`, `add_steps`, `update_step`                                                                  |
| `tools/links.ts`   | `link` (PR URL, Jira key, URL, or a T3 thread `{environmentId, threadId}`; idempotent)                  |
| `tools/reviews.ts` | `start_review`, `submit_review`, `resolve_finding` (see [local-review.md](local-review.md))             |

Every tool validates its input with zod and calls a service; none holds rules of its own
([ADR 0001](../decisions/0001-service-layer.md)).

### Projects

Project-scoped tools take `projectId` or `workspacePath` (the agent's cwd). Write tools need one of them.
Read tools treat an unknown path as an empty project rather than an error. `create_idea` and
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

- Mutating tools return a headline plus the full task render without the activity log: status,
  progress, current step, description, plan context, the plan with step ids
  (`1.2 [x] Title  (id: …)   <- current`), step notes, review state, links and **Missing links**.
- `get_task` returns the same render plus recent activity (`events`, default 10) and a pointer when a
  review round is waiting.
- Errors come back as `isError` results reading `CODE: message`. `move_task` adds a hint to
  `PLAN_REQUIRED` (call `set_plan`, or use `close_task`).

### Writing tool descriptions

Descriptions are written for agents, and they are most of what an agent knows about the board:

- Say **when** to call the tool, not only what it does (`get_task` is "the 'where was I' call", and the
  instructions say to call it before resuming).
- Say what good input looks like: 1–4 phases of 3–8 concrete, verifiable steps.
- Explain the gate where it bites (`create_task`, `move_task`), and point to the cheap path
  (`create_idea`, `close_task`).
- Put guidance agents must act on in **results** too (Missing links, review loop instructions): agents
  follow a result they just got more reliably than instructions read once.
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
- **A cheap path for everything.** `create_idea` and `close_task` need no plan, so the gate never pushes
  an agent into faking one.

## Code map

| File                                  | What it does                                                         |
| ------------------------------------- | -------------------------------------------------------------------- |
| `apps/server/src/mcp/server.ts`       | `registerMcp`, transport, `INSTRUCTIONS`, actor resolution           |
| `apps/server/src/mcp/shared.ts`       | `run` (error mapping), shared fields, `planFromArgs`, project lookup  |
| `apps/server/src/mcp/format.ts`       | Text renders: `renderTaskDetail`, `summaryLine`, `missingLinkHints`  |
| `apps/server/src/mcp/tools/*.ts`      | The tools                                                            |
| `apps/server/src/mcp/mcp.test.ts`, `reviews.mcp.test.ts` | End-to-end tests through the MCP SDK client           |
| `skills/aboard/`                      | The skill and `AGENTS.md` snippet shipped to agents                  |
| `skills/aboard-review/SKILL.md`       | The review skill, kept identical to `BUILTIN_REVIEW_SKILL_BODY`      |
