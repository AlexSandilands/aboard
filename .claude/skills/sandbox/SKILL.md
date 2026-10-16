---
name: sandbox
description: Run this checkout's board on its own ports with example data, so a change can be tried in the browser without touching the board the user runs from main. Use when asked to preview, try, test, demo or screenshot a UI change in this repo, or to "spin up a server with some data".
---

# Sandbox: preview this checkout's board

The user runs their real board from main (server :4317, Vite :5317, data in their home folder). A
sandbox runs _this_ checkout's server and Vite on free ports with a throwaway data dir, seeded from
code. One command does all of it; don't rebuild it by hand.

## Pick a mode

- **Isolated (default):** `pnpm sandbox [--seed basic|review|threads|showcase|none]`. This checkout's server on
  a temp data dir, pollers off, T3 Code integration off, Vite with hot reload. Use it for anything:
  web, server or contracts changes, and anything that writes.
- **Live:** `pnpm sandbox --live`. This checkout's Vite on the user's real server and real data. The
  real server rejects writes from the sandbox port (403), so it's for _looking_ at a web-only change
  against real data. Needs the real server running.

Seeds (`apps/server/src/dev/seeds.ts`):

- `basic`: two projects, every column, ideas with and without plans, a blocked step, a handover note,
  more than five Done, closed (duplicate / won't do) and archived cards.
- `review`: a task per local-review state (pending, running, stalled, failed, findings at every
  severity, clean after two rounds, re-review pending).
- `threads`: PR links in each state (open, draft, failing, conflicting, merged, closed, not polled)
  and T3 thread links in each status, plus Jira and plain links.
- `showcase`: a busy, realistic board for screenshots and demos: four projects with icons, labels,
  PRs, T3 threads, review findings, a blocked step and a handover on one screen.
- `none`: an empty board.

## Steps

1. Start it **in the background** (it keeps running), e.g. Bash with `run_in_background: true`:
   `pnpm sandbox --seed basic`.
2. Wait for the line starting with `SANDBOX_READY`. It carries JSON with `url`, `serverPort`,
   `webPort`, `mode`, `seed` and `home`. Don't navigate before it appears; it means the server, Vite
   and Vite's proxy all answer. `pnpm sandbox status` prints it again. If a sandbox for this checkout
   is already running, starting again just prints its ready line (stop it first for a fresh seed).
3. Open `url` (the T3 preview browser, or give it to the user). If the preview times out, retry once,
   then hand the user the URL instead of looping.
4. Tell the user what to try: which cards or states show the change, and what to click.
5. Edits hot-reload: web changes apply in place, server changes restart the sandbox server. Seed data
   is only written at start, so restart (`stop`, then start) to reseed.
6. **Always stop it when done:** `pnpm sandbox stop`. It kills the processes and deletes the temp data
   dir. Stopping the background task alone can leave processes behind on Windows; `stop` cleans those
   up too.

## Rules

- Never point a sandbox at the user's real data dir. The script refuses to, and strips the inherited
  home and token env vars; don't work around it.
- `--live` shows the user's real board. Don't try to make it writable.
- Need data the seeds don't have? Add or extend a scenario in `apps/server/src/dev/seeds.ts` (it calls
  the services, and `links.setSnapshot` for PR and T3 thread state) and its test, instead of curling
  the API or writing SQL. Payloads are easy to get wrong by hand (`title` not `name`, `phases` not
  markdown).
- One sandbox per checkout. Other worktrees' sandboxes use other ports and dirs; leave them alone.
