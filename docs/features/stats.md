# Stats

Board tasks: #64 (the API) and #190 (the page), epic #189.

Weekly trends over the board's history: how much work is created and finished, how long it takes, how often
reviews loop, how many PRs merge, what Autopilot and agent sessions do, and where agents got stuck. The server computes them from data
it already keeps; nothing is recorded for the purpose. The API is `GET /api/stats`; there is no MCP tool. The page that charts it is `/stats` ([The page](#the-page)).

## How it works

`GET /api/stats?weeks=&projectId=` (`apps/server/src/http/routes/system.ts`) calls `services.stats.weekly`
(`apps/server/src/services/stats.ts`). `weeks` is 4, 12 (the default) or 52, and anything else is a 400.
`projectId` limits every series to one project (404 when it doesn't exist); without it the whole board counts.

The response (`StatsResponse` in `packages/contracts/src/stats.ts`) holds:

- `buckets`: the calendar weeks of the period, oldest first, each `{ start, end }` as instants. A week starts
  on **Monday at 00:00 in the server's local time**; the last bucket is the current week, so it is partial.
- `series`: a **map by name** to `{ unit, values, total, previousTotal }`. `values` has one entry per bucket.
  `total` covers the whole period and `previousTotal` the period of equal length just before it
  (`previousFrom` to `from`), for "up or down on last time".
- `breakdowns`: a **map by name** to `{ unit, items }`, the period split by a category rather than by week
  ([Breakdowns](#breakdowns)).
- `from`, `to`, `previousFrom`, `project`, `weeks`.

Counts and costs are `0` in a quiet week. Durations and ratios are `null` when nothing in the week had one. A
count's total is the sum, a duration's the median over the period, and a ratio's the mean over the period (not
the mean of the weekly means).

### Series

Each is attributed to the week of the instant given. Fixed series are always present; the per-automation ones
appear only when that automation ran in the two periods.

| Series | Unit | What it counts | Source |
| ------ | ---- | -------------- | ------ |
| `tasks_created` | count | Tasks created, epics left out | `task_events` `created` |
| `tasks_completed` | count | Tasks that reached Done: the last move to Done or close of each task. Epics and closes as `wont_do` or `duplicate` are left out | `status_changed`, `closed` |
| `cycle_time.in_progress_to_done` | ms, median | From the first move to In Progress in the last cycle (after any earlier finish, so a reopened task starts again) to finishing; tasks that never went through In Progress have none | `status_changed` |
| `cycle_time.created_to_done` | ms, median | From creation to finishing | `tasks.created_at`, finish event |
| `prs_merged` | count | PRs, by when the board first saw them merged; a PR linked to two tasks counts once | `task_links.pr_changes_json` `merged` |
| `agent_sessions_started` | count | Agent sessions, by when first linked to a task; a session on several tasks, or linked again later, counts where it was first linked, in that task's project | `agent_session` links |
| `review_rounds` | count | Local review rounds opened | `task_reviews` |
| `review_rounds_per_task` | ratio, mean | Local review rounds each finished task had in all (0 when none), taken in the week it finished | `task_reviews`, finish event |
| `review_findings.<severity>` | count | Findings raised, for `blocking`, `major`, `minor`, `nit` | `review_findings` |
| `autopilot.runs` | count | Real runs, in the week they finished | `autopilot_runs` |
| `autopilot.runs.<automation>.<status>` | count | The same, per automation and final status | `autopilot_runs` |
| `autopilot.retries` | count | Runs that followed a failed run of the same automation on the same task, both finished in the two periods; a retry of a failure from before the first week isn't counted | `autopilot_runs` |
| `autopilot.cost_usd` | usd | `cost_usd` of those runs | `autopilot_runs` |
| `friction.steps_blocked` | count | Plan steps whose status changed to blocked; a step blocked twice counts twice | `step_updated` |
| `friction.steps_skipped` | count | Plan steps whose status changed to skipped | `step_updated` |
| `friction.attention_requests` | count | Times an agent (or anyone) asked for the user's attention on a task, `request_attention` | `task_events` `attention_requested` |
| `friction.autopilot_flags` | count | Real Autopilot runs that finished flagging their task as needing attention, in the week they finished | `autopilot_runs` |
| `friction.stalls.stale` | count | Tasks Unstick found quiet for too long. A task counts once per week and kind, however often it was noticed | `autopilot_runs` |
| `friction.stalls.waiting` | count | Tasks whose thread waited on input, from Unstick's runs and the inbox's `thread_waiting` notices, once per task and week | `autopilot_runs`, `notifications` |
| `friction.runs_restarted` | count | Runs cut short by the board restarting (`BOARD_RESTARTED_ERROR`), in the week they were marked failed | `autopilot_runs` |

A stall and a restart-cut run are read as `board_activity` reads them: `stallKind` and `wasRestarted` in
`services/activity.ts` are the one definition. Friction isn't failure: a blocked step is often the agent working as
intended, so the page shows these tiles neutrally, like counts of PRs or runs, rather than colouring a rise red.

Series names are stable ids; the labels are the client's to write. A new metric is a new key, so adding one
doesn't change the shape.

### Breakdowns

A breakdown splits the whole period by a category, not by week. Each is `{ unit, items }`, with an item per category
`{ key, total, previousTotal }` (the period and the one before it), largest `total` first. A `null` key is the "none"
category: a task without a label or a tier suggestion. All three are always present, with no items when nothing
falls in them. They share the scope of the series: `projectId` limits them to one project.

| Breakdown | What it counts | Source |
| --------- | -------------- | ------ |
| `completed_by_label` | Tasks finished (as in `tasks_completed`), by the labels they carry now. A task with several labels counts under each; one with none under `null` | `task_labels`, finish event |
| `completed_by_tier` | The same tasks, by the model tier their plan suggested (`light`, `standard`, `deep`), `null` when none | `tasks.suggested_tier`, finish event |
| `sessions_by_harness` | Agent sessions and T3 Code threads, by when first linked, counted once each as `agent_sessions_started` is. The key is the session's harness (`claude-code`, `copilot-cli`) or `t3_thread` for a T3 Code thread | `agent_session` and `t3_thread` links |

Labels and tiers are read as they are now, not as they were when the task finished, since the board keeps no history
of either.

## The page

`/stats` (`StatsPage` in `apps/web/src/components/stats/`) is a top-level route under the pathless `appRoute`, like
`/social`. It is reached from the Stats icon in the sidebar footer and the command palette's "Open stats"
(`useOpenStats`, which carries over the project the board is on). `?project=` (a project id; none is the whole board)
and `?weeks=` (4, 12 or 52; anything else reads as 12) hold the view, so links and reloads keep it.

`useStats(weeks, projectId)` reads `GET /api/stats`. Nothing is pushed over SSE for stats, so it is stale at once
and refetches when the window regains focus and when the period or project changes (a new query key). While a new key
loads, the previous charts stay up, dimmed. A project that no longer exists (404) offers "Show all projects".

The sections (Throughput, Cycle time, PRs and reviews, Autopilot, Sessions, Friction, Breakdowns) are built in `StatsPage.tsx` from the series
above, with labels and colours written there. A later metric adds a section, or a chart in one, by reading its series by
name. The headline tile compares `total` with `previousTotal` (`changeVsPrevious`); only series where a direction is
plainly better (tasks finished, cycle time, review rounds, findings, retries) colour the change. A series missing from
the response (a per-automation one that didn't run) reads as quiet. When every series is zero in both periods the page
says nothing happened instead of drawing empty charts.

The charts are hand-rolled SVG with no dependency:

- `WeeklyBars` (grouped or stacked), `TrendLine` (a line per series; a week with no value breaks it) and `KpiTile`.
  `SortedBars` draws a breakdown as horizontal bars, largest first, with the previous period's figure beside each; it
  is a plain list with the values written out, so it has no tooltip. `breakdownRows` (in `stats.logic.ts`) keeps the
  categories with something in the period and folds all past the eighth into "Other".
  `chartParts.tsx` has what they share: the drawing box, axes, legend, tooltip, and the frame.
- Series colours are theme tokens (`SERIES_COLORS`), so charts follow light, dark and custom themes. Stacked
  segments and dots get a surface-coloured outline for the gap. Identity never rides on colour alone: a legend names
  each series and the tooltip repeats the names.
- A week's values show in a tooltip on hover, or with the arrow keys once the chart has focus. Each chart also
  renders an `sr-only` table. Nothing animates in; the dim while loading is `motion-reduce:transition-none`.
- Axis ticks come from `niceScale`, or `niceDurationScale` for durations (ticks on 30m, 2h, 1d, 1w and so on).
  The logic is in `stats.logic.ts` and tested in `stats.logic.test.ts`.

To try it with a history, run `pnpm sandbox --seed stats` (the showcase board plus twelve weeks of finished tasks and
runs; PRs, sessions and reviews aren't backdated, so those charts stay flat).

## Decisions

- **A map of series, not fixed fields.** The stats page and later metrics (commits, flow, friction) add
  series without a contract change, and a client can chart any series with the same code.
- **The period doubles.** The service buckets twice the weeks asked for and splits the result, so the previous
  period's totals come from the same code as the current ones and the two are always comparable.
- **Finished means the activity report's finished.** The last move to Done or close of a task, as
  `services/activity.ts` reads it, so a task is one completion however often it was reopened. Closing as a
  duplicate or won't-do isn't delivered work, so it doesn't count.
- **Local weeks, built by calendar date.** Boundaries come from `new Date(y, m, d + 7n)`, not by adding 168 hours,
  so a week with a clock change still starts at midnight.
- **Merge time is when the board saw it.** GitHub's own merge time isn't kept; `pr_changes_json` stamps the poll
  that saw the PR merged. A PR merged while the board was off lands in the week the board next polled.

## Alternatives considered

| Option | Why not chosen |
| ------ | -------------- |
| Call `activity.between` once per week | It builds task-level detail for each week and was written for one report; the stats need only counts and durations |
| Store a stats table, updated on each event | Duplicates `task_events` and the run history, and can't answer for history from before it existed |
| An MCP tool | Not needed yet; agents have `board_activity` for what happened in a window |

## Code map

| File | What it does |
| ---- | ------------ |
| `packages/contracts/src/stats.ts` | `StatsQuery`, `StatsResponse`, `StatsSeries`, the allowed periods |
| `apps/server/src/services/stats.ts` | Week boundaries, the series, the previous-period split |
| `apps/server/src/db/repos/links.ts` | `prsMergedBetween`, `agentSessionsStartedBetween`, `sessionsStartedBetween` |
| `apps/server/src/services/activity.ts` | `stallKind`, `wasRestarted`: the stall and restart definitions the friction series share with `board_activity` |
| `apps/server/src/http/routes/system.ts` | `GET /api/stats` |
| `apps/server/src/services/stats.test.ts`, `http/stats.routes.test.ts` | Week boundaries, scoping, totals; query validation |
| `apps/web/src/components/stats/StatsPage.tsx` | The route component: pickers and the sections |
| `apps/web/src/components/stats/{WeeklyBars,TrendLine,KpiTile,chartParts}.tsx` | The SVG charts and what they share |
| `apps/web/src/components/stats/SortedBars.tsx` | The sorted horizontal bars for a breakdown |
| `apps/web/src/components/stats/stats.logic.ts` | Scales, formatting, change against the previous period, run grouping |
| `apps/web/src/state/queries.ts` (`useStats`) | The query |
| `apps/server/src/dev/seeds.ts` (`stats`) | The sandbox seed with twelve weeks of history |
