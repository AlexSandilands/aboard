# Custom automations

A custom automation is an Autopilot automation you define yourself: say what to watch for, and what to do. It
sits in the Autopilot list next to the built-in ones, under **Yours**, with the same **Off / Preview / On** switches
(and **Inherit** per project), and keeps to the same pause, caps and quiet hours. Click it in the list to see what it
does in one sentence, switch it on or off, **Edit** it, **Export** it or **Delete** it.

## Setting one up

**Settings → Autopilot → + Add automation → Start from scratch**. The same dialog has **Recipes** (small ready-made
automations that open for you to read and import, in Preview), **Import a file** and **Ask an agent**.

The builder takes it in five steps: **When → Do → Details → Where → Review & try**. Each step shows only what the
trigger and action you picked need, and a sentence above it says what the automation does so far ("When a task moves
into Review, ask an agent: “…” It runs in every project it's switched on in."). **Back**, or a step you've already
reached in the row at the top, takes you back without losing anything you typed. **Next** checks the step first and
says what to fix.

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
2. **Do**: one of these, then its **Details** on the next step: the prompt, the command or the script, up front.
   The rest sits under **More options**, closed unless something in it is set: for an agent the model, skill,
   allowed tools, inputs, required tools, and the pull request branch (or, on a schedule, the check script); for a
   command or script its inputs.
   - **Start an agent** on the task, with your prompt. The prompt can name `{{task.number}}`, `{{task.title}}`,
     `{{task.id}}`, `{{task.status}}`, `{{pr.url}}`, `{{project.name}}`, `{{project.path}}`,
     `{{project.repo_url}}`, `{{automation.name}}`, your [variables](#variables) as `{{vars.name}}` and
     [inputs](#inputs-and-required-tools) as `{{inputs.name}}`; the task's title, labels, PR and description are added after it. Optionally name a
     skill the agent should use, a model (inherit, a tier, a custom model or any provider's model), and whether to work on the task's pull request branch. The runner,
     budget and timeout are the automation's settings under **Advanced** in the Autopilot list, like any agent automation's
     ([Autopilot](autopilot.md#runners)). On a schedule the agent has no task: it runs headless in an empty
     temporary folder, not the project's own, and is told the project's name and folder (and not to edit the folder, which is only a request: nothing stops it); it can use the board's
     tools to find its work, with the same edit access as any Autopilot agent (it is told not to push to the default
     branch or merge). It always runs headless, whatever the runner setting says, and can't work on a pull request's
     branch. A new run waits until the last one for the project has finished, then the latest slot runs once.
     Each scheduled run ends with a short **handover**: a note of what the next run needs to know, such as items it is
     holding or waiting on, what it triggered, and what it already triaged or skipped. The next run of the same
     automation in the same project is given it (cut off at 4,000 characters), so the agent remembers between
     runs. A run that fails leaves no handover, so the one before it is passed on. The editor's **Run history** (or **All runs** on the automation) opens a page that lists
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
     `ABOARD_TASK_STATUS`, `ABOARD_PR_URL`, `ABOARD_PROJECT_NAME`, `ABOARD_PROJECT_PATH`, `ABOARD_PROJECT_REPO_URL` and `ABOARD_AUTOMATION`, plus
     `ABOARD_VAR_<NAME>` for each variable and `ABOARD_INPUT_<NAME>` for each input.
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
3. **Where**: **only in these projects**, **with any of these labels**, **in the epic**. Leave them empty for every
   task in every project it's switched on in.
4. **Review & try**: the sentence, each step in one line with an **Edit** that goes back to it, and:
   - **Right now this would run for**: for "sits too long", the tasks already past the limit (it would act on each
     once switched on); for an event, nothing yet, since it only acts on what happens after it's on; for a schedule,
     the projects it would run in.
   - **Try it**: **Show the prompt** shows exactly what an agent would be sent for the newest task the filters let
     through; a command shows what it would run; a script or check script has its **Test run** here.
   - **Name**, filled in from what you picked ("PR checks fail → agent"); change it if you like.
5. **Save in Preview**, or **Save and turn on**. In [Preview](autopilot.md#trying-one-out-with-preview) it records
   what it would do, and does none of it. Once its Preview runs look right, turn it **On** on its page (**Turn on**, or
   its Mode), in a project's Autopilot settings, or from the Autopilot pill on a lane.

**Edit** on an automation opens the same steps at **Review & try**, every step reachable, with **Save changes** at the
bottom of each.

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
- In **Preview** (its own, or Preview everything), each run records what it would have run, under **What it would
  run**, and does nothing.

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
    "automation": "Triage bug reports",
    "project": {
      "id": "…",
      "name": "aboard",
      "path": "C:/Code/aboard",
      "repoUrl": "https://github.com/acme/aboard"
    },
    "inputs": { "trusted_logins": "octocat", "max_rounds": "3" },
    "vars": { "jira_key": "PROJ" },
    "task": null,
    "pr": null
  }
  ```

  `inputs` holds your [inputs](#inputs-and-required-tools) as text, keyed by name, and `vars` the project's
  [variables](#variables). `repoUrl` is the repository the project folder's `origin` points at (empty without one).
  `task` and `pr` are filled when
  the trigger has them (a schedule has neither). The same values are also in `ABOARD_*` environment variables, which is
  the way to read them in sh. Nothing is ever filled into the script's text: a `{{…}}` that names a placeholder is
  refused when you save, so a task title can't change your code.
- **Out**: the script's **exit code** and what it printed. A script action keeps the end of its output with the run;
  a [check script](#check-scripts) prints its answer on stdout and keeps stderr for you: when a check fails, what it
  wrote there is kept with the run.

The editor has a code editor with a starter for each language, **Load from file**, **What it can read, with
examples** (every value, its environment variable and where it is in the JSON, with snippets to copy in the language
you picked), and a **Test run**. A test run
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
checks and commands run at once. **Preview runs the check for real**, so it can do whatever your script does, and
records what each agent would have been told instead of starting it.

### Items are untrusted by default

An item usually carries text somebody else wrote: a pull request title, a comment, an issue. A prompt injection in
it would be read by an agent with your access. So **Treat the items as untrusted** is on, and each item's agent runs
read-only, with no tools but the board's own, and those narrowed: they can read the board, add a note and ask you, but
not start, steer or retry other agents, or merge. It can't be combined with allowed tools or tool slots.

Turn it off only when the agent has to reach outside, such as running `gh` to read a diff and post a review, and
everyone who can write the text it reads is someone you trust. The editor warns, and so does the import page.

## Variables

Variables are values your automations read that differ by project, so one automation works everywhere without
branching on the project's name: a Jira key, a team, a board id. Set them for every project under **Settings →
Autopilot → Limits & safety → Variables**, and override them for one project in its settings (**Autopilot
overrides → Automation variables**), where you also see the board's value each override replaces.

| Where           | How to read `jira_key`                                                   |
| --------------- | ------------------------------------------------------------------------ |
| A prompt        | `{{vars.jira_key}}`                                                      |
| A command       | `$ABOARD_VAR_JIRA_KEY` in sh, `$env:ABOARD_VAR_JIRA_KEY` in PowerShell   |
| A script        | `vars` in the JSON on stdin (`ctx["vars"]["jira_key"]`), or the variable |

For example, a Python script that greets the project it runs in:

```python
import json, sys

ctx = json.load(sys.stdin)
print(f"Hello world, this is running in {ctx['project']['name']}")
print("Jira project:", ctx["vars"]["jira_key"])
```

- **An automation that needs a variable doesn't run where it has none.** If a prompt, command or script names a
  variable (as above) and a project has no value for it, that project gets no run. Its row says so in orange, "Needs
  `jira_key` in: billing", and a dry run records the same. Once you set the value it starts from that moment, like
  switching it on: what happened while the value was missing doesn't all run at once. A project can opt out of one by overriding it with an empty
  value. To read a variable as optional, use `ctx["vars"].get("team", "")` in Python (or check the environment
  variable yourself): a name the board doesn't see isn't required. The editor lists the variables it found under
  **Variables it reads**, with the projects that have no value.
- **The repository URL** needs no variable: `{{project.repo_url}}`, `$ABOARD_PROJECT_REPO_URL` and `project.repoUrl`
  on stdin hold `https://github.com/<owner>/<repo>`, read from the project folder's `origin`. It is empty for a project
  with no folder or no `origin`, and never stops a run.
- **Not for secrets.** Values are plain text and show in dry runs, previews, run details and backups. Keep tokens in
  your own environment or a credential store.
- A shared file never carries your variables' values; importing one lists the variables it reads and where they are
  missing.

## Inputs and required tools

An agent action can declare **Inputs** and **Required tools**, so one prompt works for whoever uses it. A command or
script can declare inputs too.

- An **input** is a named value (text, a number or yes / no) that the prompt reads as `{{inputs.name}}`: a JQL query,
  a look-back in days, whether to ask for approval. A command or script reads it as `ABOARD_INPUT_<NAME>`
  (`$ABOARD_INPUT_LOOK_BACK`), or a script from `inputs` on stdin. Each has a label and a value. Change the value in
  the editor instead of the prompt or the code. Unlike a variable, an input is the same in every project.
- A **required tool** is a slot for a kind of tool the automation needs but can't name, since people use different MCP
  servers: "Jira tools", say, for searching issues. You fill the slot with tools of your own servers, one per line, as
  for **Allowed tools**. They are allowed to the agent like any allowed tool, and the prompt is told which tools
  fill each slot.

While a slot is empty the automation is marked **Won't work until you fill in: Jira tools** in orange, and its **On**
button is disabled. If you empty a slot of one that is already on, it stops starting agents until it is filled.

## Sharing one

On a custom automation's row, **Export** downloads a file (`triage.automation.json`). It holds the trigger,
prompt, skill name and allowed tools, any script or check script (in full), the declared inputs with their current values as defaults, and the declared
slots **without** their tools. It leaves out your projects, your epic and the tools you filled the slots with. If the
automation names a skill you have installed, the skill's text goes in the file.

To use someone's file: **+ Add automation → Import a file**, then choose the file. It opens as the builder's review:
what it does in one sentence, and before anything is saved, everything it would run: the prompt, any command, script or
check script (with its language), the tools it may use without asking and
the skill's text. Treat it as code from a stranger, because once you turn it on it runs on
your machine with your access. Then fill in its inputs and slots, optionally restrict it to projects, choose
**Saves in: Preview** (the default) or **On**, and **Import**. In Preview it records what it would do (a check script
still runs for real); turn it on in the Autopilot list when its Preview runs look right and the orange warning is gone.
**Edit first** opens it in the builder instead, at Details, with what you filled in; saving there makes it as you leave
it (a skill in the file isn't saved that way: import it as it is for that). A script in it still needs the "I've read
it" switch, on Review & try, before it saves.

- A file with a script needs one more step: a switch that says you've read the script and understand it runs on your
  machine as you. **Import** waits for it.
- A skill in the file is written to `~/.claude/skills` only if you switch **Save the skill** on. One that already
  exists is never overwritten: a name you use is kept apart (`triage-2`) and the automation names the new one.
- Export tells you when a skill went into the file. Only its `SKILL.md` travels, not scripts or other files beside
  it, so check the skill for anything private first.
- An automation name you already use gets a number: `Triage (2)`.
- A file made by a newer version of the app is refused, saying so.
- The "Improve prompts and skills" example that older versions shipped is now the built-in
  [Improve automations](autopilot.md#improve-automations). One you imported earlier keeps working as it is.

### Reviewing pull requests

An earlier version shipped an example, **Review repo PRs**, that commented on any pull request of the
repository. It is gone: the built-in **Review PRs** now does that with its **Other people's PRs** setting, and it can
approve (past a gate the board checks itself), ask for changes or hand a pull request to you
([Review PRs](autopilot.md#review-prs)). An automation you imported from it keeps working until you delete it.

If you run a custom automation that reviews pull requests (the example, or one of your own), switch it off in a
project before you turn on **Other people's PRs** there, or both review the same pull requests. Review PRs reads
what an earlier `Autopilot PR review` automation posted (its hidden `autopilot-review` markers), so rounds, approvals,
hand-offs and `/autopilot stop` carry over.

## Asking an agent for one

You can ask an agent connected to the board to write an automation for you: "every weekday at 8, triage the new
defects in Jira", "when a PR merges, run the release notes script". The agent can't set one up itself. It drafts it,
and you get a notification and a link to the review page, where the draft opens like a shared file, with a banner
saying an agent wrote it and the agent's note to you. Read it with the same care, fill in its inputs and tools, and
import it (in Preview unless you choose On), or **Edit first**.

### Changes to one you have

An agent can also propose a change to one of your custom automations: a better prompt, a fixed check script,
another time. It sends the whole new version naming the automation it replaces, and **Needs you** shows **Change to
<name>**. **Review** shows the difference field by field (trigger, prompt, check script, inputs, allowed tools...)
with the agent's reason, and three buttons:

- **Apply change** changes the automation in place: it keeps its switches (Off, Preview or On), where it runs, its run
  history, the values you gave its inputs and the tools in its slots. New inputs and slots are asked for on the
  page. A changed script needs the same "I've read it" switch as an import, and a skill the change carries is saved only
  if you switch it on (under a new name when you already have one by its name); otherwise the automation keeps its own
  skill of that name, or names none.
- **Edit first** opens the builder on the automation with the change filled in; **Save changes** applies it as you leave
  it (a changed script still needs the "I've read it" switch on Review & try).
- **Keep current** drops the proposal.

With **Settings → Agents → Providers → Board skills** on, the agent also has the `aboard-automations` skill, which tells it
how to pick a trigger and action, use your variables, inputs and tool slots, write a script that fails loudly and
treats what it reads as data, and test it before handing it over. Without it the agent still has the tool, just
less guidance.

You don't need to know what to ask. **Ask an agent** (beside **+ Add automation**, and in the Add dialog) gives you a
prompt to paste into your own agent, or starts a new T3 Code thread with it, which you can edit first. The same menu is
on each automation as **Ask an agent to change this** (it hands over the automation's current definition and asks for a
[change](#changes-to-one-you-have); for a built-in it tells you which settings to change) and on a failed run as **Ask an agent to fix**
(with the error and the end of its output). There's no chat box: the agent works in your own session, and what it
makes arrives as a draft.

Drafts waiting for you are listed under **Needs you** at the top of Settings → Autopilot, with **Review** and
**Dismiss**. Importing or applying a
draft removes it; one you leave is dropped after 14 days. Drafts aren't backed up.

## Commands and scripts run on your machine

A command or script runs as you, in sh (Windows PowerShell on Windows) or its language's interpreter, whenever its
trigger fires in a project it's on in. The board's own environment variables, such as its API token, are left out of its
environment. An agent can only draft one over MCP, which you import (see [Asking an agent for one](#asking-an-agent-for-one)),
and the API only takes a command, a script or a check from the board's settings page (a request without the page's
Origin is refused). That keeps agents from setting one up by accident; it isn't a lock, since anything that can run
commands on your machine already can.

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

Custom automations are part of the board's [backup](../features/backup.md). Agents can't see or change the ones you
have; they can only draft new ones.
