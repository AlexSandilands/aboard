# Autopilot

Autopilot lets the board act on its own. It is a list of **automations**, each of which watches the board and
does something when it's needed. Everything is off until you switch it on, and Autopilot never closes or deletes a
task, force-pushes, or pushes to the default branch. It merges in two cases only: a task's pull request into its
epic's integration branch, for an epic you set to deliver that way ([Merge into epic branch](#merge-into-epic-branch)),
and, through [Orchestrate](#orchestrate), a task's pull request into the default branch when you turned auto-merge on
for that task.

## Switching automations on

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

**Settings → Autopilot** has a switch for the whole board, and under each automation a **Settings**
section with its options: which skill it follows, which runner, the model, and budgets and timeouts. A
project can override those in its own settings. The board's switch is just **On / Off** (there's nothing above the
board to inherit from, so an automation you haven't switched on is off); only projects and epics can follow the scope above (the ↺ button).

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

- It reviews the PR again each time its head commit changes, up to **PR review rounds** (3 by default, in
  Settings → Autopilot) per PR. Drafts are skipped unless you turn on **Review drafts**; merged and closed PRs
  are never reviewed.
- From the second round it looks for regressions and for points still not fixed, and keeps new small points in an
  "FYI (no action needed)" section. On the last round only major and blocking points count.
- The findings stay on GitHub, not on the board, so they don't mix with local review findings. The task gets a
  note "Autopilot reviewed PR #N at …" linking the review.
- Points at or above the **fix threshold** (major by default) are the ones a fix would address. When the last
  round still has some, the card says "Autopilot gave up" under Needs attention and you get a notification.
- Its settings: the **review skill** it follows (the built-in one by default), **Review drafts**, the runner, the
  **budget** ($2 by default) and the **timeout**. It always runs headless, since it must be held to read-only. It
  needs `gh` signed in to the PR's host and the PR's branch on `origin`, so a PR from a fork isn't reviewed.
- Switching it on reviews every open PR already linked in the project, once per head commit. **Dry run** shows
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
- It makes at most 2 attempts on one head commit. Per PR, fixes for Autopilot's review and failing checks get **PR
  review rounds** (3 by default), and fixes for other people's comments and requests for changes get **PR comment
  rounds** (5 by default), so a colleague's review bot can't use up the attempts Autopilot's own review needs. A
  thread your account answered last doesn't send it back. When
  one runs out the card says "Autopilot gave up" under Needs attention and you get a notification; the other still
  goes on.
- It never force-pushes, pushes to the default branch or merges. PRs from forks are skipped, since their branch
  isn't on `origin`.
- To fix a PR yourself, use **Fix in** on its row ([Fixing a PR](using-the-board.md#fixing-a-pr)). While Fix PRs is on for
  the task, the row says **Autopilot is fixing** or **Autopilot gave up** instead, with **Fix in** in its menu.
- Its settings: the five switches, **Resolve threads it fixed**, a **Fix skill** to follow on top of the fix prompt, the runner, the **budget**
  ($3 by default), the **timeout** (30 minutes) and **T3 Code access**.

You can add your own automations too: a trigger you pick and an agent prompt or a command to run. See
[custom automations](custom-automations.md).

## How agents run

An automation that needs an agent picks its **runner** in its settings:

- **Auto** (the default): a new T3 Code thread when T3 Code is connected, otherwise a headless Claude Code run.
- **T3 Code only**: the thread gets the task's model (below), and never more access than T3 Code's
  own default. You can lower it further.
- **Headless only**: a CLI in a git worktree of its own under the board's data folder, never your checkout, on
  a new `autopilot/…` branch: `claude -p` unless the run's model says otherwise (below). It has a timeout, and
  on Claude Code a budget. Its session is linked on the card, so **Open in terminal** picks it up where it stopped.

Each agent automation also has a **Model**: **From the task** (the default), a tier, or one of your **Custom
models** from Settings → Model tiers. From the task means a custom model one of the task's labels picks (say a
`codex61` label on a model set to T3 Code's Codex), else the task's suggested tier.

A headless run runs on the model's **Headless runs** harness (Settings → Model tiers, on each tier and custom model):
Claude Code by default, or **Codex** (`codex exec`) or **Copilot CLI**, with the model you set for that harness. So a
`codex61` label can mean Codex in T3 Code and headless alike. Set the CLI's path in Settings → Integrations if it
isn't on your PATH, and register the board's MCP server with it ([connecting agents](connect-agents.md)) so the agent
can move its task. Some things only Claude Code can do: a reviewer's verdict, reading untrusted text locked down, a
digest with no tools. Those runs stay on Claude Code, on the model's Claude Code model (or the CLI's default when it has none), and
the run says why. Codex and Copilot
have no budget and report no cost, so only the timeout stops them and the spend cap doesn't count them. A model
with none set for its harness runs on the CLI's default, and the run says so. **Headless model override** still
takes a model typed as the CLI's `--model` takes it.

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
a notification; nothing retries. Move the task out of Planned and back in to try again. Try it first with
**Dry run** to see which tasks it would start.

## Merge into epic branch

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
- **Merge into epic branch** merges a task's pull request into the epic's branch, with a merge commit, once all of
  these hold: the task is in Review, its local review has finished with no blocking or major finding open, Review
  PRs (when it's on) found nothing at or above the fix threshold at the current commit, no reviewer asked for
  changes, its checks pass (a repository with no checks waits ten minutes after each push, in case they just
  haven't started) and it merges cleanly. The task then goes to Done, so the tasks it blocks can start from the updated branch.
- If the merge fails for a reason that may pass (another task's pull request merged into the branch first), it
  tries again a couple of times. If GitHub won't let it merge (a branch rule wants an approving review, say), the task shows **Ready to merge into
  the epic branch** under Needs attention and you get a notification. Merge it yourself.
- After the first merge it opens a **draft pull request** from the epic's branch into the default branch, links it
  on the epic and keeps its description listing every task with its pull request and reviews. If it conflicts with
  the default branch, Fix PRs merges the default branch in. **Only you merge that pull request.**
- You can go back to pull requests to main until one of the epic's tasks has started.

Switch **Merge into epic branch** on for the epic (or its project). It needs no agent and has no settings.

## Letting an agent merge into the default branch

Autopilot never merges into the default branch. An agent you run (one orchestrating an epic, say) can, with the
`merge_task_pr` tool, but only for a task you've allowed it on: set **Auto-merge** to On in the task panel's
Automation section, or tell the agent to turn it on (`update_task` with `autoMerge: "on"`). The board can't tell an
agent from you, so any agent with the board's tools could set it; agents are told to only when you ask. The board then merges the task's pull request only once it is in
Review, its local review and Autopilot's review are finished and clean, nobody requested changes, its checks pass and
it merges cleanly, and only at the commit it checked. The agent picks the order, so the tasks' pull requests don't
conflict. Without the flag, the tool refuses and the merge stays yours.

## Orchestrate

**Orchestrate** is an agent that looks over a project every 30 minutes (**Every**, from 5 minutes to a day) and keeps
its work moving, like a T3 Code thread you'd leave watching the board:

- it nudges a task's thread that has gone quiet, or starts one when the task has none working;
- it retries an Autopilot run that failed or was cut short (a review lost to a board restart, say);
- it tells a thread to fix failing checks or conflicts, and re-runs a flaky CI job once;
- with **May merge** on (the default), it merges ready pull requests of tasks you turned **auto-merge** on for, one
  at a time, and checks the others are still green afterwards. Turn it off to have it only list them;
- it flags a task under **Needs attention** when only you can decide something.

It works through the board's tools and `gh`, never edits code, and runs only while the project has work going on, so
an idle project costs nothing. Add your own rules in **Extra instructions** (for example, "hold anything that changes
the board's layout for me to check"): they're added to its prompt and win where they differ. Each run leaves a
handover for the next, so it remembers what it's waiting on. Switch it on per project or for the board; it counts
against the agent limits below.

Orchestrate has its own area in **Settings → Autopilot**, above the other automations: its switch and settings, and **View all runs**, which opens
its [run history](#run-history). What is per project is set in the project's own settings; its next check and
**Run now** are in the lane's popover (below).

Orchestrate sits at the top of the lane's Autopilot popover, in a card of its own. It shows when the next check
is ("Next check in 12:34"). A check is a look, not a promise of a run: when the next one won't
run, the section says why instead (idle with nothing to check, paused, quiet hours, today's cap reached). **▶ Run
now** runs it for the project straight away, even when it's idle, unless it is already running, Autopilot is paused,
it's quiet hours or a daily cap is reached; then a message says so. While it's on, the lane's pill shows the time to
the next check too (`Autopilot · 12m`). Switch that off under **Settings → Autopilot → Orchestrate → Countdown on
lanes**. **History** in the popover's card opens the run history filtered to that project.

A failed run on a task can also be retried by hand: **Retry** on the run in the task panel's Autopilot section.

When Autopilot has flagged a task under Needs attention and you have dealt with it yourself, click **Dismiss** in the
same section. It clears the flag and nothing else: the run stays as it was and Autopilot doesn't try it again, so
unlike Retry it can't repeat something that already took effect (such as posting a second review). A new problem on
the task flags it again.

Other automations have their own guides: [Recurring tasks](recurring-tasks.md) and the
[Digest of what changed](digest.md).

## Run history

**View all runs** (in Orchestrate's area, and in a scheduled custom automation's editor) and **All runs** (beside the
Automations heading) open a page listing every run, newest first, with more loading as you scroll. Each run shows its
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

In **Settings → Autopilot**:

- **Agent runs at once**, a **daily run cap** and a **daily spend cap**.
- **Quiet hours**: a window (local time, it may cross midnight) in which no agent runs start. Automations that
  only change the board still run.
- **Dry run**: record what each automation would do, and do nothing. Good for trying an automation out.

## Pausing

**Pause all** stops every new run at once, whatever the switches say. It's in Settings and in the board header,
where it turns into a **Resume** button while it's set. Runs already going finish.

## Seeing what it did

A card shows an **Autopilot** badge while a run is working on it. The task panel's **Autopilot** section lists
the task's runs: what each did, how it ran, a link to the T3 Code thread or the session, what it cost, and the
error if it failed. A failed run puts the card under Needs attention.

How it works: [docs/features/autopilot.md](../features/autopilot.md).
