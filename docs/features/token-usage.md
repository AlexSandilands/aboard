# Token usage

The tokens agents used on a task, and what they would have cost at API list prices. A task's panel shows its
sessions, threads and board runs in a Usage section; the stats page adds them up by week, model, harness, automation
and task; `get_task` prints one line of it for agents.

## How it works

### Sources

Usage is read only for sessions and threads linked to a task, and for the board's own headless runs. Nothing else on
disk is read. Each stored row says where it came from (`source`):

| Source       | What                                                                                                                                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcript` | Claude Code: `<claudeDir>/projects/<folder>/<id>.jsonl` and `<id>/subagents/*.jsonl` (subagents count toward the session). Codex: `rollout-*-<id>.jsonl` in `$CODEX_HOME/sessions/YYYY/MM/DD/` or, once archived, `archived_sessions/`.                                                                            |
| `t3_turn`    | A T3 Code thread's per-turn usage (`GET /api/orchestration/threads/:id`), for each provider thread behind it that has no transcript here: a remote T3, a cleaned-up file, or a driver the board has no reader for (OpenCode, ACP agents).                                                                                |
| `run_output` | A headless run's own JSON output, for runs that keep no transcript: the board reviewer, issue import, settings questions and Autopilot runs with no session file. Claude Code reports `modelUsage` and `total_cost_usd`; Codex reports usage on `turn.completed` and no cost.                                                                            |

A session is counted from one source only. A transcript wins: reading one drops any run rows stored for the same
session, and a run whose session has a transcript is read from the transcript instead of its output.

A T3 thread resolves to the provider sessions behind it (`providerThreads[].nativeThreadRef`; a hand-off or fork adds
more). Each is stored under `(harness, nativeId)`, the same key a self-linked agent session uses, so a thread whose agent
also linked its own session is counted once, and shown once, as the thread (Attribution). The thread's sessions are
recorded in `session_usage_thread`. A
provider session whose transcript was read once stays on those rows after the file is cleaned up, instead of falling
back to T3's turns and counting them twice.

### Copilot CLI

Not read yet: the CLI isn't installed on the machine this was built on, so the shape of its session files couldn't be
checked. A Copilot session shows "not tracked" in the panel and adds nothing. Its headless output returns no usage.

### Parsing

- Claude Code writes a line per content block and repeats the message's usage on each: a message is counted once per
  `message.id` + `requestId`, from the largest copy (a later copy can carry more output). `<synthetic>` messages and
  lines of another session id (history a fork copied) are skipped. Cache writes split into 5-minute and 1-hour from
  `usage.cache_creation`.
- Codex: `token_usage_record` lines, deduped by `response_id`; older rollouts without them are counted as the growth of
  `total_token_usage` between `token_count` events (a repeat adds nothing, a drop is a fresh start). `input_tokens`
  includes cached input. The model is the latest `turn_context`'s.
- T3: `inputTokens` includes cache reads and writes (they are taken out); reasoning is part of output; a turn marked
  `unavailable` counts nothing. The model is the turn's `models[0]`, else its run's `modelSelection.model`.
- An unexpected line is skipped, never guessed at. Only complete lines are read.

### Storage and reading

`session_usage` keeps token sums per `(harness, session_id, source_file, local day, model)`; `session_usage_cursor`
keeps how far each file was read, with a hash of the bytes before the cursor and the reader's own state. A read starts
at the cursor; a file that shrank or whose earlier bytes changed is read again from the start and its rows replaced,
without touching the session's other files. `source_file` is relative to the session (a Codex rollout's file name), so
archiving a rollout doesn't read it as new.

Files are read when a session or thread is linked, on the session poll for running sessions, on the T3 poll for working
threads (at most once a minute) and once when a thread settles, when a headless run ends, and on a 10-minute sweep of
every linked session and T3 thread (archived tasks included), which also runs 30 seconds after start. The sweep
re-reads every thread, since the T3 poll runs only while a browser is connected: turns taken with no board open, or
across a restart, are counted there. It skips files whose size hasn't changed. A task's card is refreshed at most once a minute because of usage.

### Cost

Worked out when read, never stored: tokens × a price per million tokens, keyed by model name only (so Copilot or T3
running a known model is priced the same way). Prices come from, in order:

1. The user's `modelPriceOverrides` setting (`PATCH /api/settings`; exported in backups). The settings page has no
   field for it yet. An override wins outright.
2. LiteLLM's price list, fetched once a day (below), unless the `modelPriceFetch` setting is off.
3. The built-in table in `packages/contracts/src/modelPricing.ts` (`MODEL_PRICES`), the offline fallback: the
   standard-tier list prices from Anthropic's, OpenAI's and Google's pricing pages on `MODEL_PRICES_AS_OF`. Update the
   entries and that date together.

Between the fetched list and the built-in table the longer matching name wins, the fetched one on a tie, so a `-pro`
model the fetched list lacks keeps its own built-in price instead of taking its base model's.

A name matches the longest key it starts with after lowercasing and dropping a bracketed suffix (`[1m]`) or a provider
prefix; a date or a word may follow (`-20251001`, `-codex`) but not another version number, so an unknown newer model
stays unpriced instead of taking an older one's price; a `-pro` model has its own key. Keys are normalised once per
table, not on every lookup. Claude's 1-hour cache writes are priced at 2× input, 5-minute ones at 1.25×. OpenAI's GPT-6
and GPT-5.6 models charge 1.25× input for a 30-minute cache write, which is the rate Codex's single cache-write count
gets; older OpenAI models and Gemini bill writes as plain input.

Long-context rates (Haiku 5.5 past 100K-token prompts, OpenAI past 272K, Gemini 3.1 Pro past 200K) aren't modelled,
since a transcript doesn't give a request's prompt size, so very long prompts are underestimated. Models no source
lists (Codex's `codex-auto-review`) stay unpriced.

Past usage is repriced at the current prices whenever it's read: a price change, a new fetch or an override applies to
old rows too. A model with no price shows its tokens and "no price", never $0. The UI marks estimates with `~` and
calls them API-equivalent: a subscription may cost less. A cost a run reported itself is shown as reported, without
the `~`. The panel's and the stats page's footnotes say where the prices came from (`TaskUsage.prices`,
`StatsResponse.prices`: source, date and status).

#### LiteLLM's price list

`integrations/modelPrices.ts` fetches `model_prices_and_context_window.json` from BerriAI/litellm on
raw.githubusercontent.com, falling back to the same file through `api.github.com` (`Accept:
application/vnd.github.raw+json`), with a 10-second timeout. It checks hourly whether the list is a day old and
fetches then, only while the pollers run; Settings › Integrations › Model prices has Refresh now
(`POST /api/model-prices/refresh`), at most once a minute, and a failed fetch waits at least a minute before the next.
Calls in flight are shared. `GET /api/model-prices` gives the status.

- **What is read.** Only entries whose `litellm_provider` is `anthropic`, `openai` or `gemini`: their own list prices,
  the ones the built-in table uses. Azure, Bedrock and reseller entries list the same models at other prices and are
  ignored. LiteLLM gives USD per token, multiplied by 1e6.
- **Mapping.** `input` and `output` from `input_cost_per_token` and `output_cost_per_token`; an entry missing either is
  dropped, so cost is never understated. `cacheRead` from `cache_read_input_token_cost`, `cacheWrite5m` from
  `cache_creation_input_token_cost`, each else the input rate. `cacheWrite1h` from
  `cache_creation_input_token_cost_above_1hr` (Claude), else `…_above_12hr` (OpenAI), else `cacheWrite5m`.
- **Conflicts.** Two first-party entries that normalise to the same name at different prices drop it, and the built-in
  table prices it.
- **Cache.** The last good raw document and its fetch time are kept at `<data dir>/model-prices.json`, written
  atomically and re-parsed on start, so a restart or being offline still has prices and a parser fix applies without
  a fetch. A response with no usable entries never replaces it. It isn't backed up: it can be fetched again.
- **Status.** `fresh`: fetched by this server run. `cached`: read from disk, or the last fetch failed and the copy is
  still used. `unavailable`: nothing was ever fetched, so the built-in table prices. `off`: `modelPriceFetch` is off,
  so nothing is fetched and no fetched price is used.
- **Tests and the sandbox.** The fetcher and clock are injected; only `integrations/index.ts` passes the real `fetch`,
  and the test harness passes one that always fails. The sandbox seeds a small list with the current time
  (`seedModelPrices`), and its pollers are off, so it never fetches unless Refresh now is pressed.

### Attribution

A task's panel shows every session and thread it links in full, marked "shared with #x" when another task links it
too (directly, or a session behind the thread), plus its board runs. Rows follow link order, then board runs.

An agent running in T3 Code links its thread and also its own Claude Code session (`selfLinkHosts`), and both resolve
to the same stored rows. The panel picks the thread: a session behind a T3 thread the task links is folded into that
thread's row (T3 icon, harness `t3`), wherever its own link sits in the order; only a session no linked thread covers
gets a row of its own. The session link stays (Open in terminal, resume, live status); only the usage row moves. The
thread row is named by the label the agent gave its session ("Planning #169") when exactly one session behind it has
one, with the thread's own title kept in `threadTitle` and shown as "Thread: …" when the row is expanded; otherwise by
the thread's title. Expanded, a thread row's model lines name the provider behind it ("Claude Code · claude-opus-5-5"),
one line per provider and model, so a thread that switched providers shows each; tokens counted from T3's own turns
(`t3_turn`) have no provider to name. A session behind two linked threads goes to the first. Until the thread has been read
(`session_usage_thread` is empty while T3 Code isn't running), the session shows as its own Claude Code row and moves
under the thread once the read lands.

Stats count each session once, under the task that linked it first (directly or through a thread), like
`agent_sessions_started`. Its harness bucket is "T3 threads" when any live task links a thread it ran behind, whichever
link came first, so Stats and the panel agree; past weeks re-bucket on read. A run counts under the task it was for, and a task-less run only on the whole
board. A session an Autopilot run kept (`autopilot_runs.session_id`) also counts under that run's automation. "Autopilot
overhead" counts only automations; the board's own runs (`review`, `import`, `ask`) show beside them in the cost by
run, never in Autopilot's figure. An import that fails after spending tokens records nothing: its output is lost
with the error. Unlinking keeps the rows; purging a task deletes its run rows and
the rows of its own sessions and threads no other task links, never those of a session unlinked earlier or a
task-less run's.

## Decisions

- **History is kept.** Claude Code deletes transcripts after 30 days, so the rows outlive their files. That is a
  departure from the stats' "nothing recorded for the purpose", and why backups include `session_usage` with its
  cursors and thread map: restoring rows without cursors would read the files again and count them twice.
- **The transcript always wins over a run's reported cost.** The plan once kept a run's reported cost unless the
  transcript showed later use; reading the transcript is simpler and is never too low when a user carries on an
  Autopilot session by hand.
- **Prices are fetched from LiteLLM.** #152 shipped with a hand-kept table and no network access; it went stale within
  a month (missing models, a cache-read rate twice the real one) and providers announce price changes ahead. #155
  reversed that on purpose: LiteLLM's list is fetched daily, as T3 Code does, with the built-in table kept as the
  offline fallback and a setting to turn the fetch off. Only first-party entries are read, unlike T3 Code's merging of
  every provider's aliases, which would drop models a reseller lists without a cache rate.

## Code map

| What                                         | Where                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Types, price table, estimate, LiteLLM parser | `packages/contracts/src/usage.ts`, `modelPricing.ts`                                     |
| Fetching LiteLLM's list, its cache, status   | `apps/server/src/integrations/modelPrices.ts`; routes in `http/routes/system.ts`         |
| Settings row                                 | `apps/web/src/components/settings/ModelPricesSection.tsx`                                |
| Tables                                       | `apps/server/src/db/migrations/050_session_usage.sql`, `db/repos/sessionUsage.ts`        |
| Incremental file reading                     | `apps/server/src/integrations/usageFiles.ts`                                             |
| Readers                                      | `integrations/claudeUsage.ts`, `codexUsage.ts`, `t3Usage.ts`, `runUsage.ts`              |
| Scanning, run records, a task's usage        | `apps/server/src/services/usage.ts`                                                      |
| Triggers                                     | `integrations/usageSweep.ts`, `agentSessions.ts` (poll), `t3.ts` (applyShell), `index.ts` (refreshLink) |
| Attribution and cost for stats and Spend     | `services/usage.ts` (`attributed`)                                                       |
| Stats series and breakdowns                  | `apps/server/src/services/stats.ts`; `board_activity`'s Spend in `services/activity.ts`  |
| `get_task` line                              | `apps/server/src/mcp/format.ts` (`usageLine`)                                            |
| Panel section                                | `apps/web/src/components/task/UsageSection.tsx`, `usage.logic.ts`                        |
| Stats section                                | `apps/web/src/components/stats/StatsPage.tsx` (Tokens & cost)                            |
| Sandbox data                                 | `apps/server/src/dev/usageSeed.ts` (stats scenario; `seedModelPrices` for every seed)    |
