# 0008 Autopilot is a deterministic rule engine inside the server

Status: Accepted

## Context

Autopilot lets the board act on its own: start flagged tasks, review and fix PRs, archive old cards, nudge
stuck threads. Each of those is a separate automation, built in its own task, and they all need the same
things: on/off switches at several scopes, a record of what ran, limits on how much runs, and a way to stop
everything at once. The choices made here constrain every automation, the runners that start agents and the
UI, so they are written down once.

The options for the runtime were a long-running agent watching the board (an LLM deciding what to do), a
scheduled agent run, or rules inside the server that start an agent only when an action needs one.

## Decision

- **Deterministic rules.** The engine (`apps/server/src/autopilot/`) never calls an LLM itself. Each
  automation is code: a check that reads board state and returns candidates, each with a **dedupe key**, and an
  action. Only an action that needs an agent starts one, through the `Runner` interface.
- **Inputs.** A pass runs after board events on the bus (debounced), every 60 seconds, and when Autopilot
  settings change. PR and T3 thread snapshots arrive as task events, so they need no hook of their own.
- **Scopes and precedence.** Each automation has a mode per scope: `inherit`, `on` or `off`. The most specific
  scope that isn't `inherit` wins (project over board; epic sits between them once it is resolved). With no
  setting anywhere, an automation is **off**. Per-automation config merges the same way, key by key, over the
  automation's defaults. The rule is `resolveAutopilot` in `packages/contracts/src/autopilot.ts`, so the UI
  explains it with the server's own code.
- **Dedupe.** Every run is a row in `autopilot_runs`. A candidate whose automation and dedupe key already has a
  run is skipped, whatever that run's outcome: a failed action is never retried by itself, it is flagged for the
  user. Dry-run records are deduped apart from real runs, so turning dry-run off doesn't hide real work.
- **Loops.** Dedupe keys are the guard: an action's own change can only produce a candidate with a key that
  already has a run. Events published while the engine writes are also ignored, which only saves passes.
- **Limits.** Pause all stops new runs (running ones finish). Quiet hours, the concurrency cap and the daily
  run and spend caps hold back only runs that start an agent, which are the ones that cost money and touch code.
  Held candidates aren't recorded; a later pass picks them up.
- **Safety.** Autopilot never merges into the default branch, closes or deletes tasks, never force-pushes and
  never pushes to the default branch. Runners and automations must keep to that; it isn't a setting. The one merge
  it may make is a task's PR into its epic's integration branch, when the user set the epic to integration
  delivery (Merge into epic branch, #123); `checkAutopilotMergeTarget` in `integrations/github.ts` refuses any
  other target, the default branch above all, on GitHub's own reading just before the merge. The epic's PR into the
  default branch is only ever opened as a draft and described; the user merges it.
- **Into the default branch: only `merge_task_pr`, only for flagged tasks.** (Amended for the orchestrator agent,
  #167.) The board merges into the default branch without the user's click in exactly one place: the
  `merge_task_pr` MCP tool, for a task the user flagged for auto-merge (`tasks.auto_merge`, Default is off). It
  passes the same gate as Merge into epic branch (`notMergeable` in `autopilot/mergeGate.ts`), then
  `checkAutopilotMergeTarget` with `into: "default"`, which allows the default branch and nothing else. Autopilot's
  own automations still can't: `mergeIntoDefaultBranch` isn't on the `GithubActions` they get, and the guard's
  default (`into: "epic"`) still refuses the default branch. Headless runs keep their `gh pr merge` deny rule, so
  the tool is the only way, and the gate can't be skipped. The agent chooses which flagged PR to merge and when,
  since it can see the board and order merges so they don't conflict; the server decides whether it may.
  Autopilot's **Orchestrate** automation (#138) is such an agent: its run reaches the default branch only through
  that same tool, so only for flagged tasks, and its **May merge** setting off denies it the tool outright.
- **Retrying a run is not a limit.** (#138.) `retry_autopilot_run` (and the panel's Retry) hands a failed or
  skipped run back to the engine by retiring its dedupe key. The engine still decides, under the switches, pause and
  caps, so agents may call it; it is the one Autopilot tool they get.
- **Who can turn auto-merge On: any MCP caller, as with the Autopilot flag.** (#172, raised in #167's review.)
  `create_task`, `add_to_backlog` and `update_task` accept `autoMerge: "on"`, and only their descriptions say to do
  it when the user says so. Making On user-only isn't enforceable: MCP callers are anonymous (headless runs use
  the user's own MCP config, and `actor` is whatever the caller writes, so "record who turned it on" can't be
  trusted), and REST isn't a boundary either (an agent with Bash can `curl` without an Origin and be logged as
  `user`, so "On only from the UI" would be a guard rail, not enforcement). Refusing headless runs would block the
  intended caller, the Orchestrate automation. Rejected: MCP sets only Off/Default; record the actor and have
  `merge_task_pr` refuse unless a non-agent set On; refuse the flag and the tool for headless runs. The risk is
  limited by the gate above, read fresh at the checked head (so a prompt-injected agent can only merge a PR that is
  in Review, cleanly reviewed, green and mergeable), by a Fix or Review run not being able to merge its own
  task's PR while it runs, and by fork PRs being refused. Existing On flags stay valid.
- **REST only.** Autopilot settings, pause and resume are REST routes for the UI. There is no MCP tool for
  them, so an agent can't turn Autopilot on, raise its limits or unpause it.
- **The review watchdog stays separate.** `apps/server/src/integrations/reviewFallbacks.ts` is a fallback
  for the local review loop, on whenever local review is, with its own settings and a 30-second timer. Moving
  it under Autopilot would make review rounds stall unless the user also turned an automation on, and would
  count the board's own reviewer against Autopilot's caps.
- **Actor `autopilot`.** Activity entries the engine writes, and changes its actions make, use the actor
  `autopilot`, so the activity log says who did it.

## Consequences

- An automation is one file under `apps/server/src/autopilot/automations/` and one line in its index. It must
  pick a dedupe key that changes exactly when it should act again (`review:pr:<headSha>`, `start:<taskId>:<statusChangedAt>`).
- Anything that wants Autopilot to act differently per project gets it from the scope rules for free; a new
  scope (epic) only changes `resolveAutopilot` and the settings validation.
- The run table is history and grows with use; it isn't backed up. Settings are.
- A run left `queued` or `running` by a restart is marked failed and flagged, never restarted in place. A Review
  PRs or Fix PRs run is also retired once like a hand retry, so the engine redoes it unflagged (a second
  interruption of the same work is flagged); runs that may have launched an agent are only flagged.
- Agents can see Autopilot's results (activity, attention reasons) but can't change its settings.
