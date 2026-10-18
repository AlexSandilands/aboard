# Autopilot

Autopilot lets the board act on its own. It is a list of **automations**, each of which watches the board and
does something when it's needed. Everything is off until you switch it on, and Autopilot never merges into the
default branch, closes or deletes a task, force-pushes, or pushes to the default branch. The one merge it makes is
a task's pull request into its epic's integration branch, for an epic you set to deliver that way
([Merge into epic branch](#merge-into-epic-branch)).

## Switching automations on

Each project's lane has an **Autopilot** pill. It's dim when nothing is on for the project, a calm ring when
something is on, and animated while a run is going. Click it to see every automation with an **Inherit / On /
Off** switch. Inherit follows the board, and the switch says what that means ("Inherit (On from board)").

An **epic** has the same switch, in a small round **Autopilot** button on its band and in its panel's top bar. It
covers only the tasks in that epic, and Inherit follows the project ("Inherit (On from project)"). So you can
switch an automation on for one epic in a project that has it off, or off for one epic in a project that has it
on. The button looks like the pill: dim, a ring, or animated while one of the epic's tasks is being worked on.
An epic only lists the automations that work on tasks in an epic (not Recurring tasks or the Digest, for
instance). An archived epic has no button and no say.

Auto-archive Done on an epic works on the epic as a whole: once the epic is finished (every task Done) and has been in
Done for the set days, it is archived together with its tasks. A task in an epic is never archived on its own, and
the epic's own switch and days decide.

**Settings → Autopilot** has the same switches for the whole board, and under each automation a **Settings**
section with its options: which skill it follows, which runner, the model tier, and budgets and timeouts. A
project can override those in its own settings.

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
the PR's branch and replies on the threads it addressed, starting each reply with Autopilot's mark.

- Each reason is acted on once. A new failure on a new commit, or a newer comment, is a new reason.
- It makes at most 2 attempts on one head commit and **PR review rounds** (3 by default) per PR. After that the
  card says "Autopilot gave up" under Needs attention and you get a notification.
- It never force-pushes, pushes to the default branch or merges. PRs from forks are skipped, since their branch
  isn't on `origin`.
- To fix a PR yourself, use **Fix in** on its row ([Fixing a PR](using-the-board.md#fixing-a-pr)). While Fix PRs is on for
  the task, the row says **Autopilot is fixing** or **Autopilot gave up** instead, with **Fix in** in its menu.
- Its settings: the five switches, a **Fix skill** to follow on top of the fix prompt, the runner, the **budget**
  ($3 by default), the **timeout** (30 minutes) and **T3 Code access**.

You can add your own automations too: a trigger you pick and an agent prompt or a command to run. See
[custom automations](custom-automations.md).

## How agents run

An automation that needs an agent picks its **runner** in its settings:

- **Auto** (the default): a new T3 Code thread when T3 Code is connected, otherwise a headless Claude Code run.
- **T3 Code only**: the thread gets the model you set for the task's tier, and never more access than T3 Code's
  own default. You can lower it further.
- **Headless only**: `claude -p` in a git worktree of its own under the board's data folder, never your
  checkout, on a new `autopilot/…` branch. It has a budget and a timeout. Its session is linked on the card,
  so **Open in terminal** picks it up where it stopped.

Headless agents can't force-push, push to the default branch or merge a pull request. A worktree is removed
once the task's PR merges, or after **Worktree retention** days (7 by default). One with uncommitted changes is
kept.

## Start planned tasks

The one that does the work: it starts an agent on a task you've planned. Switch it on per project or for the
board, then flag the tasks you want it to take: **Autopilot: On** in the task panel's Details. A task flagged
Default or Off is never started.

A task is picked up when it's in **Planned**, flagged On, has a plan and nothing unfinished blocks it, and the
limits below leave room. [Priority](using-the-board.md#priority) tasks go first, then the rest in the order they sit
in the Planned column, so drag the one you want first to the top.

The agent gets the same prompt as the **Copy prompt** hand-off in work mode, plus a note that nobody is watching:
if it needs an answer it marks the step blocked and stops. It runs on the model you mapped to the task's
suggested tier. Its settings:

- **Implement skill**: what the agent follows; the default is the board's own workflow.
- **Runner**, **budget**, **timeout** and **T3 Code access**, as in [How agents run](#how-agents-run).
- **Start from**: the branch its worktree starts from; blank is the project's default branch. A task of an epic
  delivered through an integration branch always starts from that branch, and opens its pull request against it.
- **Start grace period** (15 minutes): the agent moves the task to In Progress itself.

**Agent runs at once** limits how many of its agents are working: a T3 Code thread keeps its place until it goes
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
`merge_task_pr` tool, but only for a task you've allowed it on: tell the agent to turn **auto-merge** on for the
task (`update_task` with `autoMerge: "on"`). The board then merges the task's pull request only once it is in
Review, its local review and Autopilot's review are finished and clean, nobody requested changes, its checks pass and
it merges cleanly, and only at the commit it checked. The agent picks the order, so the tasks' pull requests don't
conflict. Without the flag, the tool refuses and the merge stays yours.

Other automations have their own guides: [Recurring tasks](recurring-tasks.md) and the
[Digest of what changed](digest.md).

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
