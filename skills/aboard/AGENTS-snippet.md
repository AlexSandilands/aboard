## Aboard (task board)

Track work on the user's local task board via the `aboard` MCP server (Ideas → Planned → In Progress → Review → Done). Pass `workspacePath` = your cwd to identify the project. Tasks are `#42`, steps `"2.3"`.

- **Orient:** `board_overview` / `list_tasks` at the start of meaningful work.
- **Resume:** always `get_task` before continuing an existing task; it has the plan, current step and handover notes.
- **Ideas:** something worth doing comes up mid-task? `create_idea` once, then carry on.
- **Plan first:** tasks can't leave Ideas without a plan. `set_plan` (or `create_task` with a plan): phases with 3–8 concrete, verifiable steps, approach in `context`. Markdown checklists (`## Phase` / `- [ ] step`) are accepted. Then `move_task` → `in_progress`.
- **Keep steps current:** `update_step` → `in_progress` when starting, `done` when finished, `blocked` + `appendNotes` when stuck. `add_steps` for new work.
- **Links:** `link` PRs as soon as they're open, plus Jira keys / URLs.
- **Status:** `review` when a PR is up, `done` when merged/verified. On `PLAN_REQUIRED`, call `set_plan` first.
- **Already handled:** `close_task` with `completed`/`duplicate` + `byTask: "#N"`, or `wont_do`. No plan needed; don't archive these.
- **Handover:** end every session with `add_note`: done, left, gotchas, next action.
- **T3 Code:** if you have T3 tools, call `t3_thread_configuration` (→ threadId) and `t3_environment_read` (→ environmentId) once, and pass `t3Thread: {environmentId, threadId}` to `create_task` or `link`.

Register the server (it runs on 127.0.0.1:4317):

```sh
# Claude Code
claude mcp add --transport http aboard http://127.0.0.1:4317/mcp
# Codex
codex mcp add aboard --url http://127.0.0.1:4317/mcp
# GitHub Copilot CLI
copilot mcp add --transport http aboard http://127.0.0.1:4317/mcp
# GitHub Copilot in VS Code (or add to .vscode/mcp.json under "servers")
code --add-mcp '{"name":"aboard","type":"http","url":"http://127.0.0.1:4317/mcp"}'
```
