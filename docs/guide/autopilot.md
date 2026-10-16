# Autopilot

Autopilot lets the board act on its own. It is a list of **automations**, each of which watches the board and
does something when it's needed. Everything is off until you switch it on, and Autopilot never merges, closes
or deletes a task, force-pushes, or pushes to the default branch.

## Switching automations on

Each project's lane has an **Autopilot** pill. It's dim when nothing is on for the project, a calm ring when
something is on, and animated while a run is going. Click it to see every automation with an **Inherit / On /
Off** switch. Inherit follows the board, and the switch says what that means ("Inherit (On from board)").

**Settings → Autopilot** has the same switches for the whole board, and under each automation a **Settings**
section with its options: which skill it follows, which runner, the model tier, and budgets and timeouts. A
project can override those in its own settings.

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
limits below leave room. Tasks go in the order they sit in the Planned column, so drag the one you want first to
the top.

The agent gets the same prompt as the **Copy prompt** hand-off in work mode, plus a note that nobody is watching:
if it needs an answer it marks the step blocked and stops. It runs on the model you mapped to the task's
suggested tier. Its settings:

- **Implement skill**: what the agent follows; the default is the board's own workflow.
- **Runner**, **budget**, **timeout** and **T3 Code access**, as in [How agents run](#how-agents-run).
- **Start from**: the branch its worktree starts from; blank is the project's default branch.
- **Start grace period** (15 minutes): the agent moves the task to In Progress itself.

**Agent runs at once** limits how many agents are being started or run headless; a T3 Code thread stops counting
once it has taken the task, so with T3 Code several threads can be working together.

It tries a task once each time it enters Planned. If the run fails, or the task is still in Planned when the
grace period ends, the card goes under **Needs attention** with "Autopilot couldn't start this task" and you get
a notification; nothing retries. Move the task out of Planned and back in to try again. Try it first with
**Dry run** to see which tasks it would start.

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
