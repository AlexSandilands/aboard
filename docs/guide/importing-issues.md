# Importing Jira and GitHub issues

Paste a Jira issue or a GitHub issue as a new task's title and the board creates the task, then fills in a
concise title, a summary and labels for you.

1. Open the command palette (**Ctrl/Cmd K**, or press **N**) and choose **New task…** and a project.
2. Paste a Jira key (`PROJ-123`), a Jira URL (`https://…/browse/PROJ-123`) or a GitHub issue URL
   (`https://github.com/owner/repo/issues/45`). The description box turns into an **Import** row.
3. Press **Enter**. The task lands in Backlog and its panel opens, showing "Fetching details…" for a few
   seconds.

The issue stays linked to the task. If the import fails, the card shows a warning, and the panel says why
and has a **Retry** button. The task is usable meanwhile; the failed import only means its title is still the
issue key.

## Epics

If the issue is a Jira epic, or a GitHub issue with sub-issues, the task becomes an epic (a band grouping tasks on the board) and each
child issue becomes a task in it, which imports on its own. The epic's panel shows how many of them have
finished. A child that is already a task in the same project (linked to the same issue) moves into the epic
instead of being created twice; one that is already in another epic stays there, and the epic's notes say so.
An epic brings in at most 50 tasks; its notes say when the issue has more.

The task stays a task, with a note saying why, if it can't be an epic by the time the import finishes: you gave
it a plan, put it in an epic, flagged it for Autopilot or marked it a priority.

## What you need

- **GitHub issues** need the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`). The board
  summarises the issue with Claude Code; without it, the issue's own title and text are used instead.
- **Jira issues** are read through your own Jira MCP server in Claude Code, so you need one connected
  (`claude mcp list` shows it as connected), such as Atlassian's, added for you rather than for one project
  (`claude mcp add --scope user …`). The board allows only the read tools for the run and denies tools whose names
  look like writes (create, update, comment, transition, …) even where your own Claude Code settings allow
  them. That is a check by name, not a sandbox.

Both run the Claude Code CLI, the one named under **Settings → Integrations → Claude Code** (it's `claude` from your PATH
unless you set another), on a small model (Haiku by default).

## Settings

**Settings → Tasks → New tasks** (Issue import) has the switch, the model, the most one import may spend, and the Jira tools it
may call. By default the board looks for the common read tools on every connected MCP server: one issue
(`get_jira_issue`, `getJiraIssue`, `jira_get_issue`) and a JQL search (`search_jira`,
`searchJiraIssuesUsingJql`, `jira_search`), which finds an epic's children. If your Jira server names them
differently, list them there as `mcp__<server>__<tool>`. If you list your own tools, include a search tool:
without one, an epic's children can't be found and it imports as a single task, with a note saying so.

How it works: [docs/features/issue-import.md](../features/issue-import.md).
