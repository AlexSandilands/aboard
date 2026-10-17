# 0010 The board may start a new agent session with the user's prompt

Status: Accepted

## Context

[ADR 0009](0009-board-starts-local-processes.md) lets the board open a terminal that resumes a linked Claude Code or
Copilot CLI session, with a command built from the stored link alone. The hand-off menu now also starts new
sessions: the CLI opens in a terminal with the task's hand-off prompt as its first message, and the user may edit
that prompt, pick a model and a branch first. So a request carries text that ends up on a command line, which 0009
ruled out, and the board names Windows Terminal windows so it can bring a session's window back.

The prompt can't be reduced to tokens that need no quoting: it is prose, with quotes, brackets and line breaks. On
Windows it crosses Windows Terminal (which quotes an argument with spaces without escaping quotes inside it) and
often cmd.exe (a console window, a custom command, an npm `.cmd` shim), which has no escape inside quotes and
expands `%NAME%` even there.

## Decision

- **Only `POST /api/tasks/:id/sessions` takes request input onto a command line**, behind the guard of
  [ADR 0003](0003-localhost-guard.md), like every REST route. MCP has no tool for it, so an agent can't start one.
- **The executable is chosen by the board:** the CLI path from Settings (changed over REST only), else `claude` or
  `copilot` on PATH. Its flags come from the board too: `--session-id` with a UUID the board picks, `--name` with
  the board's label, `-i` for Copilot.
- **The model is a `CliModel`:** letters, digits and `. : @ / [ ] -`, checked on the request and when a tier's
  model is saved. A branch to start a worktree from reaches git as an argument, never a shell, and may not start
  with `-`.
- **The prompt is one argument, made safe for the platform first** (`textArgument` in
  `apps/server/src/integrations/terminal.ts`). POSIX shells take it single-quoted as written. On Windows line breaks
  become spaces, `"` becomes `'`, a trailing backslash gets a space after it, it always contains a space (so it is
  always quoted), and a `%` is refused. Control characters are dropped everywhere. Each shell then quotes it as in
  0009 (PowerShell's single quotes also double the typographic single quotes, which PowerShell reads as quotes). A
  prompt that is refused, or a command line over 8,000 characters on Windows, is replaced by a short prompt built from
  the stored task alone.
- **Window names are the board's.** A session the board starts in Windows Terminal opens in the window
  `<brand>-<task number>` (`taskWindowName`). The name is stored on the link beside its ref, where only the board
  writes it, and is checked again (`isTaskWindowName`: a letter first, a number last, nothing wt reads as an option
  or a window id) before it reaches `wt -w`. Opening a running session with a window runs
  `wt -w <name> focus-tab -t 0` instead of answering 409.

## Consequences

- The user can make the board run `claude` or `copilot` with any prompt they type, in a project folder or a new
  worktree. That is no more than they could type into a terminal themselves; a page on another origin still can't
  reach the route.
- On Windows the CLI receives a prompt that differs from what was typed (no line breaks, `'` for `"`). Agents read it
  the same, and the dialog's text is what the user approved.
- Adding a harness that can start sessions means its new-session flags in `newSessionArgv` and a review of how it
  takes a prompt (a positional argument, `-i`).
- A worktree made for a session is the user's: nothing removes it automatically.
