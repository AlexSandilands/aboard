# Stats

Board task: #64 (epic #189).

Weekly trends over the board's history: how much work is created and finished, how long it takes, how often
reviews loop, how many PRs merge, and what Autopilot and agent sessions do. The server computes them from data
it already keeps; nothing is recorded for the purpose. The API is `GET /api/stats`; there is no MCP tool.

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

Series names are stable ids; the labels are the client's to write. A new metric is a new key, so adding one
doesn't change the shape.

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
| `apps/server/src/db/repos/links.ts` | `prsMergedBetween`, `agentSessionsStartedBetween` |
| `apps/server/src/http/routes/system.ts` | `GET /api/stats` |
| `apps/server/src/services/stats.test.ts`, `http/stats.routes.test.ts` | Week boundaries, scoping, totals; query validation |
