---
name: aboard
description: Track work on the user's local task board (kanban over MCP). Use when starting or resuming meaningful work in a repo, when an idea, follow-up or ticket to pick up later comes up mid-task, when writing an implementation plan, when splitting a large feature into tasks, when finishing steps, opening PRs, or ending a session. Covers the backlog, plans, epics, blocking between tasks, step progress, PR/Jira/T3 thread links and handover notes.
---

# Aboard (task board)

The user keeps a local kanban board of their work across projects. Columns: **Backlog → Planned → In
Progress → Review → Done**, one swimlane per project. You read and update it through the `aboard`
MCP server; the board updates live in the user's browser. Identify the project by passing
`workspacePath` = your current working directory. Unknown paths create the project automatically.

Tasks are referenced as `#42`, steps as `"2.3"` (phase 2, step 3).

## Workflow

1. **Orient.** At the start of meaningful work call `board_overview` (with `workspacePath`) or
   `list_tasks`. If the user's request matches an existing task, that's the one you're working on.
2. **Resume.** Before continuing an existing task, call `get_task`. It shows the plan with statuses,
   the current step, linked PRs/threads and the latest handover notes. Pick up from there. If it lists
   **Missing links**, add them now: the Jira issue, your own T3 thread when you're in T3 Code, and your own
   session when you're in Claude Code or Copilot CLI.
3. **The backlog is cheap.** When something worth doing comes up mid-task (a bug you noticed, a refactor, a
   follow-up, a Jira ticket for later), call `add_to_backlog` once and carry on with your current work.
   Don't derail.
4. **Plan before implementing.** A task can't leave Backlog without a plan. Use `set_plan` on an existing
   task, or `create_task` for new work (plan included, lands in Planned). A good plan has phases with
   3–8 concrete, verifiable steps each ("Add links table migration", not "Backend"). Put the approach
   and key decisions in `context`. Markdown checklists work too:

   ```markdown
   ## Phase 1: Data

   - [ ] Add migration for links table
   - [ ] Repository + tests
   ```

   Then `move_task` to `in_progress`.

   Tag tasks with `labels` for the kind of work, e.g. `["ui"]`, `["backend", "bug"]`, on
   `create_task` / `add_to_backlog`, or later with `update_task` (which replaces the list). Reuse the labels
   `board_overview` lists rather than inventing near-duplicates. The user filters the board by them, and
   `list_tasks` takes a `labels` filter too.
   If a task you just planned has no labels (the `set_plan` / `create_task` / `get_task` result says so
   under **Missing labels**), suggest 1–3 to the user, preferring ones already in use, and wait for their OK
   before calling `update_task`.

   **Templates.** The user keeps task templates (Bug, Spike and Feature to start with, plus their own),
   each a starting point with a description, labels and a plan. `list_templates` (with `workspacePath`) shows
   them. Pass `template: "Bug"` to `add_to_backlog` or `create_task` to start from one: what you leave out
   is filled in from it (the title too, when it has a title pattern), what you pass wins, and labels you pass
   replace its labels. `add_to_backlog` keeps the task in Backlog with the template's plan copied in;
   `create_task` needs no plan of its own when the template has one, and lands in Planned. Use a template
   when one clearly fits the work; don't make one up. You can't create or edit templates; the user does that
   in Settings.

   When you write the plan, also set `suggestedModel` on `set_plan` / `create_task`: the tier the session
   that implements it needs, with a one-line `reason`. The user maps each tier to a model, and hand-offs
   from the board start on (or remind the user to switch to) that model.
   - `light`: small, well-specified work with an obvious approach (copy changes, a one-file fix, mechanical edits).
   - `standard`: a typical feature or fix across a few files that follows existing patterns.
   - `deep`: cross-cutting, ambiguous or risky work (architecture, migrations, concurrency, security).

   Change it later with `update_task` (`null` clears it). A suggestion is advice to the user: keep working on
   whatever model you are on.

   Autopilot can start Planned tasks by itself, but only the ones flagged for it. When Start planned tasks is
   on for the task (its epic, its project or the board), the `set_plan` / `create_task` result says **Autopilot flag not set**: ask the
   user whether to flag the task, and once they answer call `update_task` with `autopilot: "on"` or `"off"`
   (`"default"` clears it). Never set the flag on your own, since it lets an agent start on the task unattended.
   You can flag tasks, but you can't change Autopilot's own settings: only the user can.

5. **Keep steps current.** `update_step` to `in_progress` when you start a step and `done` as soon as
   it's finished. Use `blocked` (with `appendNotes` explaining why) or `skipped` when appropriate. Before
   asking the user a question and waiting for the answer, mark the current step `blocked` with a note
   saying what you need; set it back to `in_progress` once answered. Found more work? `add_steps`.
   Several steps to update at once (mark a phase done, add notes, move a step, rename a phase)? One
   `update_plan` call, with `steps: [{step: "2.3", status: "done"}, …]`; labels refer to the plan as it was
   before the call.

   **`set_plan` replaces the whole plan.** Every phase or step you don't pass back with its id is deleted,
   with its status and notes. Use it to write a plan or deliberately rewrite one, never to update a few
   steps. A call that would delete steps with progress (any status but `todo`) or notes, or a whole phase while keeping
   other steps, is refused with `CONFLICT` unless you pass
   `allowDeletes: true`; when it deletes anything, the result lists it.

6. **Link on creation and pickup.** Link the Jira issue when the task is created: pass its key in
   `links` to `create_task` / `add_to_backlog`, or call `link`. Keys in the title are linked
   automatically. Link your T3 thread whenever you start or resume a task (see below). `link` PR URLs
   as soon as the PR is open; GitHub PRs show live checks/review state on the board. `link` is
   idempotent, so linking twice is harmless.
7. **Status transitions.** `in_progress` while implementing → `review` when the work is done → `done`
   when merged or verified. If `move_task` returns `PLAN_REQUIRED`, call `set_plan` first. If the move to
   `review` says a local review round is open, run the review loop (below) **before** opening the PR, and
   open it when the loop ends; otherwise open and link the PR, then move to `review`.
8. **Close what's already handled.** If a task was delivered by another task, duplicates one, or is no
   longer wanted, `close_task` it with resolution `completed` / `duplicate` (plus `byTask: "#N"`) or
   `wont_do`. It moves to Done without a plan and the other task shows it also resolved this one. Don't
   archive these: archiving hides the card and loses why it was closed. `delete_task` is permanent and
   only works on archived tasks; use it only when the user asks for a task to be deleted.
9. **Hand over.** Before ending a session, `add_note` with what you did, what's left, gotchas and the
   exact next action. The next agent starts from `get_task`.

## Epics

An epic groups the tasks of a large feature (say "One-page checkout") in one project. On the board it is a
band across the columns its tasks are in, with a roll-up of how many are done.

- `create_epic` makes one; pass `tasks: ["#4", "#5"]` to group existing tasks straight away.
- Put new tasks in it with `epic: "#N"` on `create_task` / `add_to_backlog`. Move a task in, across or out
  with `update_task(task, epic: "#N")` or `epic: null`. Moving a task to another project takes it out of its
  epic. Epics don't nest.
- An epic has **no plan and no column of its own**: `set_plan`, `move_task` and `close_task` refuse it. Its
  status follows its tasks (the furthest-back open one sets it; Done once they all are), so plan, move and
  review the tasks.
- `epic_overview` (or `get_task` on the epic) lists each task with its status, progress, current step,
  anything needing attention, its live T3 thread, latest note and newest activity. `list_tasks(epic: "#N")`
  lists just its tasks.
- **Orchestrating** an epic means starting its tasks in other sessions and seeing them through. The user
  usually hands you the epic's orchestrating prompt; follow it. When `epic_overview` says T3 Code is available,
  `start_task_thread(task)` starts a task in its own T3 thread and worktree, and `message_task_thread` talks to it.
  Otherwise `get_handoff_prompt(task)` gives the prompt
  for a session the user starts, and `get_handoff_prompt(task, subagent: true)` the one for a subagent you
  start. Draft plans for Backlog tasks, get the user's approval, then `set_plan` and move them to `planned` before starting them.
- **Suggesting epics**: when asked to group a project's tasks into epics, propose the groups first and only
  `create_epic` / `update_task(epic)` the ones the user agrees to. Don't plan or start the tasks.
- **If you are a subagent** working one of an epic's tasks: you can't ask the user anything, so mark the step
  blocked and report back when you need an answer. When `move_task` to `review` opens a review round, don't
  run the loop or open the PR; stop and report the round. The orchestrator runs the review: `start_review`
  gives it the open round's brief.

## Blocking

Tasks can wait on each other, including across projects. "A blocks B" means B isn't ready until A is **Done**
(any resolution counts, so a `wont_do` blocker stops blocking). On the board a blocked card shows a lock, and
hovering a card draws green lines to the tasks it unblocks and red lines to its blockers.

- Set blockers with `blockedBy: ["#4"]` on `create_task` / `add_to_backlog`, or `addBlockedBy` /
  `removeBlockedBy` on `update_task`. The other task's `Blocks` list follows. Epics can block and be blocked.
- `get_task` lists **Blocked by** (with each blocker's status) and **Blocks**; `list_tasks` and `epic_overview`
  add "blocked by #N" to blocked tasks.
- **Don't start a blocked task** (`move_task` to `in_progress`, or a session for it). Tell the user what it waits
  on, or work on a blocker first. When the last blocker reaches Done the task is ready.
- A relation that would make a cycle is refused with the chain in the error. Archive-and-forget doesn't free a
  task: an archived blocker that isn't Done still blocks, so close it with `close_task` or remove the relation.
- Record a dependency when you notice one while planning (the task needs another task's migration, API or
  decision), instead of only writing it in the plan.

## Local review

The user can turn on automatic local review (globally, or per task). Then moving a task to `review`
opens review round 1, and the `move_task` result tells you what to do. In short:

1. Start a **reviewer subagent with fresh context** and give it the reviewer brief from the result. Wait
   for it; it records its findings on the board with `submit_review`.
2. `get_task`, fix every open **blocking** and **major** finding (minor and nit too when cheap), and mark
   each with `resolve_finding`: `fixed`, or `wont_fix` with a note saying why. Findings are labelled
   `R<round>.<n>`, e.g. `R1.2`.
3. If the round raised blocking or major findings, `start_review` and repeat with a new reviewer. Stop
   when a round comes back clean or the round limit is reached (the board refuses further rounds).
4. **Always open the PR and link it** once the loop ends, unless the user said not to: also at the
   round limit, with any findings still open listed in the PR description. If the task already has a PR
   (a re-review after feedback), push to it instead of opening another. A review that ends without a
   PR leaves the user with nothing to look at; `get_task` lists the PR under **Missing links** until one
   is linked.

If you are the reviewer: don't edit files, review the branch's changes against the task, and finish with
`submit_review` (an empty findings list when the change is clean). If you can't start subagents, do the
review as a separate pass yourself and `submit_review` with actor `self-review`.

## Running inside T3 Code

If you have the T3 Code tools, link every task you work on to your thread so the user can jump back to
it. That includes existing tasks you pick up or resume, not only ones you create:

1. Call `t3_thread_configuration` once → `threadId`.
2. Call `t3_environment_read` once → `environmentId`.
3. Pass `t3Thread: { environmentId, threadId }` to `create_task` / `add_to_backlog`, or to `link` when you
   start or resume an existing task. A task can have several threads; each session adds its own.

T3 Code exposes no environment variable for this, so you must call those tools. A thread started from
the board is already linked; its first message says so (see `docs/features/agent-handoff.md` in the
board's repo).

## Linking your session (Claude Code, Copilot CLI)

In Claude Code or Copilot CLI, link your own session to every task you start or resume, so the user can
see from the board whether it is still running and reopen it in a terminal later:

```
link(task: "#42", agentSession: { harness: "claude-code", sessionId: "<uuid>", cwd: "<your cwd>" }, label: "Implementing #42")
```

- `label` is the name the board shows for the session, so say what it does: "Implementing #42", "Planning #42",
  Linking the same session again with a new label renames it (when the work changes). A subagent (a reviewer, say)
  has the same session id as the session that started it: only the main session links, and a subagent must never
  link or relabel it.

- Claude Code puts the id in `$CLAUDE_CODE_SESSION_ID`, Copilot CLI in `$COPILOT_AGENT_SESSION_ID`
  (harness `"copilot-cli"`). Read it with the shell (`echo $CLAUDE_CODE_SESSION_ID`); never guess it.
- `cwd` is the absolute path you are working in.
- Inside T3 Code, link it as well as your thread: it lets the user continue in a terminal.

## Setup

The server runs locally on port 4317. Register it once:

```sh
claude mcp add --scope user --transport http aboard http://127.0.0.1:4317/mcp
# GitHub Copilot CLI
copilot mcp add --transport http aboard http://127.0.0.1:4317/mcp
# GitHub Copilot in VS Code (or .vscode/mcp.json: servers.aboard = {type: http, url})
code --add-mcp '{"name":"aboard","type":"http","url":"http://127.0.0.1:4317/mcp"}'
```

Install this skill by copying the folder to `~/.claude/skills/aboard/`.
