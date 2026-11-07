# Autopilot

Autopilot lets the board act on its own. It is a list of **automations**, each of which watches the board and
does something when it's needed. Everything is off until you switch it on, and Autopilot never closes or deletes a
task, force-pushes, or pushes to the default branch. It merges in two cases only, both through
[Merge ready PRs](#merge-ready-prs): a task's pull request into its epic's integration branch, for an epic you set to
deliver that way, and, if you switch on **Into main**, a task's pull request into the default branch when you turned
auto-merge on for that task.

## Switching automations on

**Quick setup** is the fastest start. With nothing on, **Settings → Autopilot** opens on it (it's also behind **+ Add
automation → Quick setup**). Pick a level and read the list, which says exactly what it would switch on for the whole
board:

- **Notify**: the digest, stuck-task reminders, a note when a blocker finishes, and archiving old Done tasks. No agent
  starts and nothing is merged.
- **Assist**: agents review and fix the PRs your tasks open, plus the digest, reminders and archiving. They never start
  work or merge.
- **Hands-off**: agents also start the tasks you flag, keep epics moving and merge ready PRs into epic branches.
  Merging into the default branch is its own setting, which Quick setup leaves as it is.

Automations that start an agent or act on GitHub start in [Preview](#trying-one-out-with-preview) unless you turn
"Start agent automations in Preview" off. One already on is left as it is, and one a project switches off for itself
stays off there. **Apply** switches them on once and remembers nothing: they are ordinary switches afterwards, so
change any of them as usual.

Each project's lane has an **Autopilot** pill. It's dim when nothing is on for the project, a calm ring when
something is on, and animated while a run is going. Click it to see every automation with an on/off switch. A
faded switch is following the board: hover it to see what that means ("On, following the board"). Flip it and the
switch turns solid, meaning this project sets it itself; the **↺** button beside it goes back to following the board.
To pin the value the board has now, flip the switch twice. The cog at the top opens **Settings → Autopilot**.

An **epic** has the same switch, in a small round **Autopilot** button on its band and in its panel's top bar. It
covers only the tasks in that epic, and a faded switch follows the project ("On, following the project"). So you can
switch an automation on for one epic in a project that has it off, or off for one epic in a project that has it
on. The button looks like the pill: dim, a ring, or animated while one of the epic's tasks is being worked on.
An epic only lists the automations that work on tasks in an epic (not Recurring tasks or the Digest, for
instance). An archived epic has no button and no say.

Auto-archive Done on an epic works on the epic as a whole: once the epic is finished (every task Done) and has been in
Done for the set days, it is archived together with its tasks. A task in an epic is never archived on its own, and
the epic's own switch and days decide.

[Manual tasks](using-the-board.md#manual-tasks) are yours: no automation starts, reviews, fixes or reminds you
about one. Unblock dependents still tells you when finishing one unblocks a task.

**Settings → Autopilot** has three tabs: **Automations**, **Runs** and **Limits & safety**.

**Automations** opens on a strip saying whether Autopilot is running or paused, how many agent runs it started today
and what they cost, and your limits in one line, with **Pause all** beside it. Under it, **Needs you** lists what only
you can sort out, and is hidden when there's nothing: a run that failed on a task (**Retry** or **Dismiss**; a
run with no task, such as the digest's, shows as a red dot on its automation instead), an automation an
agent drafted for you (**Review** or **Dismiss**), and an automation that can't run until you fill in a tool or a
variable (**Fix**).

Then every automation, in a list down the left grouped as **Ship work**, **Pull requests**, **Upkeep** and
**Yours** (the ones you made or imported). Each row has the automation's switch for the whole board and says where
it's on and how its last run went. One that is off everywhere is greyed out but stays in the list, so you can
switch it on. Click a row to see it on the right:

- one sentence saying what it does with your settings ("Every weekday at 09:00, write a plain list of what changed
  on the board"), and **All runs**;
- **Mode**: **Off**, **Preview** or **On** for the board (see [Trying one out with Preview](#trying-one-out-with-preview));
- **Where it runs**: the board's mode and the projects it's on in;
- **Settings**: the few options most people change;
- **Advanced**, closed: everything else. For an automation that starts an agent it opens with two lines: the
  **Model**, which comes from Settings → Agents → Operations and says what it runs on now, and **Runner, budget and
  timeout**, which come from the [defaults for agent runs](#limits). Each has **Override**, to set it for this
  automation alone, and each overridden value a reset. A dot on Advanced means something in there isn't the default.

The board's switch is just **Off / Preview / On** (there's nothing above the board to inherit from, so an automation
you haven't switched on is off); only projects and epics can follow the scope above (the ↺ button), and a project can
override the options in its own settings. On a phone the list and an automation take turns: tap a row, and **All
automations** takes you back.

### Trying one out with Preview

**Preview** lets you watch one automation before you trust it, while the others keep working. In Preview it does none
of its work: each time it would act, it records a run marked **Preview** saying what it would have done ("Would start
#12 …"), and no agent starts, no command runs and nothing on the board or GitHub changes. The one exception is a custom
automation's **check script**: it still runs for real, so it can tell what it would act on, and the automation says so.

An automation in Preview has an amber **Preview** badge in the list. Its page says how many times it would have run this
week, with **See them** (its runs) and **Turn on**. Turning it on doesn't go back over what Preview saw: it acts on what
happens from then. A project or an epic can be in Preview on its own too, from its Autopilot pill or settings.

Automations you make, import or accept from an agent's draft start in Preview. The switch in the list remembers the
mode an automation was last on in, so switching it off and on again brings back Preview or On; one that has never run
comes back in Preview.

## Remind me about stuck tasks

**Remind me about stuck tasks** tells you when an In Progress task needs a look. It needs no agent, so it costs
nothing and isn't held back by quiet hours or the run limits, and it changes nothing on the task. You get a note on
the task and a notification when:

- the task has had no activity for **No activity for** hours (24 by default): it also shows under **Needs attention**
  until someone touches the task;
- its T3 Code thread has been waiting on you for **Thread waiting for** minutes (30 by default).

Each is reported once. It doesn't get anything moving again: that's [Orchestrate](#orchestrate). The two go well
together, because Orchestrate leaves a thread that's waiting for you alone, and a thread stuck waiting holds one of
your concurrency slots until you answer. This automation used to be called **Unstick stale tasks** and could also
post a nudge into the thread; that option is gone (Orchestrate does it), and a leftover setting is ignored.

## Review PRs

When a task has a pull request linked, **Review PRs** has an agent review it and post the review on GitHub as
comments, from your own `gh` account. The review starts with a line naming this app's Autopilot, and each inline
comment carries a short mark. It only ever comments: it never approves or requests changes, and it never merges. The
agent itself only reads the pull request and reports its findings; Autopilot posts them.

- It reviews the PR again each time its head commit changes, up to **Rounds per PR** (3 by default) per PR. Drafts are skipped unless you turn on **Review drafts**; merged and closed PRs
  are never reviewed.
- With local review on for the task, the PR waits: it is reviewed once the task is in Review and its local review has
  finished. A PR on a task still in Backlog, Planned or In Progress isn't reviewed until then.
- From the second round it looks for regressions and for points still not fixed, and keeps new small points in an
  "FYI (no action needed)" section. On the last round only major and blocking points count.
- The findings stay on GitHub, not on the board, so they don't mix with local review findings. The task gets a
  note "Autopilot reviewed PR #N at …" linking the review. **All runs** on an automation (and in a scheduled custom automation's editor) opens the same list for that
automation alone.
- Points at or above the **fix threshold** (Fix PRs' **Fix findings at or above**, major by default) are the ones a
  fix would address. When the last
  round still has some, the card says "Autopilot gave up" under Needs attention and you get a notification.
- Its settings: **Rounds per PR**, the **review skill** it follows (the built-in one by default), **Review drafts**,
  and the model, budget and timeout. It always runs headless, since it must be held to read-only. It
  needs `gh` signed in to the PR's host and the PR's branch on `origin`, so a PR from a fork isn't reviewed.
- Switching it on reviews every open PR already linked in the project, once per head commit. **Preview** shows
  which first.

## Fix PRs

**Fix PRs** sends an agent to a pull request linked to a task when something needs fixing. Each reason has its own
switch, all on by default:

- **Failing checks**: the agent reads the failed run's log and fixes the cause.
- **Merge conflicts**: it merges the base branch in. It never rebases, since it can't force-push.
- **Changes requested**: a review asking for changes.
- **Review comments**: new comments on review threads that aren't resolved. Autopilot posts as your own `gh`
  account, so it can't tell your comments from its own replies, and only other people's comments count. They also
  have to be from someone with access to the repository (an owner, member or collaborator), not just anyone who can
  comment on it.
- **Autopilot's review**: when **Review PRs** found points at or above the **fix threshold**. The agent fixes only
  those and leaves the rest, and the FYI section, alone.

If the task's T3 Code thread is still there, it gets the fix as a message. Otherwise a new session starts on the
PR's branch, using the runner you chose. Reasons that come up together go into one attempt. The agent pushes to
the PR's branch and replies on each thread, starting with Autopilot's mark and "fixed in <commit>" or "declined:
<reason>".

- **Resolve threads it fixed** (on by default): Autopilot resolves each thread it replied it fixed once that commit is
  on the PR, so a repository that requires every conversation resolved can merge. Threads it declined stay open for
  the reviewer. It also catches up on threads it fixed before. From its second round, **Review PRs** resolves its own
  earlier threads once it confirms the point is fixed.

- Each reason is acted on once. A new failure on a new commit, or a newer comment, is a new reason.
- It makes at most 2 attempts on one head commit. Per PR, fixes for Autopilot's review and failing checks get **Attempts
  on checks and reviews** (3 by default), and fixes for other people's comments and requests for changes get
  **Attempts on comments** (5 by default), so a colleague's review bot can't use up the attempts Autopilot's own review needs. A
  thread your account answered last doesn't send it back. When
  one runs out the card says "Autopilot gave up" under Needs attention and you get a notification; the other still
  goes on.
- It never force-pushes, pushes to the default branch or merges. PRs from forks are skipped, since their branch
  isn't on `origin`.
- To fix a PR yourself, use **Fix in** on its row ([Fixing a PR](using-the-board.md#fixing-a-pr)). While Fix PRs is on for
  the task, the row says **Autopilot is fixing** or **Autopilot gave up** instead, with **Fix in** in its menu.
- Its settings: the five switches, **Fix findings at or above**, the two attempt limits, then under Advanced
  **Resolve threads it fixed**, a **Fix skill** to follow on top of the fix prompt, the model, the runner, the budget,
  the timeout and **T3 Code access**.

You can add your own automations too: a trigger you pick and an agent prompt or a command to run. See
[custom automations](custom-automations.md).

## How agents run

Where an agent runs, its budget, its timeout and its T3 Code access are set once for every automation, under
**Defaults for agent runs** in Settings → Autopilot → Limits & safety; an automation can override any of them under
its Advanced settings. The **runner**:

- **Auto** (the default): a new T3 Code thread when T3 Code is connected, otherwise a headless Claude Code run.
- **T3 Code only**: the thread gets the task's model (below), and never more access than T3 Code's
  own default. You can lower it further.
- **Headless only**: a CLI in a git worktree of its own under the board's data folder, never your checkout, on
  a new `autopilot/…` branch: `claude -p` unless the run's model says otherwise (below). It has a timeout, and
  on Claude Code a budget. Its session is linked on the card, so **Open in terminal** picks it up where it stopped.

Each agent automation also has a **Model**: **Inherit** (the default), a tier, one of your **Custom models** from
Settings → Agents → Models, or a provider's model with its effort, picked in the same model picker as everywhere else (a
provider that can't do what the automation needs is greyed out, with the reason). Inherit takes the board's model for that kind of run, and for a run on a task by default the
task's own: a custom model one of its labels picks (say a `codex61` label on a model set to T3 Code's Codex), else its
suggested tier, else the Light tier. Orchestrate, PR reviews and the digest default to a tier of their own (Standard,
Standard and Light). The board's model for each kind of run is set under **Settings → Agents → Operations**, where
each row says what it resolves to now.

A headless run runs on a provider you added in Settings → Agents → Providers: the model's preferred one (the **Preferred** radio
under a provider's column for each tier and custom model in Settings → Agents → Models) when it can do the job, else the first in your Providers list
that can and has a model for it. So a `codex61` label can mean Codex in T3 Code and headless alike. Add the provider
with its CLI path if it isn't on your PATH, and register the board's MCP server with it
([connecting agents](connect-agents.md)) so the agent can move its task. Some things only Claude Code can do: a
digest with no tools, a run held to tool rules, reading untrusted text fully locked down. Those runs go to Claude Code,
on the model's Claude Code model (or the CLI's default when it has none), and the run says why; without Claude Code
added they fail and say what is missing, rather than running somewhere else. Codex can also run the board reviewer and
the settings Ask, and, if you choose it, PR review and GitHub issue import. For those two the model picker shows a
warning: Codex can't keep its file reads inside the checkout, so text in a pull request or issue could make it leak
local files into what it writes. Autopilot never picks Codex for them on its own, not even through a tier that prefers Codex unless you set that tier
for PR review or issue import itself, and the run repeats the warning. Codex and Copilot have no budget and report no
cost, so only the timeout stops them and the spend cap doesn't count them. A model with none set for its provider runs
on the CLI's default, and the run says so. Each run records the provider and model it ran on.

Headless agents can't force-push, delete a branch or push to the default branch: their worktree's `pre-push` hook
refuses it, whatever the CLI (your repository's own hooks still run). Claude Code and Copilot CLI are also refused
`gh pr merge`; Codex is only told not to merge. A worktree is removed
once the task's PR merges, or after **Worktree retention** days (7 by default). One with uncommitted changes is
kept.

## Start planned tasks

The one that does the work: it starts an agent on a task you've planned. Switch it on per project or for the
board, then flag the tasks you want it to take: **Autopilot: On** in the task panel's Automation section. A task flagged
Default or Off is never started.

A task is picked up when it's in **Planned**, flagged On, has a plan and nothing unfinished blocks it, and the
limits below leave room. [Priority](using-the-board.md#priority) tasks go first, then the rest in the order they sit
in the Planned column, so drag the one you want first to the top.

The agent gets the same prompt as the **Copy prompt** hand-off in work mode, plus a note that nobody is watching:
if it needs an answer it marks the step blocked and stops. It runs on the task's model: a custom model one of its labels
picks, else the one you mapped to its suggested tier. Its settings:

- **Implement skill**: what the agent follows; the default is the board's own workflow.
- **Runner**, **budget**, **timeout** and **T3 Code access**, as in [How agents run](#how-agents-run).
- **Start from**: the branch its worktree starts from; blank is the project's default branch. A task of an epic
  delivered through an integration branch always starts from that branch, and opens its pull request against it.
- **Start grace period** (15 minutes): the agent moves the task to In Progress itself.

**Agent runs at once** limits how many agent runs Autopilot has open, not what your machine runs: threads you start
yourself never count. A T3 Code thread Autopilot started counts only against Start planned: it keeps its place until it goes
idle or finishes, is archived or settled, or its task is Done or moves back to Backlog. A thread waiting
for your answer still holds its place, so answer it, or the next task won't start. A thread the board can no longer
see (T3 Code closed, the thread deleted) stops holding it after ten minutes.

It tries a task once each time it enters Planned. If the run fails, or the task is still in Planned when the
grace period ends, the card goes under **Needs attention** with "Autopilot couldn't start this task" and you get
a notification; nothing retries. Move the task out of Planned and back in to try again. Try it first in
**Preview** to see which tasks it would start.

## Merge ready PRs

**Merge ready PRs** merges a task's pull request once it is ready: into its epic's branch if the epic has one, or into
main if you flagged the task **Auto-merge** and switched **Into main** on. It needs no agent, so it costs nothing.
Ready means all of these hold:

- the task is in Review;
- its local review has finished with no blocking or major finding open, and Review PRs (when it's on) found nothing at
  or above the fix threshold at the current commit;
- no reviewer asked for changes;
- its checks pass (a repository with no checks waits ten minutes after each push, in case they just haven't started);
- it merges cleanly.

Anything else waits. Where only you can settle it (GitHub wants an approving review, say), the task shows why under
**Needs attention** and you get a notification.

It has two targets:

- **Into epic branches** is on whenever the automation is on. A task in an epic with its own branch merges into that
  branch, never into main. Example: #12 Card vault is in epic #5, which delivers through `epic/5-one-page-checkout`;
  when #12's pull request is ready it merges there, and the epic's own pull request into main stays yours.
- **Into main** is off unless you switch it on. Only tasks you flagged **Auto-merge** (in the task panel's
  Automation section) merge into main, through the same check the `merge_task_pr` tool uses. It merges one pull
  request at a time per repository and reads the others again after each merge, so a pull request that conflicts
  with the one that just landed waits for a fix instead of merging. Example: #4 Fix currency rounding is flagged
  Auto-merge; once its pull request is ready it merges into main and #4 goes to Done.

Switch it on for the board, a project or an epic in **Settings → Autopilot → Merge ready PRs**, and **Into main** there
too.

### Integration branches

For an epic whose tasks build on each other, waiting for you to merge each pull request before the next task can
start means the epic stops every time a task is done. An epic can instead deliver through an **integration branch**:

- Set it with the branch button next to the epic's Autopilot button in its panel, or at the bottom of the epic's
  Autopilot popover: **Delivery: Pull requests to main** (the default) or **Integration branch**. The board makes
  the branch `epic/<number>-<title>` on origin from your default branch. Agents ask you about this when they plan
  an epic whose tasks depend on each other; they never choose for you.
- The epic isn't Done until that branch has merged into main. With every task done it waits in **Review**, with a
  **waiting for merge into main** badge, and finishes by itself once you merge its pull request (the draft one Autopilot
  keeps, or one you link on the epic). If the branch merged some other way, or there's no pull request to watch, open the
  badge and press **Mark merged into main**.
- The epic's tasks start from that branch and open their pull requests against it: Start planned tasks, the
  hand-off prompts and **New T3 Code thread…** all default to it.
- **Merge ready PRs** merges a task's pull request into the epic's branch once it is ready (above). The task then
  goes to Done, so the tasks it blocks can start from the updated branch.
- It merges with a merge commit if the repository allows one, otherwise a squash, otherwise a rebase, going by the
  repository's settings when it merges (and moving to the next method if GitHub refuses one, for example because of a
  branch rule). A squash-only repository therefore gets squashed task commits on the epic's branch. That can
  conflict for a task whose branch was built on another task's branch that hasn't merged yet; tasks normally start
  from the epic's branch once the tasks blocking them are Done, so it rarely comes up.
- If the merge fails for a reason that may pass (another task's pull request merged into the branch first), it
  tries again a couple of times. If GitHub won't let it merge (a branch rule wants an approving review, say), the task shows **Ready to merge into
  the epic branch** under Needs attention and you get a notification. Merge it yourself.
- After the first merge it opens a **draft pull request** from the epic's branch into the default branch, links it
  on the epic and keeps its description listing every task with its pull request and reviews. If it conflicts with
  the default branch, Fix PRs merges the default branch in. **Only you merge that pull request.**
- You can go back to pull requests to main until one of the epic's tasks has started.

Switch **Merge ready PRs** on for the epic (or its project).

## Auto-merge into the default branch

A task's pull request reaches the default branch without you only when you've allowed it on that task: set
**Auto-merge** to On in the task panel's Automation section, or tell an agent to turn it on (`update_task` with
`autoMerge: "on"`). The board can't tell an agent from you, so any agent with the board's tools could set it; agents
are told to only when you ask. Then two things may merge it, both through the same check (ready, above), and only at
the commit it checked:

- **Merge ready PRs** with **Into main** on, by itself, one at a time per repository;
- an agent you run (one orchestrating an epic, say), with the `merge_task_pr` tool. The agent picks the order, so the
  tasks' pull requests don't conflict.

Without the flag both refuse and the merge stays yours.

## Orchestrate

**Orchestrate** is an agent that looks over a project every 30 minutes (**Every**, from 5 minutes to a day) and keeps
its work moving, like a T3 Code thread you'd leave watching the board:

- it nudges a task's thread that has gone quiet, or starts one when the task has none working;
- it retries an Autopilot run that failed or was cut short (a review lost to a board restart, say);
- it tells a thread to fix failing checks or conflicts, and re-runs a flaky CI job once;
- it lists the pull requests that look ready to merge. It never merges: [Merge ready PRs](#merge-ready-prs) does that;
- it flags a task under **Needs attention** when only you can decide something.

It works through the board's tools and `gh`, never edits code, and runs only while the project has work going on, so
an idle project costs nothing. Add your own rules in **Extra instructions** (for example, "hold anything that changes
the board's layout for me to check"): they're added to its prompt and win where they differ. Each run leaves a
handover for the next, so it remembers what it's waiting on. Switch it on per project or for the board; it counts
against the agent limits below.

Orchestrate is in **Settings → Autopilot** like the others, under Ship work: its switch, **Every** and **Extra
instructions**, and **All runs**, which opens its [run history](#run-history). What is per project is set in the
project's own settings; its next check and **Run now** are in the lane's popover (below).

Orchestrate sits at the top of the lane's Autopilot popover, in a card of its own. It shows when the next check
is ("Next check in 12:34"). A check is a look, not a promise of a run: when the next one won't
run, the section says why instead (idle with nothing to check, paused, quiet hours, today's cap reached). **▶ Run
now** runs it for the project straight away, even when it's idle, unless it is already running, Autopilot is paused,
it's quiet hours or a daily cap is reached; then a message says so. While it's on, the lane's pill shows the time to
the next check too (`Autopilot · 12m`). Switch that off under **Settings → Appearance → Autopilot countdown on
lanes**. **History** in the popover's card opens the run history filtered to that project.

A failed run on a task can also be retried by hand: **Retry** on the run in the task panel's Autopilot section.

When Autopilot has flagged a task under Needs attention and you have dealt with it yourself, click **Dismiss** in the
same section. It clears the flag and nothing else: the run stays as it was and Autopilot doesn't try it again, so
unlike Retry it can't repeat something that already took effect (such as posting a second review). A new problem on
the task flags it again.

## Improve automations

**Improve automations** audits how agents did and suggests changes to the text they run with. It is off until you
switch it on, and it runs once a week (**Day** and **Time**, Monday 07:00 by default) in each project it is on in.
It reads what happened over the last **Look back** days (7): review rounds and findings, failed or retried
Autopilot runs, blocked steps, stalls and agents' notes. It looks closer at the few tasks that went worst, and at
their session transcripts only when the notes don't say why. Then it suggests at most **Most suggestions per run**
(3) rewrites of your review and planning skills, your custom automations' prompts and the skills they name
(**May suggest changes to** narrows that to skills or prompts). You decide each one under
**Settings → Tasks → Suggestions** ([Suggested changes](settings.md#suggested-changes)). It never edits anything
itself: its only tools besides reading are `suggest_change` and an attention request, and a suggestion over the limit,
or for a kind of target you didn't allow, is dropped. A project where nothing happened in the look-back window is
skipped, so an idle project costs nothing.

Its skill is built in, so it can't run without it and quietly propose nothing. The skill keeps suggestions few and lean:

- each one cites the tasks that show the problem: at least two, or one that cost a failed run or a blocked task;
- it rewrites or deletes the sentence that caused the problem rather than adding one, and a suggestion that makes
  the text longer says why in its first line;
- one behaviour per suggestion, no generic advice ("be careful"), the target's own wording and layout kept;
- with weak evidence it suggests nothing, which is a good week.

To use your own rules instead, pick a skill under **Improve skill**. If that skill's file has gone missing the run
fails and says which skill it couldn't read, instead of running without one; pick another, or **Built-in**.

Its handover remembers what it suggested, so the next run sees whether you accepted it and whether the problem went
away, and `get_editable_prompt` shows what you decided, so it doesn't suggest again what you rejected. Text the
board itself ships (its tool descriptions) can't be suggested to; the agent says so in its summary. It runs on the Deep
model tier (change it under **Settings → Agents → Models**) and counts against the agent limits. Switching it on
doesn't catch up on weeks before: the first run is the first slot after you switch it on. Several runs at the same
moment can both suggest for one skill; the later one replaces the earlier, which stays in the history.

Other automations have their own guides: [Recurring tasks](recurring-tasks.md) and the
[Digest of what changed](digest.md).

## Run history

The **Runs** tab of Settings → Autopilot lists every run, newest first, with more loading as you scroll. Each run shows its
status, project, when it ran, what it said it did and, for a scheduled agent, the handover it left, folded away. Narrow
the list by project and time (the last 24 hours, 7 or 30 days, or a range of days), and search by run id, project name,
a task as `#12`, or any word of the summary or handover. The filters are in the page's address, so you can bookmark a
view.

You can clear out old runs from this page. Tick runs and choose **Delete selected**, or choose **Delete all matching…**
to delete everything the filters match: set a custom range ending on a date, say, then delete. The box tells you how many
will go before you confirm, and that runs aren't in backups, so a delete can't be undone. Autopilot never deletes runs
by itself.

Some runs stay even when you ask, because Autopilot still reads them. The box says how many it kept and why:

- runs that are queued or running, or whose worktree is still on disk;
- runs on a task that isn't Done yet (they decide how many review rounds and fix attempts are left);
- Auto-archive and custom automation runs on a task;
- the latest answer of each scheduled agent in each project (its next run is handed that handover);
- runs less than a day old.

## Limits

In **Settings → Autopilot → Limits & safety**:

- **Agent runs at once**, a **daily run cap** and a **daily spend cap**.
- **Quiet hours**: a window (local time, it may cross midnight) in which no agent runs start. Automations that
  only change the board still run.
- **Defaults for agent runs**: where agents run (Auto, T3 Code or headless), the **budget** and **timeout** of a
  headless run ($5 and 60 minutes by default) and **T3 Code access**. Every automation that starts an agent uses
  these unless it overrides them. Models are set per kind of run in Settings → Agents → Operations.
- Review PRs' rounds and Fix PRs' threshold and attempts are on those automations.
- Under **Advanced**, **Preview everything**: every automation records what it would do, and does nothing. To try one
  automation, put just that one in [Preview](#trying-one-out-with-preview) instead. Also **Worktree retention**.
- The **Variables** your custom automations read.

## Pausing

**Pause all** stops every new run at once, whatever the switches say. It's on the Automations tab and in the board header,
where it turns into a **Resume** button while it's set. Runs already going finish.

## Seeing what it did

A card shows an **Autopilot** badge while a run is working on it. The task panel's **Autopilot** section lists
the task's runs: what each did, how it ran, a link to the T3 Code thread or the session, what it cost, and the
error if it failed. A failed run puts the card under Needs attention.

How it works: [docs/features/autopilot.md](../features/autopilot.md).
