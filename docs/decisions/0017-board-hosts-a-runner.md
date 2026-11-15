# 0017 A board may host a runner in its own process, with a store of its own

Status: Accepted

Amends [0015](0015-machine-api-auth.md), which stays the rule for every runner and for a board on its own.

## Context

A laptop with its own board may also be the machine another board runs tasks on (epic #178,
[remote machines](../features/remote-machines.md#a-board-that-is-also-a-runner)). Installing a second program there
for the runner role would mean a second updater, a second service and a second set of logins for one machine the
user already runs the app on. One install has to play both roles.

Three things make that risky. The other board's tasks must never reach this board's tables, backups or stats.
Agents on the machine call the one `127.0.0.1` address they know, whichever board their task is on. And 0015 says a
board binds loopback only, and that no request can make a pairing code.

## Decision

- **A second server in the board's process, not a second role inside the first.** With "Let other machines run tasks
  here" on, the board calls `startServer` again in the runner role (`apps/server/src/hostedRunner.ts`), with its own
  data dir (`<board data dir>/runner`), database, port, pairing, tokens, worktrees and Autopilot engine. No table
  is shared, so nothing it holds can be written to the board's.
- **The board hands on what is the runner's.** A tool call on the board's `/mcp`, or a request to
  `/api/tasks/:ref` that no browser sent, that names a task only the runner has, or a folder that is the runner's (in
  its data dir, or a worktree of one of its clones), is sent to the runner on loopback and answered by it
  (`apps/server/src/http/hostedForward.ts`). A task number both boards use is refused with both ids; it is never
  guessed.
- **The runner listens; the board doesn't.** The runner's listener follows 0015 (loopback, or `private` when the user
  asks for Tailscale). The board's own listener stays on `127.0.0.1` with 0003's rules.
- **A pairing code can come from the board's Settings.** `POST /api/runner/pairing` writes one into the hosted
  runner's database. It is a local request under 0003, which already trusts any process on the machine as the user,
  as 0015 trusts a login there to run `pair`. Nothing reachable from another machine can make one.
- **The app decides the runner's version.** The runner says so in its descriptor (`updatesWithApp`); a board never
  asks it to update and the runner refuses if one does. A protocol mismatch stops the exchange as for any runner
  until the app on that machine is updated.

## Consequences

- One process, two databases: module-level state is shared. Transactions count their nesting per database
  (`apps/server/src/db/database.ts`), and new module-level state has to be safe for two servers in one process.
- A task number that both boards use can't be named by number on this machine while the runner holds it: agents
  are told (server instructions) and the refusal lists both ids.
- A route the hosted runner should answer for that names a task in another argument (not `task`, `epic`, `tasks`,
  a `workspacePath`, a session's `cwd` or a `projectId`) is answered by the board, which doesn't have the task.
- The runner's port must be free: a standalone runner on the same machine, on the default port, keeps it from
  starting, and Settings says so.
- The board can't pair with its own runner, and the runner still serves one board.
