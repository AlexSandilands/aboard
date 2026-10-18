| `tools/social.ts`  | `social_read`, `social_post`: registered only while the hidden social network setting is on, and mentioned nowhere else agents look (see [social.md](social.md)) |
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
the task has none, and whether to flag it for Autopilot), keep
steps current, group large features into epics, link the Jira issue and the T3 thread, finish with `add_note`.

### Tools

| File               | Tools                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `tools/read.ts`    | `board_overview`, `board_activity`, `list_projects`, `list_templates`, `list_tasks`, `get_task`, `epic_overview`, `get_handoff_prompt` (all read-only) |
| `tools/tasks.ts`   | `add_to_backlog`, `create_task`, `create_epic`, `move_task`, `close_task`, `update_task`, `delete_task`, `add_note`, `request_attention` |
| `tools/plans.ts`   | `set_plan`, `update_plan`, `add_steps`, `update_step`                                                   |
| `tools/links.ts`   | `link` (PR URL, Jira key, URL, a T3 thread `{environmentId, threadId}` or bare thread ID; idempotent)    |
| `tools/merge.ts`   | `merge_task_pr`: merges a task flagged for auto-merge's PR into the default branch (see [github-prs.md](github-prs.md#merge_task_pr)) |
| `tools/reviews.ts` | `start_review`, `submit_review`, `resolve_finding` (see [local-review.md](local-review.md))             |
| `tools/transcripts.ts` | `get_session_transcript`: a condensed, redacted, paged transcript of a Claude Code session linked to the task (read-only; see [agent-sessions.md](agent-sessions.md#transcripts)) |
| `tools/threads.ts` | `start_task_thread`, `message_task_thread`: T3 Code threads for a task, in an epic or not (see [epics.md](epics.md#t3-code-threads)) |
| `tools/autopilot.ts` | `retry_autopilot_run`: hands a task's failed or skipped Autopilot run back to the engine (see [autopilot.md](autopilot.md#a-pass)) |
| `tools/suggestions.ts` | `list_editable_prompts`, `get_editable_prompt`, `suggest_change`: proposed changes to prompts and skills, for the user to accept (see [suggestions.md](suggestions.md)) |

`add_to_backlog`, `create_task` and `update_task` take `labels` (`update_task` replaces the list), and
`list_tasks` filters by any of several `labels`. `board_overview` ends with **Labels in use** and their
counts. See [labels.md](labels.md).

`set_plan`, `create_task` and `update_task` take `suggestedModel: {tier, reason}`: the model tier for
implementing the task. `set_plan` keeps the current one when it's omitted; `update_task` clears it with
`null`. See [agent-handoff.md](agent-handoff.md#suggested-model).

`add_to_backlog`, `create_task` and `update_task` take `autopilot: "default" | "on" | "off"`, the task's
Autopilot flag (stored as null, 1 or 0). Agents may set it, but only after the user has said so, and no tool
changes Autopilot's own settings. See [autopilot.md](autopilot.md#the-per-task-flag).

`add_to_backlog`, `create_task` and `update_task` take `priority: true | false`, which puts the task in the board's
priority lane and makes Autopilot start it first ([board-layout.md](board-layout.md#the-priority-lane)). Agents set it
only when the user asks. `get_task` shows a "Priority: yes" line. An epic can't be priority.

`add_to_backlog`, `create_task` and `update_task` take `manual: true | false`, which makes a manual task: a to-do for a
person that needs no plan (so `create_task` takes no plan with it, and lands it in Planned) and that agents and
Autopilot leave alone ([task-lifecycle.md](task-lifecycle.md#manual-tasks)). `get_task` shows a "Manual task: yes"
line and `list_tasks` tags it `[manual]`. Its results drop the hints for an agent working on it (Plan progress,
the Autopilot flag, the suggested model, and every Missing link but Jira keys), and `get_handoff_prompt`,
`start_task_thread` and an `agentSession` link are refused on it.

`update_task` takes `dueDate` (`YYYY-MM-DD`, `null` clears it; [board-layout.md](board-layout.md#the-due-date)). Agents set it
only when the user gives a date. `get_task` shows a "Due:" line and `list_tasks` lines "due YYYY-MM-DD", only when set.

`add_to_backlog`, `create_task` and `update_task` take `autoMerge: "default" | "on" | "off"` (stored as null, 1 or 0),
which lets `merge_task_pr` merge the task's PR into the default branch. Agents set it only when the user says so; the server can't enforce that
([why](../decisions/0008-autopilot-engine.md)).
`get_task` shows an "Auto-merge:" line when it is set. An epic can't have it. See
[github-prs.md](github-prs.md#merge_task_pr).

`add_to_backlog`, `create_task` and `update_task` take `epic: "#N"` (`update_task` takes `null` to take the
task out), `list_tasks` filters by `epic`, and `create_epic` can group existing `tasks` when it creates the
epic. `get_task` on an epic and `epic_overview` render its tasks instead of a plan. `get_handoff_prompt` returns
the hand-off prompt the board would copy (with `subagent: true`, the variant for an orchestrator's subagent), so an
epic's orchestrator can start its tasks; with `tasks: ["#3", "#4"]` instead of `task`, it returns the prompt that
plans several of a project's tasks with the user ([agent-handoff.md](agent-handoff.md#plan-tasks-several-tasks-at-once)).
`create_epic` and `update_task` (epics only) take `delivery: "main" |
"integration"`; switching to integration makes the epic's branch on origin first. See [epics.md](epics.md#delivery).

`add_to_backlog` and `create_task` take `template` (a name or id; `list_templates` shows them) and then need no
title, or, for `create_task`, no plan, when the template supplies one. Agents can't create or edit templates. See
[templates.md](templates.md).

`add_to_backlog` and `create_task` take `blockedBy`, and `update_task` takes `addBlockedBy` / `removeBlockedBy`.
`get_task` prints **Blocked by** and **Blocks**, and task lines add `blocked by #N`. See [relations.md](relations.md).

Every tool validates its input with zod and calls a service; none holds rules of its own
([ADR 0001](../decisions/0001-service-layer.md)).

### Projects

Project-scoped tools take `projectId` or `workspacePath` (the agent's cwd). Write tools need one of them.
Read tools treat an unknown path as an empty project rather than an error. `add_to_backlog` and
`create_task` create the project when the path is new. For work that belongs to no code project they take
`general: true` instead, which files the task in the [General project](task-lifecycle.md#creating) (unarchived or
made again if needed). It is refused together with a path or id, and omitting both still errors. See
[task-lifecycle.md](task-lifecycle.md#creating).

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
  review round is waiting. It also lists the task's pasted **Images** with their absolute file paths, so an agent
  can open a screenshot as a file ([attachments.md](attachments.md)).
- `get_session_transcript` returns a header with the session's totals, then one page of up to 20,000 characters of
  one-line entries and the `offset` to call again with when more follows (`renderTranscript`). Credential-shaped text
  is redacted first ([agent-sessions.md](agent-sessions.md#transcripts)).
- `resolve_finding` is where the loop moves on: resolving the last open blocking or major finding of a round makes
  the board open the next round (under the limit), and the result says so and points to `start_review` for its
  brief. `move_task` to Review with a PR already linked adds that the loop must finish first and fixes go to that PR.
  See [local-review.md](local-review.md).
- **Plan progress** nudges agents to update steps as they work instead of ticking them in bulk at the end of a
  phase, so the board shows live progress. `progressHints` (`format.ts`) runs for open tasks with a plan, never
  an epic, and each hint names the call to make. It appears in `get_task` and every mutation result:
  - _No step started_: the task is In Progress and no step is `in_progress`; names the current step and the
    `update_step` call. This also fires right after a step is marked done, so it names the next one.
  - _Open steps_: the task is in Review and steps are still open (not done or skipped). Moving to Done with
    open steps gets it too, but only in that `move_task` result (`taskResult`'s `closing` option), so a task
    that is already Done never nags.
  - _Stale plan_: the task is In Progress with a step in progress, but no step has changed for
    `STALE_PLAN_MS` (30 minutes).
  - _Batched completion_ is not a section: an `update_plan` result on an In Progress task that moved two or
    more steps straight to done without ever starting them (`startedAt` still null) says so after the headline
    (`batchedCompletionHint`), and tells the agent to use `update_step` as it goes. It stays quiet at Review
    and Done, where the open-steps hint asks for exactly that catch-up.

  Renderings that aren't for the implementing agent (the reviewer's `taskText`) leave it out: it is opt-in
  through `renderTaskDetail`'s `progress` option.
- **Missing labels** appears in `set_plan`, `create_task` and `get_task` results when the task has no
  labels and is still open. It names the labels in use and asks the agent to suggest 1–3 and wait for
  the user before calling `update_task`. Other mutation results leave it out (`taskResult`'s
  `planningHints` option).
- **Missing suggested model** appears in `set_plan` and `create_task` results for a planned, open task with
  no suggested model, asking the agent to set one with `update_task`. Unlike labels it needs no approval, and
  `get_task` leaves it out so implementing agents aren't nagged. The task render shows
  `Suggested model: deep (reason)` once set.
- **Epic delivery not chosen** appears in `create_epic`, in `set_plan` and `create_task` results for a task in
  the epic, and in `epic_overview`, while `deliveryHintApplies` holds for the epic (no delivery chosen, and its
  open tasks block each other or three or more are Planned). It explains both deliveries in a sentence each and tells
  the agent to ask the user, then `update_task(epic, delivery)`; never to choose unasked (`deliveryHint`).
- **Autopilot flag not set** appears in `set_plan` and `create_task` results for a backlog or planned task
  with a plan, when Start planned tasks resolves On for its project and the flag is still Default. It tells the
  agent to ask the user, then `update_task(autopilot)`, and never to set it unasked. Epics, started and closed
  tasks and tasks already flagged On or Off don't get it, and neither does `get_task`. The task render shows
  `Autopilot: flagged on|off` once set.
- `list_tasks` and `board_overview` print one line per task (`summaryLine`), labels after the title:
  `#42 Title [ui] — 3/7, at 2.1 Write tests · PR #12 open`. An epic's line shows `[epic]` and its roll-up
  (`0/3 done · 2 In Progress, 1 Backlog`); a task in one ends with `in epic #N`. `board_overview` counts only
  tasks and lists each project's open epics under it.
- Errors come back as `isError` results reading `CODE: message`. `move_task` adds a hint to
  `PLAN_REQUIRED` (call `set_plan`, or use `close_task`); `set_plan` adds one to `CONFLICT` (use
  `update_plan`, or pass `allowDeletes`). When a `set_plan` call deleted steps, its result says
  `Deleted N step(s): 1.2 Title, …`. See [plans.md](plans.md#writing-a-plan).

### board_activity

`board_activity(since, until?, projectId? | workspacePath?)` is the look-back counterpart of `board_overview`:
read-only text over a window `[since, until)`, for the improvement automation, an orchestrator, or anyone asking
"how did this week go?". `since` and `until` are ISO dates or times (UTC without an offset) or a time ago
(`24h`, `7d`); `until` defaults to now. Nothing new is stored: `services/activity.ts` reads `task_events`,
`task_reviews` and `review_findings`, `autopilot_runs` and `thread_waiting` notifications, and
`mcp/activityFormat.ts` renders it. Sections, each cut to a cap in `ACTIVITY_CAPS` with "(N more)":

- **Tasks finished:** tasks moved to Done or closed in the window (epics follow their tasks and are left out),
  with the time each spent in Backlog, Planned, In Progress and Review, its local review rounds, Autopilot PR
  review rounds, and steps that went blocked or skipped.
- **Review findings:** local rounds opened in the window (failed and stalled counted), the findings raised in it by
  severity, status and directory, the most severe titles, and each Autopilot PR review's counts (its run only
  keeps counts, not titles).
- **Autopilot runs:** real runs that finished in the window, per automation: outcomes, retries (a run right after a
  failed run of the same automation on the same task; review and fix rounds are not), "gave up", and failures with
  their reason. A run the board's restart failed is marked `(board restarted)`.
- **Stalls:** Unstick's stale and waiting runs and `thread_waiting` notifications, once per task and kind.
- **Latest note per task:** the last note anyone but Autopilot wrote on each task, newest first (usually its
  handover). Notes have no "needs the user" flag; what needs the user shows as a run's `needsAttention` or an
  attention reason on the task.

Task refs (`#42`) let the agent open one with `get_task`.

### Writing tool descriptions

Descriptions are written for agents, and they are most of what an agent knows about the board:

- Say **when** to call the tool, not only what it does (`get_task` is "the 'where was I' call", and the
  instructions say to call it before resuming).
- Say what good input looks like: 1–4 phases of 3–8 concrete, verifiable steps.
- Lead with the hazard when a tool is destructive: `set_plan` opens with "REPLACES the whole plan" and
  points to `update_plan`, because agents grabbed it for bulk updates when nothing else did that.
- Explain the gate where it bites (`create_task`, `move_task`), and point to the cheap path
  (`add_to_backlog`, `close_task`).
- Put guidance agents must act on in **results** too (Missing links, Missing labels, the Autopilot flag, review loop
  instructions): agents follow a result they just got more reliably than instructions read once. Show
  it only where it applies, or agents learn to skip it.
- `get_task` must not tell a reviewer to start a reviewer: the review loop instructions come only from
  `move_task` and `start_review`.

### The shipped skill

`skills/aboard/SKILL.md` (an Agent Skill) and `skills/aboard/AGENTS-snippet.md` (for other agents'
`AGENTS.md`) teach the same workflow in more depth. No test ties them to the tool descriptions. When you
rename a tool, change its arguments or change the workflow, update both, plus `INSTRUCTIONS`, then run
`pnpm skill:embed`.

The app ships them too: `packages/contracts/src/boardSkill.ts` holds both texts (generated by
`scripts/embed-board-skill.ts`, with the product name read from `BRAND`), and `apps/server/src/skills.test.ts`
fails while it differs from `skills/aboard/`.

**Skill sync** (`apps/server/src/services/skillSync.ts`, routes under `/api/skill-sync`) installs that text as
`<harness folder>/skills/<BRAND.id>/SKILL.md` for each harness the user turns on in Settings → Integrations. The
harness folder is the one the harness itself reads: `CLAUDE_CONFIG_DIR`, `COPILOT_HOME` or `CODEX_HOME` when set,
else `~/.claude`, `~/.copilot` or `~/.codex` (`harnessHomesFrom`, read once into `config.harnessHomes`). It is off
by default, and per machine: its `skillSync` settings key isn't in backups.

- It records the hash of what it last wrote (line endings ignored) and only rewrites a file that still has that
  hash. On start, and when a harness is turned on, it brings each enabled copy up to date.
- A copy that matches the app's text already is adopted. Any other copy is **edited**: left alone until the user
  chooses Overwrite. Keep mine turns sync off and leaves the file.
- Turning sync off can delete the copy (and the folder, if nothing else is in it); deleting an edited copy needs
  `force`. Other skill folders are never touched.
- The snippet lives in the user's own file, so the board only records the hash of the snippet they last copied
  and says when it changed.

The sandbox sets `brandEnv("USER_HOME")` to a folder of its own, so trying this there never writes the real
`~/.claude`. With it set, the harnesses' env vars are ignored, since they point into the real home. Tests pass
`userHome` (and `harnessHomes`) to the harness.

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
| `apps/server/src/mcp/format.ts`       | Text renders: `renderTaskDetail`, `summaryLine`, `missingLinkHints`, `labelHint`, `suggestedModelHint`, `autopilotFlagHint`, `renderTranscript` |
| `apps/server/src/mcp/tools/*.ts`      | The tools                                                            |
| `apps/server/src/mcp/mcp.test.ts`, `reviews.mcp.test.ts` | End-to-end tests through the MCP SDK client           |
| `skills/aboard/`                      | The skill and `AGENTS.md` snippet shipped to agents                  |
| `packages/contracts/src/boardSkill.ts` | The same texts embedded for the app (`pnpm skill:embed`)            |
| `apps/server/src/services/skillSync.ts` | Installs the skill into harnesses' skill folders and keeps it current |
| `skills/aboard-review/SKILL.md`       | The review skill, kept identical to `BUILTIN_REVIEW_SKILL_BODY`      |
