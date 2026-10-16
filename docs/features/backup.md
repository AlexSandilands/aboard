# Backup and restore

Board task: #65.

The board lives in one SQLite file. If that file is deleted or corrupted, nothing else holds the board. Backup
writes the whole board out as JSON: on demand from the CLI, or on a schedule into a git repo the server commits
and pushes, so the history lives off the machine. Restore loads a dump into a new database, and can also put a
single deleted task back on a live board.

## How it works

### The dump

`dumpBoard` reads every table in one transaction and returns a `BoardDump` (`packages/contracts/src/backup.ts`).
Rows keep the database's column names, and the manifest records the schema version: the last migration applied.

The folder form is laid out for git:

```
manifest.json        format, app, app version, schema version, row counts
settings.json        allow-listed settings only
projects.json
labels.json          label colour overrides
counters.json
autopilot.json       Autopilot switches and config per scope (optional: older dumps have none)
tasks/2026-10/task-42.json   one task with its phases, steps, links, labels, reviews and findings
events/2026-10.json          the activity log for the month the events happened
```

- Tasks go in the folder for the month they were **created**, so old folders stop changing. Events live
  apart from tasks, by month, so a long-running task's file doesn't grow with every step update.
- Every file is deterministic: rows sorted by key or plan order, one row per line, trailing newline. The same
  board gives byte-identical files, and a write only touches files whose bytes changed.
- A deleted task's file is removed, so git history shows what was lost and when. Files the dump doesn't own
  (`.git`, a README) are left alone.
- Each file is written to a temp file and renamed, so a crash never leaves half a file.

The single-file form (`export --file`) is the same `BoardDump` as one JSON document, for moving a board by hand.

### What's left out

- **Settings** are exported from an allow-list (`EXPORTED_SETTINGS` in `apps/server/src/services/settings.ts`).
  The T3 token and the backup settings themselves (they describe this machine) stay out, and so does any key
  nobody has added to the list. A test fails when a new setting is in neither the allow-list nor the
  machine-only list. Autopilot's engine settings and pause (`autopilotEngine`, `autopilotPaused`) are exported.
- **Autopilot runs** are history, so they stay out; Autopilot's settings go in ([autopilot](autopilot.md)).
- **A link's `snapshot_json` and `synced_at`** are the GitHub and T3 pollers' cache, rewritten on every poll.
  Dumping them would make every scheduled run a commit; the pollers refill them after a restore.

### Restoring a board

`restoreBoard` (`apps/server/src/services/backup/restore.ts`):

1. Checks the manifest: our app, a format this version reads, a schema version it knows (a dump from a newer
   version is refused).
2. Refuses a database that already holds a board unless `force` is set. With `force`, settings that never go
   into a dump (the T3 token, the backup setup) are carried over from the database being replaced.
3. Creates `<db>.restoring`, migrates it **up to the dump's schema version**, and loads every row in one
   transaction with foreign keys deferred. Before committing it runs `PRAGMA foreign_key_check` and compares
   each table's row count with the manifest; any mismatch rolls the whole load back.
4. Runs the remaining migrations, so a dump taken today still restores after future migrations ship.
5. Moves the old database aside as `<db>.before-restore-<time>` and swaps the new one in.

The CLI refuses to restore while a server is running on the data dir. A running server writes `server.json`
(its pid and URL) into the data dir and removes it on close; the CLI checks that URL's `/api/health`, so a
file left by a crashed server doesn't block a restore.

### Restoring one task

`backup.restoreTask` puts one task from a dump back on the live board with its plan, links, labels, reviews
and history, and logs a `restored` event. It refuses a task that is still on the board unless forced (which
replaces it), needs the task's project to be on the board, takes a new number if another task holds the old
one, drops a "closed by" pointer to a task that no longer exists, and keeps other tasks' "closed by" pointers to
a task it replaces. Epics work the same way: a task goes back into its epic only if that is still an epic in its
project (else it comes back loose), a replaced epic keeps its tasks, and the epics involved re-derive their
status ([epics](epics.md)). A dump at an older schema is first
loaded into an in-memory database, migrated and dumped again, so its rows fit the current tables. The CLI
sends it to the running server (`POST /api/backup/restore-task`) so open boards update, or writes the
database directly when no server is running.

### Scheduled git backup

Settings → Backup sets a folder, an optional remote and an interval. `apps/server/src/integrations/backup.ts`
checks every minute whether a run is due (and once shortly after startup). A run:

1. Prepares the folder: an empty folder is cloned from the remote (or `git init`ed without one). A folder
   with no `.git` is accepted only if it already holds a dump. A repo with tracked files but no manifest of
   ours is refused, so the board never commits into someone else's repo; a README, licence, `.gitignore` or
   `.gitattributes` (what a host adds to a new repo) doesn't count.
2. Pulls with `--rebase` when the branch has an upstream, so commits made on the remote (a README edited on
   GitHub) don't get every push rejected. A failed pull (offline) is aborted and recorded; the run still
   commits locally. Leftover `*.json.tmp` files from a crash are removed before writing.
3. Writes the dump, `git add -A`, and commits only if `git status` shows changes. The message counts task
   files: `Back up board: 2 tasks changed, 1 added`.
4. Pushes when the branch is ahead of its upstream (or has none yet).

The machine's own `git` does the work, so pushing uses the credentials it already has (Git Credential
Manager, SSH keys) and the board stores no token. `GIT_TERMINAL_PROMPT=0` makes a missing credential fail
instead of hanging. When the machine has no git identity, commits use the app's name. A failed run or push is
recorded as `lastError` in the status and retried next run; commits made while offline queue locally and go
out with the next push.

The status (last run, last commit, last push, last error) is held in memory and served at
`GET /api/backup/status`; "Back up now" calls `POST /api/backup/run`.

## Decisions

- **JSON in git, not a copy of the `.db`.** The database runs in WAL mode; sync tools copy the `.db`,
  `-wal` and `-shm` files independently and can capture an inconsistent set, and a binary file in git stores
  a near-full blob per commit. Text dumps diff cleanly and give a readable per-task history.
- **One file per task, sharded by month.** Not for size (thousands of tasks are a few MB) but for small
  diffs, files that go quiet once their tasks are done, never meeting GitHub's file size limit, and
  single-task restore.
- **No timestamp in the manifest.** It would make every dump differ and every run commit; the commit
  time records when a backup was taken.
- **Restore through the dump's schema version** rather than mapping old rows onto the current schema in
  code. The migrations already know how to move data forward, including the data fixes some of them make.
- **Allow-list for settings.** "Everything except secrets" leaks the next secret someone adds.
- **Use the system git.** No credentials to store, and it works with whatever git sign-in you already use.
- **Point it at a private repo.** Anything an agent pastes into a
  note stays in git history for good. The settings row says so.

## Alternatives considered

| Option                                      | Why not chosen                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Sync the data dir with OneDrive             | Copies WAL files independently, locks files, makes conflict copies                     |
| `VACUUM INTO` a backup `.db` and commit it  | Consistent, but binary: no diffs, a large blob per commit, no single-task restore      |
| One big JSON file                           | Every change rewrites one huge file; diffs are noisy and restoring one task is harder |
| Store a GitHub token and push over the API  | A secret to keep; the system git already has working credentials                       |

## Code map

| File                                              | What it does                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/contracts/src/backup.ts`                | Dump, manifest, backup settings and status schemas; format version   |
| `apps/server/src/services/backup/dump.ts`         | `dumpBoard`: the board as a `BoardDump`, minus the link cache        |
| `apps/server/src/services/backup/files.ts`        | Folder layout, deterministic formatting, writing and reading dumps   |
| `apps/server/src/services/backup/restore.ts`      | `restoreBoard`, `upgradeDump`, manifest checks                       |
| `apps/server/src/services/backup/index.ts`        | The backup service: `dump` and `restoreTask`                         |
| `apps/server/src/integrations/backup.ts`          | Scheduled git backup: prepare the repo, commit, push, status         |
| `apps/server/src/backupCli.ts`                    | `pnpm backup export / import / restore-task`                         |
| `apps/server/src/serverFile.ts`                   | `server.json` in the data dir, so the CLI can tell a server is up    |
| `apps/server/src/db/database.ts`                  | `migrate(db, upTo)` and `schemaVersion`                              |
| `apps/web/src/components/settings/BackupSection.tsx` | The Settings → Backup section                                     |
