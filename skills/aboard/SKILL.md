---
name: aboard
description: Track work on the user's local task board (kanban over MCP). Use when starting or resuming meaningful work in a repo, when an idea or follow-up comes up mid-task, when writing an implementation plan, when finishing steps, opening PRs, or ending a session. Covers ideas, plans, step progress, PR/Jira/T3 thread links and handover notes.
---

# Aboard (task board)

The user keeps a local kanban board of their work across projects. Columns: **Ideas → Planned → In
Progress → Review → Done**, one swimlane per project. You read and update it through the `aboard`
MCP server; the board updates live in the user's browser. Identify the project by passing
`workspacePath` = your current working directory. Unknown paths create the project automatically.

Tasks are referenced as `#42`, steps as `"2.3"` (phase 2, step 3).

## Workflow

1. **Orient.** At the start of meaningful work call `board_overview` (with `workspacePath`) or
   `list_tasks`. If the user's request matches an existing task, that's the one you're working on.
2. **Resume.** Before continuing an existing task, call `get_task`. It shows the plan with statuses,
   the current step, linked PRs/threads and the latest handover notes. Pick up from there.
3. **Ideas are cheap.** When something worth doing comes up mid-task (a bug you noticed, a refactor, a
   follow-up), call `create_idea` once and carry on with your current work. Don't derail.
4. **Plan before implementing.** A task can't leave Ideas without a plan. Use `set_plan` on an existing
   task, or `create_task` for new work (plan included, lands in Planned). A good plan has phases with
   3–8 concrete, verifiable steps each ("Add links table migration", not "Backend"). Put the approach
   and key decisions in `context`. Markdown checklists work too:
   ```markdown
   ## Phase 1: Data

   - [ ] Add migration for links table
   - [ ] Repository + tests
   ```
   Then `move_task` to `in_progress`.
5. **Keep steps current.** `update_step` to `in_progress` when you start a step and `done` as soon as
   it's finished. Use `blocked` (with `appendNotes` explaining why) or `skipped` when appropriate. Found
   more work? `add_steps`. When revising with `set_plan`, pass existing step ids to keep their status.
6. **Link things.** `link` PR URLs as soon as the PR is open, plus Jira keys and relevant URLs. GitHub
   PRs show live checks/review state on the board.
7. **Status transitions.** `in_progress` while implementing → `review` when a PR is up → `done` when
   merged or verified. If `move_task` returns `PLAN_REQUIRED`, call `set_plan` first.
8. **Close what's already handled.** If a task was delivered by another task, duplicates one, or is no
   longer wanted, `close_task` it with resolution `completed` / `duplicate` (plus `byTask: "#N"`) or
   `wont_do`. It moves to Done without a plan and the other task shows it also resolved this one. Don't
   archive these: archiving hides the card and loses why it was closed. `delete_task` is permanent and
   only works on archived tasks; use it only when the user asks for a task to be deleted.
9. **Hand over.** Before ending a session, `add_note` with what you did, what's left, gotchas and the
   exact next action. The next agent starts from `get_task`.

## Running inside T3 Code

If you have the T3 Code tools, link the task to your thread so the user can jump back to it:

1. Call `t3_thread_configuration` once → `threadId`.
2. Call `t3_environment_read` once → `environmentId`.
3. Pass `t3Thread: { environmentId, threadId }` to `create_task`, or to `link` for an existing task.

T3 Code exposes no environment variable for this, so you must call those tools.

## Setup

The server runs locally on port 4317. Register it once:

```sh
claude mcp add --transport http aboard http://127.0.0.1:4317/mcp
```

Install this skill by copying the folder to `~/.claude/skills/aboard/`.
