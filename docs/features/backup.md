# Backup and restore

Board tasks: #65; machine folders #69 and guided setup #13 (epic #68).

The board lives in one SQLite file. If that file is deleted or corrupted, nothing else holds the board. Backup
writes the whole board out as JSON: on demand from the CLI, or on a schedule into a git repo the server commits
and pushes, so the history lives off the machine. Restore loads a dump into a new database, and can also put a
single deleted task back on a live board.

## How it works

### The dump

`dumpBoard` reads every table in one transaction and returns a `BoardDump` (`packages/contracts/src/backup.ts`).
Rows keep the database's column names, and the manifest records the schema version: the last migration applied.
A dump the git backup writes also records the machine that wrote it (`instanceId`, `machineName`; see
[Machine folders](#machine-folders)); both are optional, so dumps from before them still parse.

The folder form is laid out for git:

```
manifest.json        format, app, app version, schema version, row counts
settings.json        allow-listed settings only
projects.json
labels.json          label colour overrides
templates.json       task templates (absent in backups taken before templates existed)
relations.json       blocks / blocked-by pairs
counters.json
autopilot.json       Autopilot switches and config per scope (optional: older dumps have none)
recurring.json       recurring-task rules (optional: absent before Recurring tasks)
custom-automations.json  custom Autopilot automations (optional: absent before them)
suggestions.json     suggested changes to prompts and skills, open and decided (optional: absent before them)
tasks/2026-10/task-42.json   one task with its phases, steps, links, attachment rows, labels, reviews and findings
attachments/<task id>/<id>.png   the task's pasted images (see attachments.md)
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
  machine-only list. Saved board views (`savedViews`, [saved-views](saved-views.md)) and Autopilot's engine
  settings (`autopilotEngine`) and custom automations' board-wide variables (`automationVariables`; a project's own
  are its `variables_json` column, which goes with the project) are exported, and so is `generalProjectId` (which project is General), so a
  restore doesn't make a second one; a dump from before General existed gets a new one on the next start;
  its pause (`autopilotPaused`) isn't, so restoring a backup can't lift Pause all.
- **Autopilot runs** are history, so they stay out; Autopilot's settings go in ([autopilot](autopilot.md)). The same
  goes for deleting them: the run history page deletes runs by hand ([autopilot](autopilot.md#run-history)), and a
  backup can't bring them back.
- **Automation drafts** (`autopilot_drafts`, [autopilot](autopilot.md#drafts)) are a hand-off from an agent that
  expires; only importing one makes it the user's, as a custom automation, which is backed up.
- **A link's `snapshot_json`, `synced_at` and `pr_changes_json`** are the GitHub and T3 pollers' cache, rewritten on
  every poll (`pr_changes_json` is when each PR state began, for Autopilot's custom PR triggers).
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

Pasted images are copied next to the JSON and copied back by a restore; see [attachments.md](attachments.md).

### Scheduled git backup

Settings → Board → Data sets a folder, an optional remote, an interval and the machine's name.
`apps/server/src/integrations/backup.ts` checks every minute whether a run is due (and once shortly after startup).
A run:

1. Prepares the folder: an empty folder is cloned from the remote (or `git init`ed without one). A folder
   with no `.git` is accepted only if it already holds a backup. A repo with tracked files but no backup of ours
   (a `backup.json`, a flat dump, or a machine folder) is refused, so the board never commits into someone else's
   repo; a README, licence, `.gitignore` or `.gitattributes` (what a host adds to a new repo) doesn't count.
2. Pulls with `--rebase` when the branch has an upstream, so commits made on the remote (another machine's
   backup, a README edited on GitHub) don't get every push rejected. A failed pull (offline) is aborted and
   recorded; the run still commits locally. Leftover `*.json.tmp` files from a crash are removed before writing.
3. Moves a flat backup into this machine's folder, or renames this machine's folder, each in a commit of its
   own, and refuses a name another machine's folder has (see [Machine folders](#machine-folders)).
4. Writes the dump into `<machine name>/` and `backup.json` at the root, `git add -A`, and commits only if
   `git status` shows changes. The message counts task files: `Back up board: 2 tasks changed, 1 added`.
5. Pushes when the branch is ahead of its upstream (or has none yet).

The machine's own `git` does the work, so pushing uses the credentials it already has (Git Credential
Manager, SSH keys) and the board stores no token. `GIT_TERMINAL_PROMPT=0` makes a missing credential fail
instead of hanging. When the machine has no git identity, commits use the app's name. A failed run or push is
recorded as `lastError` in the status and retried next run; commits made while offline queue locally and go
out with the next push.

The status (last run, last commit, last push, last error) is held in memory and served at
`GET /api/backup/status`; "Back up now" calls `POST /api/backup/run`. `GET /api/backup/machines` lists the
repo's machine folders (folder, owner, whether it is this board's, when a commit last touched it, as of the
clone's last pull).

### Guided setup

Settings → Board → Data shows **Set up backup** while no folder is set, and a **Local only: commits aren't
pushed** row with **Connect GitHub** while no remote is (`backupState` in `backupSetup.logic.ts`); runs without a
remote only ever committed locally, and nothing used to say so. Both open `BackupSetupDialog`: folder → remote →
first backup. The server side is `apps/server/src/integrations/backupSetup.ts`:

- `GET /api/backup/setup-info`: gh installed and signed in to github.com (re-checked on each call, so a
  `gh auth login` made with the dialog open shows up after "Check gh again"), the default folder
  `<data dir>/backup`, the current folder, remote and machine name, and the repo name to offer
  (`<product id>-backup`).
- `POST /api/backup/github-repo` runs `gh repo create <name> --private` and returns the clone URL: SSH when gh's
  `git_protocol` is `ssh`, else HTTPS, which `gh auth setup-git` signs git in for. A name the account already has
  is a `CONFLICT` that says to use it as an existing repo.
- `POST /api/backup/check-remote` runs `git ls-remote` in a scratch folder: reachable, `auth_failed`, `not_found`
  (GitHub's answer for a private repo the account can't see, too) or `error`. A repo with branches is cloned with
  `--depth 1` to say whether it is empty (only a README and the like), a backup (with its machine folders, so the
  dialog can refuse a name another machine has) or something else, which the run would refuse.

The last step saves the folder, remote and machine name, turns backup on and calls `POST /api/backup/run`,
showing the commit, the push or the error. gh and git keep the credentials; the board stores none.

### Machine folders

Several machines can back up to one repo. The repo holds `backup.json` and one folder per machine:

```
backup.json      {"app": ..., "repoFormat": 1}: marks the repo as ours and versions this layout
laptop/          one machine's dump, laid out as above (manifest.json, tasks/, events/, ...)
desktop/
```

- **Identity.** Each board has an `instanceId`: a random uuid in `<data dir>/instance-id`
  (`apps/server/src/instance.ts`), made on first start by writing a temp file and hard-linking it into place, so
  two processes starting at once agree on one id. It is not a setting, so it is never part of a dump and a restore
  doesn't change it: a board restored onto a new machine is a new machine. The folder's `manifest.json` records
  the `instanceId` and `machineName` that wrote it, which is how a folder's owner is known.
- **The name** is the `machineName` setting, machine-only like the rest of the backup settings. Unset, it is the
  host name made folder-safe (`machineNameFrom`), and the first backup saves it as the setting, because some host
  names change with the network (macOS) and each change would move the folder. It must be letters, digits, `.`,
  `_` or `-`, starting with a letter or digit; not `tasks`, `events`, `attachments`, `backup.json` or
  `manifest.json`; and not a name Windows can't use as a folder (`con`, `nul`, `com1`, ..., or a trailing dot), so
  every machine can check the repo out (`MachineName` in contracts).
- **Name clash.** After the pull, a folder of the same name (ignoring case, as Windows and macOS do) whose
  manifest names another `instanceId` fails the run with "choose another machine name in Settings"; so does a
  same-named folder that isn't a backup. When this machine committed its own folder of that name before it saw
  the remote (backed up with no remote set, or offline), the pull itself stops on a conflict; the run then
  checks the upstream's folder of that name and fails with the same message instead of git's. Once the machine is
  renamed, the next failed pull finds unpushed commits that wrote into another machine's folder, keeps them on a
  local branch `unpushed-backups-<sha>` (they may be the only copy of that machine's older snapshots), resets to
  the upstream and sends a `backup_notice` naming the branch; the run then writes the whole dump again from the
  database. A folder whose manifest has no `instanceId` (moved in from a flat backup
  by hand) is taken over.
- **Renaming.** When this board's folder (found by `instanceId`) has another name and nothing holds the new one,
  the run moves it with `git mv`, through a temporary name so a change of case works (and is recorded where git
  ignores case), and commits
  `Rename the backup folder laptop/ to work-laptop/`.
- **Migration.** A repo with a dump at its root (a flat backup, from before machine folders) is moved into this
  machine's folder by the next run: every dump entry (`DUMP_ENTRIES` in `files.ts`) is renamed into it,
  `backup.json` is written, and the move is committed on its own as `Move the backup into laptop/`, so
  `git log --follow` keeps each file's history. The run then sends a one-time `backup_notice`
  ([notifications](notifications.md)). An older version pointed at a migrated repo finds no root `manifest.json`
  and refuses it as "other content" instead of writing over it.
- **No conflicts.** Each machine writes only inside its own folder, and `backup.json` holds nothing per machine,
  so every machine writes the same bytes. Two machines that both add it before seeing each other's rebase
  cleanly.

The CLI's `import` and `restore-task` take a backup repo with `--machine <folder or name>` (not needed when it
has one machine), one machine's folder, or a flat backup (`resolveDumpDir` in `repo.ts`).

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
- **One repo, a folder per machine** rather than a repo per machine or one shared dump. Machines don't share a
  board (each has its own database), so their dumps can't be merged; folders keep them side by side, and each
  machine only ever writing its own folder means the existing `pull --rebase` never meets a conflict.
- **No machine list in `backup.json`.** A list every machine edits would conflict when two machines add
  themselves between each other's pull and push. Each folder's manifest says whose it is instead.
- **The dump format stays at 1.** A machine folder holds the same dump as before; the manifest's new keys are
  optional and older versions ignore them, so bumping `BACKUP_FORMAT_VERSION` would only make older versions
  refuse dumps they read correctly. The repo layout has its own `repoFormat` in `backup.json`.
- **The instance id is a file, not a setting.** Settings travel in backups and restores; an identity that
  did would let a restored board claim the folder of the machine it came from.
- **Point it at a private repo.** Anything an agent pastes into a note stays in git history for good. The
  settings row says so.

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
| `apps/server/src/services/backup/repo.ts`         | The backup repo: `backup.json`, machine folders, picking a dump to read |
| `apps/server/src/instance.ts`                     | `instanceIdOf`: this board's id in the data dir                      |
| `apps/server/src/services/backup/restore.ts`      | `restoreBoard`, `upgradeDump`, manifest checks                       |
| `apps/server/src/services/backup/index.ts`        | The backup service: `dump` and `restoreTask`                         |
| `apps/server/src/integrations/backup.ts`          | Scheduled git backup: prepare the repo, migrate, claim the folder, commit, push, status, machines |
| `apps/server/src/backupCli.ts`                    | `pnpm backup export / import / restore-task`                         |
| `apps/server/src/serverFile.ts`                   | `server.json` in the data dir, so the CLI can tell a server is up    |
| `apps/server/src/db/database.ts`                  | `migrate(db, upTo)` and `schemaVersion`                              |
| `apps/server/src/integrations/backupSetup.ts`     | Guided setup: setup info, `gh repo create`, checking a remote        |
| `apps/web/src/components/settings/BackupSection.tsx` | The Settings → Board → Data section                                     |
| `apps/web/src/components/settings/BackupSetupDialog.tsx` | The setup dialog; its wording and checks are in `backupSetup.logic.ts` |
