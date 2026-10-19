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
     runs. A run that fails leaves no handover, so the one before it is passed on. The editor's **Run history** opens a page that lists
     each run's summary and handover ([Autopilot](autopilot.md#run-history)).

     Under **Allowed tools** you can list tools the agent may use besides the board's own, one per line: a whole MCP
     server (`mcp__issue-tracker`) or a single tool (`mcp__issue-tracker__search_jira`). Nobody is there to approve a call
     when the agent runs, so a tool not listed can't be used, and one that is listed runs without asking. Prefer
     one tool to a whole server. The server has to be your own, added with `claude mcp add --scope user` (or come from
     a plugin or connector); a server that lives in a project's `.mcp.json` needs an approval the agent can't get. An
     agent with extra tools runs headless, so a task's agent can't run in T3 Code only (a scheduled agent is always
     headless). It still can't push to your default
     branch or merge a pull request through git or gh; what a tool of a server you allow can do is up to that
     server.

     On a schedule, an agent can also **check first with a script**, which decides whether it runs at all, and for
     what: [Check scripts](#check-scripts).
   - **Run a command** in the project's folder, with a timeout. The command is never filled in. It reads the task
     from environment variables instead: `ABOARD_TASK_NUMBER`, `ABOARD_TASK_TITLE`, `ABOARD_TASK_ID`,
     `ABOARD_TASK_STATUS`, `ABOARD_PR_URL`, `ABOARD_PROJECT_NAME`, `ABOARD_PROJECT_PATH` and `ABOARD_AUTOMATION`.
     So a task title can't change your command line, even if it contains quotes, `;` or `&`. Commands run in `sh`,
     or in Windows PowerShell on Windows: read a value as `"$ABOARD_TASK_TITLE"` in sh and `$env:ABOARD_TASK_TITLE`
     in PowerShell. (Not cmd.exe: it fills `%VAR%` in before reading the line, so a title could add a command.)
   - **Run a script**: code in Node.js, Python, PowerShell or sh, kept in the automation and run in the project's
     folder, as a command is. See [Scripts](#scripts).

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

## Scripts

A script is a command with room to think: real code, in a language you pick, kept in the automation (never a path
into a repository, so a checked-out branch can't change what runs).

| Language   | Needs                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------- |
| Node.js    | Nothing: it runs on the board's own Node.                                                    |
| Python     | Python 3 on the PATH (`py` on Windows). Run with `-I`, so your Python settings are left out. |
| PowerShell | `pwsh`, or Windows PowerShell on Windows.                                                    |
| sh         | `sh` on the PATH.                                                                            |

If the interpreter is missing, the run fails and says so ("python not found on PATH"). A script runs in the project's
folder, with the same environment variables as a command (the board's own, such as its API token, are left out), and
for the same time limit (300 seconds unless you set another, up to an hour). A non-zero exit or a timeout fails the
run.

**The contract.** What a script gets and gives back is the same for both kinds of script:

- **In**: the values of the run as JSON on **stdin**, so any language reads them without parsing the environment:

  ```json
  {
    "automation": "Review repo PRs",
    "project": { "id": "…", "name": "aboard", "path": "C:/Code/aboard" },
    "inputs": { "trusted_logins": "octocat", "max_rounds": "3" },
    "task": null,
    "pr": null
  }
  ```

  `inputs` holds your [inputs](#inputs-and-required-tools) as text, keyed by name. `task` and `pr` are filled when
  the trigger has them (a schedule has neither). The same values are also in `ABOARD_*` environment variables, which is
  the way to read them in sh. Nothing is ever filled into the script's text: a `{{…}}` that names a placeholder is
  refused when you save, so a task title can't change your code.
- **Out**: the script's **exit code** and what it printed. A script action keeps the end of its output with the run;
  a [check script](#check-scripts) prints its answer on stdout and keeps stderr for you: when a check fails, what it
  wrote there is kept with the run.

The editor has a code editor with a starter for each language, **Load from file**, and a **Test run**. A test run
**really runs** the script, now, in a project you pick, with the real environment: a script that approves a pull
request approves it. The editor asks for a second click that names the project.

## Check scripts

Without a check, a scheduled agent runs once in each project every time its slot comes, even when there is nothing to
do. A **check script** puts a cheap, deterministic test in front of it. Switch on **Check first with a script** on an
agent that runs on a schedule, and the script runs first, in the project's folder, with the context above (no task).

The script prints **one JSON object per line** on stdout, one for each thing an agent should look at:

```
{"key": "acme/shop#41:3f2a9c1:0", "title": "Add retries", "url": "https://github.com/acme/shop/pull/41"}
{"key": "acme/shop#44:9be01d7:0", "title": "Fix the cart", "url": "https://github.com/acme/shop/pull/44"}
```

- `key` is required: a non-empty string, at most 200 characters. Everything else is yours.
- **One agent starts for each item**, with your prompt, filled in with the item: `{{item.title}}`, `{{item.url}}`,
  or any other field (`{{item}}` is the whole line). A field the item doesn't have is left empty. The agent is also
  shown the whole item, marked as data. Each runs headless in its own empty folder, named after its key in the Autopilot
  list and the run history, and counts against the agent caps and quiet hours like any agent.
- **Printing nothing starts nothing.** That is a quiet run: no agent, no cost, and no entry in the history. A check
  that runs every five minutes and finds nothing to do leaves no trace.
- At most 500 items are read, and 50 new ones are started in a pass; the rest wait for the next one.

**The board remembers, your script doesn't have to.** Each item is remembered by its key. A key that already has a run,
whether it is going, done or failed, is never started again. So a script can print everything that is still open every
time, and has no state file of its own to lose: the key decides what is new. Put into the key what makes the item worth a
second look:

- A key of `acme/shop#41` reviews pull request 41 once, ever.
- A key of `acme/shop#41:3f2a9c1`, with the head commit in it, reviews it again after each push.
- Add a count of `/re-review` comments, and a person can ask for another look at the same commit.

A script that prints a key it printed before, in the same run, counts it once.

**When it goes wrong.** A check that exits non-zero, times out, has no interpreter, prints more than the limit, or
prints a line that isn't a JSON object with a key (a stray `Done!` is enough) fails as a whole: no agent starts, and one
failed run is recorded with the error and the end of the script's output. Nothing is flagged on a task, since a
schedule has none: look at the automation's **Run history**. That run also keeps the check from running again until the
next slot (or until you edit the automation), so a broken script doesn't run every minute.

An agent that fails leaves its key marked failed. The board doesn't start that item again by itself, since the point is
that it never repeats work: **retry** the run (`POST /api/autopilot/runs/<id>/retry`), or change what the script puts in
the key. In both cases the board takes the same care as any retry: quiet hours, the caps and the switches still hold.

A check starts only when an agent could: not in quiet hours, nor while the agent caps are full, and at most four
checks and commands run at once. A **dry run** runs the check for real, so it can do whatever your script does, and
records what each agent would have been told instead of starting it.

### Items are untrusted by default

An item usually carries text somebody else wrote: a pull request title, a comment, an issue. A prompt injection in
it would be read by an agent with your access. So **Treat the items as untrusted** is on, and each item's agent runs
read-only, with no tools but the board's own, and those narrowed: they can read the board, add a note and ask you, but
not start, steer or retry other agents, or merge. It can't be combined with allowed tools or tool slots.

Turn it off only when the agent has to reach outside, such as running `gh` to read a diff and post a review, and
everyone who can write the text it reads is someone you trust. The editor warns, and so does the import page.

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
prompt, skill name and allowed tools, any script or check script (in full), the declared inputs with their current values as defaults, and the declared
slots **without** their tools. It leaves out your projects, your epic and the tools you filled the slots with. If the
automation names a skill you have installed, the skill's text goes in the file.

To use someone's file: **Custom automations → Import**, then choose the file (or one of the examples the app ships:
**Dispatch**, **Improve prompts and skills** or **Review repo PRs**). Before anything is saved you see everything it
would run: the prompt, any command, script or check script (with its language), the tools it may use without asking and
the skill's text. Treat it as code from a stranger, because once you switch it on it runs on
your machine with your access. Then fill in its inputs and slots, optionally restrict it to projects, and import.
It comes in **off**; switch it on in the Autopilot list when you have read it and the orange warning is gone.

- A file with a script needs one more step: a switch that says you've read the script and understand it runs on your
  machine as you. **Import** waits for it.
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

### Review repo PRs

The third example is a pull request reviewer built on a [check script](#check-scripts), for the repository of each
project it's on in. It also covers pull requests that aren't linked to a task, which the built-in **Review PRs** can't
see. It needs the GitHub CLI (`gh`), signed in as the account that should post the reviews.

Every five minutes a Node script asks GitHub for the project's open pull requests and prints each one that has no
review of this kind **at its head commit** (every review carries the commit it was made at, so GitHub is the memory,
not a file). The board starts one agent for each. It reads the pull request with `gh` and posts one review as a
**comment**, under the same header Review PRs uses. It never approves or requests changes: there is no such code in the
script, and the agent is told not to.

It reviews only pull requests from people who can be trusted with your access: the repository's owners, members and
collaborators, your own account and the **Trusted GitHub logins**. A stranger's pull request is left alone, since its
text would go to an agent that runs `gh` as you; turn on **Also review PRs from people with no write access** to
include them. To keep the first run from reviewing every old open pull request, it only looks at those updated in the
last **Only PRs updated in the last (days)** (7 by default). The board starts at most 50 new agents in a pass and
keeps to the agent caps, so the rest follow.

The script leaves a pull request alone when it is a draft or has a `no-autopilot` label. In the comments it reads two
commands, only at the start of a line, and only from the people who may give each one, never from anyone else:

- `/stop-review` stops the reviews. It counts from the **pull request's author**, the account running `gh` or a login
  in Trusted GitHub logins. The latest command wins, so a later `/re-review` starts them again.
- `/re-review` asks for another review of the same commit. It counts only from the **account running `gh` or a trusted
  login**, not from the pull request's author, because each request starts an agent. The number of `/re-review`
  comments is in the key (`owner/repo#41:3f2a9c1:1`) beside the head commit, so a push and a request each make a new
  item.

Only reviews posted by your own account count, so pasting the header into a review can't keep a pull request out. It
reviews each pull request at most **Most automatic reviews per PR** times (3 by default); a `/re-review` goes past
that, since someone you trust asked.

It looks at the 50 most recently updated open pull requests, and at the last 100 comments and reviews of each; a
repository with more has the rest left out, and the script says so on stderr, which a test run shows.

To use it: **Import → Example: Review repo PRs**, read the script, enter your trusted logins if any, pick the
projects, and switch it on. It comes in with **Treat the items as untrusted** off, because the agent has to run `gh` to
read the pull request and post its review, which an agent of untrusted items can't. A pull request's title, description,
comments and code are text its author wrote, and the agent reads them with your access: that is why outside
contributors are off by default, and why you should only turn them on for repositories where a stranger's text is
acceptable to it. If **Review PRs** is on for the same project, this example skips a pull request that Review PRs
already reviewed at its head commit (it sees the review on GitHub), but Review PRs doesn't see this one's reviews, so
a pull request linked to a task can get a second review from it. Switch one of them off for a project to avoid that.

## Commands and scripts run on your machine

A command or script runs as you, in sh (Windows PowerShell on Windows) or its language's interpreter, whenever its
trigger fires in a project it's on in. The board's own environment variables, such as its API token, are left out of its
environment. There is no MCP tool for custom automations, and the API only takes a command, a script or a check from
the board's settings page (a request without the page's Origin is refused). That keeps agents from setting one up by
accident; it isn't a lock, since anything that can run commands on your machine already can.

A script can do anything you can. Three things to think about before you switch one on:

- **Who can make it act.** A script that reads text from outside, such as a pull request's comments, must check **who
  wrote it** before acting on it. A comment saying `/re-review` or `/lgtm` is a command only when its author is someone
  you trust: your own account or a login on a list you keep (the example's **Trusted GitHub logins** input), and for a
  command that only holds back work, such as `/stop-review`, the pull request's author. Never "anyone who can comment",
  which in a public repository is anyone.
- **Approving as you.** A script that runs `gh pr review --approve` approves as your GitHub account, and your team reads
  your name on an approval as your judgement. Keep the decision rule-based and narrow (a trusted login, a label, a
  green check), keep it off until you've read what the script does, and don't let an agent's opinion trigger it. The
  example above never approves.
- **What an agent reads.** An agent started for an item reads that item's text. Leave **Treat the items as untrusted**
  on unless the agent has to reach outside, and then only for text from people you trust
  ([above](#items-are-untrusted-by-default)).

A script you imported is someone else's code: read it on the import page before you switch it on.

Custom automations are part of the board's [backup](../features/backup.md). Agents can't see or change them.
