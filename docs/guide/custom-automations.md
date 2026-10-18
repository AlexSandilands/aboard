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
   - **On a schedule**: weekdays at a time, or every N minutes (5 to 1440) or hours (1 to 24) from midnight
     (local time), so every 15 minutes runs at 00:00, 00:15, 00:30 and so on. It runs once in each project it's on
     in, with no task, so it can only filter by project. If the board was off, it runs once when it's back, not
     once for each slot it missed.
2. **Only in these projects**, **with any of these labels**, **in the epic**: narrow it down. Leave them empty
   for every task.
3. **Do**: one of these.
   - **Start an agent** on the task, with your prompt. The prompt can name `{{task.number}}`, `{{task.title}}`,
     `{{task.id}}`, `{{task.status}}`, `{{pr.url}}`, `{{project.name}}`, `{{project.path}}` and
     `{{automation.name}}`; the task's title, labels, PR and description are added after it. Optionally name a
     skill the agent should use, a model tier, and whether to work on the task's pull request branch. The runner,
     budget and timeout are the automation's settings in the Autopilot list, like any agent automation's
     ([Autopilot](autopilot.md#runners)). On a schedule the agent has no task: it runs headless in an empty
     temporary folder, not the project's own, and is told the project's name and folder (and not to edit the folder, which is only a request: nothing stops it); it can use the board's
     tools to find its work, with the same edit access as any Autopilot agent (it is told not to push to the default
     branch or merge). It always runs headless, whatever the runner setting says, and can't work on a pull request's
     branch. A new run waits until the last one for the project has finished, then the latest slot runs once.
     Each scheduled run ends with a short **handover**: a note of what the next run needs to know, such as items it is
     holding or waiting on, what it triggered, and what it already triaged or skipped. The next run of the same
     automation in the same project is given it (cut off at 4,000 characters), so the agent remembers between
     runs. A run that fails leaves no handover, so the one before it is passed on. The editor's Recent runs lists each
     run's summary and handover.

     Under **Allowed tools** you can list tools the agent may use besides the board's own, one per line: a whole MCP
     server (`mcp__issue-tracker`) or a single tool (`mcp__issue-tracker__search_jira`). Nobody is there to approve a call
     when the agent runs, so a tool not listed can't be used, and one that is listed runs without asking. Prefer
     one tool to a whole server. The server has to be your own, added with `claude mcp add --scope user` (or come from
     a plugin or connector); a server that lives in a project's `.mcp.json` needs an approval the agent can't get. An
     agent with extra tools runs headless, so a task's agent can't run in T3 Code only (a scheduled agent is always
     headless). It still can't push to your default
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

## Inputs and required tools

An agent action can declare **Inputs** and **Required tools**, so one prompt works for whoever uses it.

- An **input** is a named value (text, a number or yes / no) that the prompt reads as `{{inputs.name}}`: a JQL query,
  a look-back in days, whether to ask for approval. Each has a label and a value. Change the value in the editor
  instead of the prompt.
- A **required tool** is a slot for a kind of tool the automation needs but can't name, since people use different MCP
  servers: "Jira tools", say, for searching issues. You fill the slot with tools of your own servers, one per line, as
  for **Allowed tools**. They are allowed to the agent like any allowed tool, and the prompt is told which tools
  fill each slot.

While a slot is empty the automation is marked **Won't work until you fill in: Jira tools** in orange, and its **On**
button is disabled. If you empty a slot of one that is already on, it stops starting agents until it is filled.

## Sharing one

On a custom automation's row, **Export** downloads a file (`dispatch.automation.json`). It holds the trigger,
prompt, skill name and allowed tools, the declared inputs with their current values as defaults, and the declared
slots **without** their tools. It leaves out your projects, your epic and the tools you filled the slots with. If the
automation names a skill you have installed, the skill's text goes in the file.

To use someone's file: **Custom automations → Import**, then choose the file (or one of the examples the app ships:
**Dispatch** or **Improve prompts and skills**). Before anything is saved you see everything it would run: the prompt, any command, the tools it may use
without asking and the skill's text. Treat it as code from a stranger, because once you switch it on it runs on
your machine with your access. Then fill in its inputs and slots, optionally restrict it to projects, and import.
It comes in **off**; switch it on in the Autopilot list when you have read it and the orange warning is gone.

- A skill in the file is written to `~/.claude/skills` only if you switch **Save the skill** on. One that already
  exists is never overwritten: a name you use is kept apart (`triage-2`) and the automation names the new one.
- Export tells you when a skill went into the file. Only its `SKILL.md` travels, not scripts or other files beside
  it, so check the skill for anything private first.
- An automation name you already use gets a number: `Dispatch (2)`.
- A file made by a newer version of the app is refused, saying so.

### Dispatch

Dispatch is the first example that ships. Every hour it searches Jira (with your **Jira tools** slot) for recent defects
that match its JQL, skips keys already on the board (a task linking the key) or in its handover, adds the ones that
look fixable by an agent to the board with a plan, and then either asks you to approve each plan or, if you turned
**Require a human to approve plans first** off, flags the task so Autopilot starts it. It never merges: you review the
pull requests. Fill the Jira slot with tools such as `mcp__issue-tracker__search_jira` and
`mcp__issue-tracker__get_jira_issue`, check the JQL and the limits, pick the projects, switch **Start planned tasks** on
if it should start work, and switch Dispatch on.

### Improve prompts and skills

The second example audits how agents did and suggests changes to the text they run with. Every Monday at 07:00 it
reads what happened in the project over the past week (`board_activity`: review rounds and findings, failed or
retried Autopilot runs, blocked steps, stalls, agents' notes), looks closer at the few tasks that went worst (their
session transcripts only when the notes don't say why), and suggests at most a few rewrites of your review and
planning skills, your custom automations' prompts and the skills they name. You decide each one under
**Settings → Tasks → Suggestions** ([Suggested changes](settings.md#suggested-changes)); it never edits anything
itself.

It comes with its own skill, `aboard-improve`, which keeps the suggestions few and lean:

- each one cites the tasks that show the problem, at least two or one that cost a failed run or a blocked task;
- it rewrites or deletes the sentence that caused the problem rather than adding one, and a suggestion that makes
  the text longer says why in its first line;
- one behaviour per suggestion, no generic advice ("be careful"), the target's own wording and layout kept;
- with weak evidence it suggests nothing, which is a good week.

Its handover remembers what it suggested, so the next run sees whether you accepted it and whether the problem went
away. `get_editable_prompt` shows each prompt's recent suggestions and what you decided, so it never suggests again
what you rejected. Text the board itself ships (its tool descriptions) can't be suggested to; if one of your
projects is the board's own code, it adds a backlog task there instead.

To use it: **Import → Example: Improve prompts and skills**, switch **Save the skill** on (without the skill it
suggests nothing), and check the inputs: **Look back (whole days)** (7), **Most suggestions per run** (3) and **May
suggest changes to** (`skills`, `prompts` or `all`). Switch it on in the projects to audit. It runs on the deep model
tier, once per project it's on in. A run that finds another project's run already left a suggestion open for the
same skill or prompt leaves it alone; two runs at the same moment can still both suggest, and the later one replaces
the earlier (it stays in the history).

## Commands run on your machine

A command runs as you, in sh (Windows PowerShell on Windows), whenever its trigger fires in a project
it's on in. The board's own environment variables, such as its API token, are left out of its environment.
There is no MCP tool for custom automations, and the API only takes a command from the board's settings page (a
request without the page's Origin is refused). That keeps agents from setting one up by accident; it isn't a lock,
since anything that can run commands on your machine already can.

Custom automations are part of the board's [backup](../features/backup.md). Agents can't see or change them.
