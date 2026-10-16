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

## What you need

- **GitHub issues** need the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`). The board
  summarises the issue with Claude Code; without it, the issue's own title and text are used instead.
- **Jira issues** are read through your own Jira MCP server in Claude Code, so you need one connected
  (`claude mcp list` shows it as connected), such as Atlassian's, added for you rather than for one project
  (`claude mcp add --scope user …`). The board only lets the run read: it denies tools whose names look like
  writes (create, update, comment, transition, …), even where your own Claude Code settings allow them.

Both run the Claude Code CLI, the one named under **Settings → Local review** (it's `claude` from your PATH
unless you set another), on a small model (Haiku by default).

## Settings

**Settings → Issue import** has the switch, the model, the most one import may spend, and the Jira tools it
may call. By default the board looks for the common one-issue read tools (`get_jira_issue`, `getJiraIssue`,
`jira_get_issue`) on every connected MCP server. If your Jira server names its read tool differently, list
it there as `mcp__<server>__<tool>`.

How it works: [docs/features/issue-import.md](../features/issue-import.md).
