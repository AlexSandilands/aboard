# Importing tickets and GitHub issues

Paste a ticket from one of your [ticket systems](using-the-board.md#links) (Jira, Linear or your own) or a GitHub issue
as a new task's title and the board creates the task, then fills in a concise title, a summary and labels for you.

1. Open the command palette (**Ctrl/Cmd K**, or press **N**) and choose **New task…** and a project.
2. Paste a ticket key (`PROJ-123`), a ticket URL or a GitHub issue URL (`https://github.com/owner/repo/issues/45`).
   The description box turns into an **Import** row that says where it reads from, such as "Import PROJ-123 from Jira".
3. Press **Enter**. The task lands in Backlog and its panel opens, showing "Fetching details…" for a few
   seconds.

The ticket or issue stays linked to the task. If the import fails, the card shows a warning, and the panel says why
and has a **Retry** button. The task is usable meanwhile; the failed import only means its title is still the key.

A key or URL is only recognised for a ticket system you have set up: the board knows none itself. No **Import** row
means no system matches it. Set one up under **Settings → Integrations → Ticket systems**, where **Add → From the Jira
preset** (or Linear) fills in a starting point.

## Epics

If the ticket is an epic (as its system's instructions define it), or a GitHub issue has sub-issues, the task becomes an
epic (a band grouping tasks on the board) and each child becomes a task in it, which imports on its own. The epic's panel
shows how many of them have finished. A child that is already a task in the same project (linked to the same ticket)
moves into the epic instead of being created twice; one that is already in another epic stays there, and the epic's notes
say so. A ticket's children must be tickets of its own system; others are skipped, and the notes say so. An epic brings
in at most 50 tasks; its notes say when the ticket has more.

The task stays a task, with a note saying why, if it can't be an epic by the time the import finishes: you gave
it a plan, put it in an epic, flagged it for Autopilot or marked it a priority.

## What you need

- **GitHub issues** need the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`). The board
  summarises the issue with Claude Code; without it, the issue's own title and text are used instead.
- **Tickets** are read through your own MCP server for that system in Claude Code, so you need one connected
  (`claude mcp list` shows it as connected), such as Atlassian's for Jira or Linear's, added for you rather than for one
  project (`claude mcp add --scope user …`). In the system's settings, list the **import tools** the run may call, as
  `mcp__<server>__<tool>`: one that reads a ticket and, to import epics, one that searches. The board allows only those
  and denies tools whose names look like writes (create, update, comment, transition, …) even where your own Claude Code
  settings allow them. That is a check by name, not a sandbox. A system with no import tools can't import: the import
  fails and says to add them.
- The system's **import instructions** tell the run how to read its tickets and how to find an epic's children. The
  presets fill them in; edit them if your tracker differs (a custom field for epics, say).

Both run the Claude Code CLI, the one named under **Settings → Integrations → Claude Code** (it's `claude` from your PATH
unless you set another), on a small model (Haiku by default). The model can be one of your **Model tiers**
instead: set it once there and pick the tier here.

## Settings

**Settings → Tasks → New tasks** (Issue import) has the switch, the model and the most one import may spend. Each ticket
system's import tools and instructions are on the system, under **Settings → Integrations → Ticket systems**. If your own
tools lack a search tool, an epic's children can't be found and it imports as a single task, with a note saying so.

How it works: [docs/features/issue-import.md](../features/issue-import.md).
