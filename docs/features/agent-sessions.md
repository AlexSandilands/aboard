# Agent sessions

Board task: #69. Verified against Claude Code 2.1.301 on Windows (October 2026).

An agent in Claude Code or Copilot CLI links its own session to the task it works on. The board then shows
whether that session is still running and offers **Open in terminal**, which resumes it in a new terminal
window in the session's folder, with **Copy resume command** as a fallback. T3 Code threads already link
back to their conversation ([agent hand-off](agent-handoff.md)); this does the same for sessions run in a
terminal, and gives a session inside T3 Code a way out to one.

## How it works

### Linking a session

The agent calls `link(task, agentSession: {harness, sessionId, cwd}, label)`. Each harness puts the id in an env
var the agent reads with its shell:

| Harness | `harness` | Id from | Resume | Fork |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | `$CLAUDE_CODE_SESSION_ID` | `claude --resume <id>` | `claude --resume <id> --fork-session` |
| Copilot CLI | `copilot-cli` | `$COPILOT_AGENT_SESSION_ID` | `copilot --resume=<id>` | none |

The link is an `agent_session` link stored under `agent-session://<harness>/<id>`, so linking the same
session twice returns the first link; a different folder replaces the stored one (logged as `link_updated`),
since Claude Code finds a conversation to resume by its folder. The `label` says what the session does
("Implementing #107", "Planning #107"; see [Names](#names)); linking again with a
different label renames the session (also logged as `link_updated`). The id must be a UUID and the folder an
absolute path, with trailing separators dropped (`AgentSessionRef`). The board links sessions it starts itself, such as Autopilot's headless runs, through
`services.links.add` with the same input; their folder can be a worktree outside the project.

Agents are asked for it in three places: the `link` tool's description and the server instructions, the
hand-off prompt, and `get_task`'s **Missing links**, which asks only when the MCP client is Claude Code or
Copilot CLI (`harnessOfClient` in `apps/server/src/mcp/format.ts`).

### Live status

Every 20 seconds, while a browser is connected and at least one session is linked, the server reads the
harnesses' own files and stores what it finds as the link's snapshot. A changed snapshot reaches browsers
as `task.upserted`, as PR and T3 thread state do. A session's status is also read when it is linked (by an
agent, or by Autopilot as its run starts) and again just before it is opened.

A poll that fails, finds no links or takes longer than 30 seconds (a hung PowerShell, a stalled disk) never
stops the next one. Don't reset the in-flight guard from inside the async function that is being guarded:
with nothing to await, it runs before the guard is assigned and leaves it set for good, which once stopped
polling until the server restarted.

| Status | Shown as | Claude Code | Copilot CLI |
| --- | --- | --- | --- |
| `busy` | Working | a live `sessions/<pid>.json` says `busy` | |
| `idle` | Idle | it says `idle` | |
| `running` | Running | it says something else | a live process holds `session-state/<id>/inuse.<pid>.lock` |
| `not_running` | Not running | no live file for the session | no live lock, or no session folder |
| `unknown` | Status unknown | no `sessions` folder, or a live process's file can't be read | no `session-state` folder |
| `finished` | Finished 5m ago | an Autopilot run's session whose run ended well | |
| `failed` | Failed 5m ago | an Autopilot run's session whose run failed | |

- Claude Code's folder is `$CLAUDE_CONFIG_DIR`, else `~/.claude`; Copilot's is `$COPILOT_HOME`, else
  `~/.copilot`. Neither format is documented, so anything unexpected reads as unknown rather than a guess.
- A pid counts only while `process.kill(pid, 0)` finds it. Claude Code removes its file on a clean exit; after
  a crash the file stays and the pid can be reused. On Windows `procStart` is the process's creation time as a
  FILETIME, compared with `Get-Process`'s start time in one PowerShell call for all pids, cached for five
  minutes per pid. Elsewhere the reuse check is skipped.
- **Autopilot's headless sessions** take their state from the run that made them (`autopilot_runs.session_id`),
  not from the files: `busy` while the run is queued or running, then `finished` or `failed` with `endedAt`,
  the time the run ended. Once it ended, a live process for the session (someone resumed it in a terminal)
  shows its own status instead, so Open in terminal still warns. The runner refreshes the link as it adds it,
  and the engine as the run ends, rather than waiting for the poll. Open in terminal and Fork work on a
  finished or failed session as on a stopped one.
- `inApp` is set when Claude Code's `entrypoint` starts with `sdk` (T3 Code runs it through the Agent SDK).

### Opening a session

**Open in terminal** posts to `/api/links/:id/resume` with a mode (`resume` or `fork`) and `force`. The server
re-reads the link, checks the folder still exists, reads the status afresh, and:

- answers **409** with the snapshot when the session is running and the mode is `resume` without `force`.
  The web app then asks: **Fork** (Claude Code, recommended), **Open anyway**, Cancel, and **Open T3 thread**
  when the session runs inside T3 Code and the task has a thread;
- otherwise starts the terminal and answers `{launched, command, error}`. When the terminal won't start,
  `launched` is false and `command` is what to paste instead; the web app shows it in a toast with **Copy
  command**.

**Copy resume command** (`GET /api/links/:id/resume-command`) gives `cd <folder>` and the resume command,
quoted for the shell the terminal setting opens.

### The terminal

**Settings → Terminal** picks where sessions open (`terminal` setting, machine-only, not in backups):

| Setting | Runs |
| --- | --- |
| Automatic, Windows | Windows Terminal's default profile, else a Command Prompt window |
| Automatic, macOS | Terminal, through `osascript` |
| Automatic, Linux | the first of `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `xterm`, running `bash -c 'cd <folder> && <command>; exec bash'` |
| A Windows Terminal profile | `wt -w 0 new-tab -p <guid> -d <folder> <shell> …` (`-w new` with **Open in: New window**) |
| Command Prompt, Windows PowerShell | a console window through `cmd /c start` |
| Custom command | the template, with `{cwd}` (quoted) and `{command}`, run by cmd on Windows and sh elsewhere. On Windows a folder containing `%` is refused, as cmd would expand it |

**Open in** (`terminalOpenIn`, machine-only; shown on Windows for Automatic and Windows Terminal profiles) is
a new tab in the last window (default) or a new window. `-w 0` is Windows Terminal's most recently used
window, and it starts a window itself when none is open. It doesn't apply to Command Prompt, PowerShell, macOS,
Linux or custom commands.

Windows Terminal's settings are read from the Store, Preview and unpackaged locations, with comments and
trailing commas allowed. A profile's shell comes from its `commandline` (or its `source` for PowerShell 7
and Git Bash), and the command runs inside that shell so the window stays open after the session exits:
bash `-l -i -c '<cmd>; exec bash'`, cmd `/k`, PowerShell `-NoExit -Command`. Windows Terminal splits its own
command line on `;`, quotes or not, so every `;` is passed as `\;`. A profile we can't drive (WSL, Azure
Cloud Shell) keeps its look and runs cmd. The settings page shows what the current setting runs for an
example session.

The rules for starting processes are in [ADR 0009](../decisions/0009-board-starts-local-processes.md).

### Names

A session's name is, in order:

1. the link's **label**: what the agent said it does, or what Autopilot called the run
   ([runners](autopilot.md#runners));
2. the **title Claude Code keeps** for the session, read by the status reader and stored on the snapshot as
   `title`: the live session file's `name` (`<claudeDir>/sessions/<pid>.json`) unless its `nameSource` is
   `derived` (Claude's own guess from the folder and branch), else the transcript's newest `custom-title`
   (a name the session was given: `--name`, `/rename`), else its newest `ai-title` (what Claude wrote after the
   first exchange). The transcript is `<claudeDir>/projects/<folder>/<id>.jsonl`, found by the session's folder
   (`claudeProjectSlug`) or else by looking in every project folder, and only its start and end are read
   (`integrations/claudeSessionTitle.ts`). A transcript is read again only when its size or time changed. Never
   an LLM call; Copilot CLI has no title;
3. nothing: the web shows "Claude Code session in <folder>".

`claudeDir` is `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Neither file format is documented, so a title that can't
be read is left out rather than guessed.

### On the card and in the panel

A card shows each session as a chip with the harness's mark and a status dot; its menu opens, forks or copies
the command. A task with a T3 thread shows no session chips, since the thread runs a Claude session
underneath and would show twice. The task panel lists every session by name, with its folder (secondary) and status, under its Sessions
heading ([board-layout](board-layout.md#the-links-section)); a chip's tooltip shows the name.

Copilot CLI support is unit-tested only.

## Decisions

- **Status from the harness's files, not from the agent.** The agent can't report that it has exited; the
  files and the pid can.
- **One poll for everything, only while someone is watching.** As for T3 threads, the timer does nothing
  without a connected browser.
- **409 rather than a client-side check.** The server reads the status itself just before launching, so a
  stale card can't reopen a running session silently.
- **Launch from the server.** The browser can't start processes, and the desktop app uses the same route, so
  there is one path to test.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| A `claude://` style URL handler | Neither CLI registers one, and it would need installing per machine |
| Reading the transcript files for status (it is read for the title only) | Larger and slower than the running-session files, with no pid to check |
| Focusing a window that already shows the session | No reliable way across terminals |

## Code map

| File | What it does |
| --- | --- |
| `packages/contracts/src/agentSessions.ts` | `AgentSessionRef`, snapshot, `AGENT_HARNESSES` and resume commands, `TerminalSetting`, REST shapes |
| `apps/server/src/integrations/agentSessions.ts` | The status reader, process probe, poller (and the run-based state of Autopilot sessions), resume and terminal info |
| `apps/server/src/integrations/terminal.ts` | Quoting, Windows Terminal detection, the launch for each terminal and shell, spawning |
| `apps/server/src/db/migrations/015_agent_session_links.sql` | Adds the `agent_session` link kind |
| `apps/server/src/http/routes/system.ts` | `/api/links/:id/resume`, `/api/links/:id/resume-command`, `/api/terminal` |
| `apps/server/src/mcp/tools/links.ts` | `link` with `agentSession` |
| `apps/web/src/components/sessions/` | Status and warning copy, the warning dialog, shared menu items, `useSessionActions` |
| `apps/web/src/components/settings/TerminalSection.tsx` | Settings → Terminal |
