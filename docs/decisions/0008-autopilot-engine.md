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
- A run left `queued` or `running` by a restart is marked failed and flagged, never restarted.
- Agents can see Autopilot's results (activity, attention reasons) but can't change its settings.
