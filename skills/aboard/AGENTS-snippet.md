## Aboard (task board)

Track work on the user's local task board via the `aboard` MCP server (Backlog → Planned → In Progress → Review → Done). Pass `workspacePath` = your cwd to identify the project. Tasks are `#42`, steps `"2.3"`.

- **Orient:** `board_overview` / `list_tasks` at the start of meaningful work.
- **Resume:** always `get_task` before continuing an existing task; it has the plan, current step and handover notes. Add any **Missing links** it lists.
- **Backlog:** something worth doing comes up mid-task (an idea, a follow-up, a ticket for later)? `add_to_backlog` once, then carry on.
- **Plan first:** tasks can't leave Backlog without a plan. `set_plan` (or `create_task` with a plan): phases with 3–8 concrete, verifiable steps, approach in `context`. Markdown checklists (`## Phase` / `- [ ] step`) are accepted. Set `suggestedModel: {tier: "light" | "standard" | "deep", reason}` by how much reasoning implementing it needs. Then `move_task` → `in_progress`.
- **Labels:** tag tasks with the kind of work (`labels: ["ui"]`, `["backend", "bug"]`) on `create_task` / `add_to_backlog` or `update_task` (replaces the list). Reuse the labels `board_overview` lists. If a task you plan has none (**Missing labels** in the result), suggest 1–3 to the user and apply them once they agree.
- **Keep steps current:** `update_step` → `in_progress` when starting, `done` when finished, `blocked` + `appendNotes` when stuck or before asking the user a question and waiting (say what you need; back to `in_progress` once answered). `add_steps` for new work, `update_plan` to change many steps at once (statuses, notes, moves, phase renames). `set_plan` REPLACES the whole plan (steps not passed back with their id are deleted, status and notes too): only for writing or rewriting a plan, never to update a few steps.
- **Links:** link the Jira key when the task is created (`links` on `create_task` / `add_to_backlog`, or `link`); keys in the title are linked automatically. `link` PRs as soon as they're open.
- **Status:** `review` when the work is done, `done` when merged/verified. On `PLAN_REQUIRED`, call `set_plan` first.
- **Local review:** if moving to `review` says a review round is open, run the loop it describes before opening the PR: a fresh reviewer subagent per round (`submit_review`), fix and `resolve_finding` each blocking/major finding, `start_review` for the next round, until clean or the limit, then always open and link the PR (at the limit too, listing open findings in it), or push to the one already linked. Without auto-review, open and link the PR before moving to `review`.
- **Epics:** a large feature split into several tasks in one project. `create_epic` (with `tasks: ["#4", "#5"]` to group existing ones), then `epic: "#N"` on `create_task` / `add_to_backlog`, or `update_task(epic: "#N" | null)`. An epic has no plan or column of its own; its status follows its tasks, so plan, move and review the tasks. `epic_overview` (or `get_task` on the epic) shows each task's progress, current step, last note and thread. To start an epic's tasks, `start_task_thread(task)` when `epic_overview` says T3 Code is available (`message_task_thread` talks to the thread), else `get_handoff_prompt(task, subagent: true)` gives each subagent its prompt; a subagent stops at an open review round and the orchestrator runs the loop.
- **Already handled:** `close_task` with `completed`/`duplicate` + `byTask: "#N"`, or `wont_do`. No plan needed; don't archive these.
- **Handover:** end every session with `add_note`: done, left, gotchas, next action.
- **T3 Code:** if you have T3 tools, call `t3_thread_configuration` (→ threadId) and `t3_environment_read` (→ environmentId) once, and pass `t3Thread: {environmentId, threadId}` to `create_task` / `add_to_backlog`, or to `link` whenever you start or resume an existing task.
- **Your session:** in Claude Code or Copilot CLI (inside T3 Code too), when you start or resume a task, `link(agentSession: {harness: "claude-code" | "copilot-cli", sessionId, cwd})` with the id from `$CLAUDE_CODE_SESSION_ID` or `$COPILOT_AGENT_SESSION_ID` and your working directory. The board shows whether it is running and can reopen it in a terminal.

Register the server (it runs on 127.0.0.1:4317):

```sh
# Claude Code
claude mcp add --scope user --transport http aboard http://127.0.0.1:4317/mcp
# Codex
codex mcp add aboard --url http://127.0.0.1:4317/mcp
# GitHub Copilot CLI
copilot mcp add --transport http aboard http://127.0.0.1:4317/mcp
# GitHub Copilot in VS Code (or add to .vscode/mcp.json under "servers")
code --add-mcp '{"name":"aboard","type":"http","url":"http://127.0.0.1:4317/mcp"}'
```
