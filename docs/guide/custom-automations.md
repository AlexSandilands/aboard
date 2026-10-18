# Custom automations

A custom automation is an Autopilot automation you define yourself: say what to watch for, and what to do. It
sits in the Autopilot list next to the built-in ones, with the same **Inherit / On / Off** switches per project,
and keeps to the same pause, dry run, caps and quiet hours.

## Setting one up

**Settings → Autopilot → Custom automations → New automation.**

1. **When**: pick a trigger.
   - **A task changes column**: into a column, and optionally only from one (Done → In Progress catches reopened
     tasks).
   - **Something happens on a pull request** linked to the task: it's linked, gets new commits, its checks fail,
     it has a merge conflict, or it's merged. Needs the GitHub poller, which fills in the PR's state.
   - **A task sits in a column too long**: N hours in In Progress, say. Once per stay in the column.
   - **A task's last blocker finishes**.
   - **On a schedule**: weekdays at a time, or every N hours from midnight (local time). It runs once in each
     project it's on in, with no task, so it can only run a command.
2. **Only in these projects**, **with any of these labels**, **in the epic**: narrow it down. Leave them empty
   for every task.
3. **Do**: one of these.
   - **Start an agent** on the task, with your prompt. The prompt can name `{{task.number}}`, `{{task.title}}`,
     `{{task.id}}`, `{{task.status}}`, `{{pr.url}}`, `{{project.name}}`, `{{project.path}}` and
     `{{automation.name}}`; the task's title, labels, PR and description are added after it. Optionally name a
     skill the agent should use, a model tier, and whether to work on the task's pull request branch. The runner,
     budget and timeout are the automation's settings in the Autopilot list, like any agent automation's
     ([Autopilot](autopilot.md#runners)).

     Under **Allowed tools** you can list tools the agent may use besides the board's own, one per line: a whole MCP
     server (`mcp__issue-tracker`) or a single tool (`mcp__issue-tracker__search_jira`). Nobody is there to approve a call
     when the agent runs, so a tool not listed can't be used, and one that is listed runs without asking. Prefer
     one tool to a whole server. The server has to be your own, added with `claude mcp add --scope user` (or come from
     a plugin or connector); a server that lives in a project's `.mcp.json` needs an approval the agent can't get. An
     agent with extra tools runs headless, so it can't run in T3 Code only. It still can't push to your default
     branch or merge a pull request through git or gh; what a tool of a server you allow can do is up to that
     server.
   - **Run a command** in the project's folder, with a timeout. The command is never filled in. It reads the task
     from environment variables instead: `ABOARD_TASK_NUMBER`, `ABOARD_TASK_TITLE`, `ABOARD_TASK_ID`,
     `ABOARD_TASK_STATUS`, `ABOARD_PR_URL`, `ABOARD_PROJECT_NAME`, `ABOARD_PROJECT_PATH` and `ABOARD_AUTOMATION`.
     So a task title can't change your command line, even if it contains quotes, `;` or `&`. Commands run in `sh`,
     or in Windows PowerShell on Windows: read a value as `"$ABOARD_TASK_TITLE"` in sh and `$env:ABOARD_TASK_TITLE`
     in PowerShell. (Not cmd.exe: it fills `%VAR%` in before reading the line, so a title could add a command.)

     **On Windows, don't pass a value as an argument to another program.** Windows PowerShell doesn't escape quotes
     inside the arguments it passes, so a title with `"` in it can add arguments, and a `.cmd` or `.bat` program
     (`npm`, `pnpm`, `npx` and `yarn` are) hands them to cmd.exe, where `&` runs a command:
     `pnpm run notify "$env:ABOARD_TASK_TITLE"` is unsafe. Have the program read the variable itself instead:
     `pnpm run notify`, with `process.env.ABOARD_TASK_TITLE` in the script. Using a value inside PowerShell
     (`Write-Output`, `-match`, a `.ps1` script) is fine.
4. The **Preview** shows exactly what would run for the newest task the filters let through: the filled prompt,
   or the command with its variables.
5. Save it, then switch it **On** in the Autopilot list (for the board) or in a project's Autopilot settings, or
   from the Autopilot pill on a lane. Like every automation, it is off until you switch it on.

## What it does

- It only acts on what happens **after** it is switched on: tasks already in Review when you make a "moves into
  Review" automation are left alone. Changing its trigger or filters starts it from that moment; switching it on in
  a project, or lifting **Pause all**, starts it from that moment in those projects. A stale-task trigger is the
  exception: a task that was already stuck counts.
- Pull request triggers go by when the board saw the change happen: **new commits** means commits pushed after the
  PR was linked, **checks fail** fires each time they go from passing to failing (not again on every push while they
  stay red), and a PR that was already merged, failing or in conflict when it was linked doesn't count. A comment on
  a long-merged PR doesn't count as a merge either.
- Each thing it acts on is done once: a task moving into Review twice gets two runs, but the same move never
  gets a second one, even if the first failed.
- An agent action waits out quiet hours and counts against the agent caps. A command doesn't, but at most four
  commands run at once; the rest start as those finish.
- A command that exits non-zero, or runs past its timeout (it's stopped), fails its run and puts the task under
  Needs attention. The run keeps the exit code and the end of its output, shown in the task panel's **Autopilot**
  section under **Output**.
- With **dry run** on, each run records what it would have run, under **What it would run**, and does nothing.

## Commands run on your machine

A command runs as you, in sh (Windows PowerShell on Windows), whenever its trigger fires in a project
it's on in. The board's own environment variables, such as its API token, are left out of its environment.
There is no MCP tool for custom automations, and the API only takes a command from the board's settings page (a
request without the page's Origin is refused). That keeps agents from setting one up by accident; it isn't a lock,
since anything that can run commands on your machine already can.

Custom automations are part of the board's [backup](../features/backup.md). Agents can't see or change them.
