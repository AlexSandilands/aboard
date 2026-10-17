# 0009 The board may start a terminal, from a stored link only

Status: Accepted; extended by [0010](0010-board-starts-new-sessions.md), which lets the user start new sessions with a
prompt and lets the board bring back a window it named

## Context

Agents in Claude Code and Copilot CLI link their session to a task, so the user can reopen it from the
card: **Open in terminal** runs `claude --resume <id>` (or `copilot --resume=<id>`) in a new terminal
window, in the session's folder. That makes the server start an interactive process on the user's
machine because a browser asked it to, which nothing did before: the board's other processes (`gh`,
`git`, `claude -p` for imports and reviews) run headless with arguments the server chose.

The inputs come from two places that can't be fully trusted. The session id and folder are written by an
agent over MCP. The request to open it comes over REST, which any local process can send, and which a web
page could try to send through the user's browser.

## Decision

- **The command comes from the stored link alone.** `POST /api/links/:id/resume` takes only a mode
  (`resume` or `fork`) and `force`. The executable, its flags and the folder are read from the link row,
  never from the request.
- **The link is validated twice.** `AgentSessionRef` (`packages/contracts/src/agentSessions.ts`)
  accepts a session id only if it is a UUID and a folder only if it is an absolute path, when the link is
  added and again before launching. The folder must exist and be a directory.
- **Processes start from an argument array.** `apps/server/src/integrations/terminal.ts` builds `file`
  plus `args` for each terminal and shell, and `spawn` runs them without a shell. The two places a
  shell parses a line, `cmd.exe /c start` for a console window and a user's custom template, get only
  tokens that need no quoting (the CLI name, its flags, the UUID), with the folder passed as the
  process's working directory or quoted for that shell. The quoting has unit tests per shell.
- **The guard still applies.** The route sits behind the Host, Origin and token checks of
  [ADR 0003](0003-localhost-guard.md), so a page on another origin can't reach it.
- **The template is a setting.** A custom terminal command is a user setting, changed over REST and not
  over MCP, so an agent can't choose what the board runs.
- **Running sessions are not reopened silently.** The server rereads the session's status before
  launching and answers 409 when it is running, unless the user forces it or forks it into a new session.

## Consequences

- Agents can make the board run exactly two programs, `claude` and `copilot`, with a resume flag and an
  id. Adding a harness means a new entry in `AGENT_HARNESSES` and a review of its resume flags.
- Whatever `claude` or `copilot` resolves to on the server's PATH is what runs. That is the user's own
  PATH, as for the board's other CLIs.
- Out of scope: focusing a window that already shows the session (no reliable way across terminals), and
  resuming sessions of harnesses that run in an editor (VS Code agent mode).
- The terminal setting is machine-specific, so it isn't exported in backups.
