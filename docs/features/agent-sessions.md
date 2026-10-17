# Agent sessions

Board tasks: #69, #115 (starting sessions). Verified against Claude Code 2.1.301 and Copilot CLI 1.0.85 on Windows
(October 2026).

An agent in Claude Code or Copilot CLI links its own session to the task it works on, or the board starts the
session itself from the hand-off menu and links it ([Starting a session](#starting-a-session)). The board then shows
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
("Implementing #107", "Planning #107", "Orchestrating #107" for an epic; see [Names](#names)); linking again with a
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

- for a running session the board started in a named Windows Terminal window (the link's `window`), while the
  terminal setting is still Windows Terminal, runs `wt -w <window> focus-tab -t 0` and answers
  `{launched: true, focused: true}`: the window comes back to the front on its first tab. If that can't start, or
  the terminal is another one, it is treated like any running session:
- answers **409** with the snapshot when the session is running and the mode is `resume` without `force`.
  The web app then asks: **Fork** (Claude Code, recommended), **Open anyway**, Cancel, and **Open T3 thread**
  when the session runs inside T3 Code and the task has a thread;
- otherwise starts the terminal and answers `{launched, command, error}`. When the terminal won't start,
  `launched` is false and `command` is what to paste instead; the web app shows it in a toast with **Copy
  command**.

**Copy resume command** (`GET /api/links/:id/resume-command`) gives `cd <folder>` and the resume command,
quoted for the shell the terminal setting opens.

### The terminal

**Settings → Integrations → Terminal** picks where sessions open (`terminal` setting, machine-only, not in backups):

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

The rules for starting processes are in [ADR 0009](../decisions/0009-board-starts-local-processes.md) and, for new
sessions, [ADR 0010](../decisions/0010-board-starts-new-sessions.md).

### Starting a session

The hand-off menu on a card and in the panel offers **New Claude Code session…** and **New Copilot CLI session…**
on any open task, and on an epic (finished ones too), for each CLI `GET /api/agent-clis` finds: the path in Settings (the Claude Code CLI
path the reviewer uses, or **Copilot CLI path**), else the name on PATH. The dialog (`SessionLaunchDialog`) reads
`GET /api/tasks/:id/session-launch-options` (CLIs, the project folder, its branches and default branch, each CLI's
model for the task's tier, and whether sessions get a named window) and offers:

- the hand-off prompt, editable, with **Plan with me** swapping the work and planning prompts. It is the prompt
  with `linkedSession`: the agent is told the board linked the session and has no suggested-model line. An epic's
  is the orchestrating prompt (mode `orchestrate`, session label "Orchestrating #N") with no **Plan with me**, and
  the server refuses a mode that doesn't fit the task (`handoffModeError`);
- a model, filled in from **Session models** (`modelTiers[tier].cli[harness]`) for a work prompt; blank, and
  planning, use the CLI's default. Model names are `CliModel`: letters, digits and `. : @ / [ ] -`;
- **New worktree** from a branch, or **This checkout**. (A fix from a PR's **Fix in →** has neither choice: it runs in a
  new worktree on the PR's own branch, below.) The branch starts on the task's integration branch when its
  epic delivers through one (origin's copy first, as the T3 dialog does), else origin's copy of the default branch
  (the local one when origin has none), as Autopilot's worktrees start from it.

`POST /api/tasks/:id/sessions` then:

1. for a new worktree, runs `createWorktree` under `<worktreesDir>/sessions` on a new `<brand>/<task#>-<id8>` branch.
   Autopilot's cleanup never removes these: they are the user's;
2. builds `claude [--model m] --session-id <uuid> --name "Implementing #N" -- <prompt>` (`--` so a prompt starting
   with `-` isn't read as an option), or Copilot's
   `copilot [--model m] --session-id <uuid> --name … -i <prompt>`, with a session id the board picks;
3. opens it in the terminal setting's terminal. With Windows Terminal it goes to the window named for the task
   (`taskWindowName`, `<brand>-<task#>`): `wt -w <brand>-115 new-tab …` opens the window, or a tab of it when it is
   already open, whatever **Open in** says;
4. links the session (label "Implementing #N", "Planning #N" or, for an epic, "Orchestrating #N", plus the window once the terminal has started), then
   reads its status. When the terminal won't start the result carries the command to run by hand; the session is
   linked all the same, since that command has its id and its prompt says the board linked it.

The prompt is one argument (`textArgument` in `terminal.ts`). POSIX shells get it as written, single-quoted. On
Windows it crosses Windows Terminal, which quotes an argument with spaces but not the quotes inside it, and often
cmd.exe, which has no escape inside quotes and expands `%NAME%` even there; so line breaks become spaces, `"`
becomes `'`, a trailing backslash gets a space after it, the text always has a space, and a `%` is refused. A
refused prompt, or a command line over 8,000 characters on Windows, starts the session with a short prompt built
from the task alone ("Let's work on #N…: call get_task(…) first"); the result says why (`shortReason`) and the web
app copies the full prompt to the clipboard. These argvs were run for real through cmd, Windows PowerShell 5.1 and a
custom cmd template, and the CLI received the prompt unchanged. A Windows Terminal launch couldn't be run from the
agent's session that built this; it relies on the same quoting the resume command's `bash -c` script does.

The window name is stored beside the session's ref in `ref_json` and returned as the link's `window`. Only the board
sets it (`AddLinkOptions`, `links.setWindow`); an agent linking the same session again, from another folder, keeps
it. **Open in terminal** resumes such a session into its window again, so the window keeps holding it; resumed in a
terminal with no named windows (the setting changed), the link forgets the window. A fork is a new session and opens
where the setting says. Bringing the window back shows its first tab: Windows Terminal can't focus a tab by what runs
in it, so with several sessions in the window the one asked for may be on another tab.

**Fixing a PR.** `workspace: {mode: "pr_branch", branch}` with `mode: "fix"` is **Fix in →** on a PR link
([GitHub PRs](github-prs.md#fixing-a-pr-by-hand)). The server refuses a branch that isn't the head of an open or draft PR of
the task (not from a fork, and, when `origin`'s URL names a repository, in that repository: `remoteRepo`); then `createWorktree` is given `branch` instead of `baseRef`, which makes a new local
`<brand>/<task#>-<id8>` branch at origin's copy of the PR's branch that tracks nothing, and refuses the default branch
(the prompt tells the agent to push with `git push origin HEAD:<branch>`). The session is labelled "Fixing the PR of #N"
(`sessionLabel`), and the short prompt (`shortPrompt`) names the branch and repeats the safety rules.

The terminal setting is resolved first, so one that can't run here is refused (400) before any worktree is made. A
worktree made for a session whose terminal then didn't start stays, since the returned command runs in it, and the
dialog closes so starting again doesn't quietly make a second one.

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
underneath and would show twice. The task panel lists every session by name, with its folder (secondary) and status, in the panel's
Sessions section ([board-layout](board-layout.md#the-sessions-section)); a chip's tooltip shows the name.

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
| Focusing a window that already shows any session | No reliable way across terminals; only a Windows Terminal window the board named can be found again |
| Writing the prompt to a file for the session to read | Neither CLI takes a first prompt from a file, and a pointer prompt reads worse than the prompt itself |

## Code map

| File | What it does |
| --- | --- |
| `packages/contracts/src/agentSessions.ts` | `AgentSessionRef`, snapshot, `AGENT_HARNESSES` and resume commands, `TerminalSetting`, REST shapes |
| `apps/server/src/integrations/agentSessions.ts` | The status reader, process probe, poller (and the run-based state of Autopilot sessions), resume and terminal info |
| `apps/server/src/integrations/terminal.ts` | Quoting (and `textArgument` for free text), Windows Terminal detection, the launch for each terminal and shell, named windows, spawning |
| `packages/contracts/src/sessionLaunch.ts` | `CliModel`, launch options and input, `newSessionArgv`, `taskWindowName`, `sessionLabel` |
| `apps/server/src/integrations/sessionLaunch.ts` | Which CLIs are installed, the launch options, starting and linking a session |
| `apps/server/src/db/migrations/015_agent_session_links.sql` | Adds the `agent_session` link kind |
| `apps/server/src/http/routes/system.ts` | `/api/links/:id/resume`, `/api/links/:id/resume-command`, `/api/terminal`, `/api/agent-clis` |
| `apps/server/src/http/routes/tasks.ts` | `/api/tasks/:id/session-launch-options`, `/api/tasks/:id/sessions` |
| `apps/server/src/mcp/tools/links.ts` | `link` with `agentSession` |
| `apps/web/src/components/sessions/` | Status and warning copy, the warning dialog, shared menu items, `useSessionActions` |
| `apps/web/src/components/handoff/SessionLaunchDialog.tsx` | The new-session dialog (`sessionLaunch.logic.ts`) |
| `apps/web/src/components/settings/TerminalSection.tsx` | Settings → Integrations → Terminal |
