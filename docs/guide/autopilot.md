# Autopilot

Autopilot lets the board act on its own. It is a list of **automations**, each of which watches the board and
does something when it's needed. Everything is off until you switch it on, and Autopilot never merges, closes
or deletes a task, force-pushes, or pushes to the default branch.

## Switching automations on

Each project's lane has an **Autopilot** pill. It's dim when nothing is on for the project, a calm ring when
something is on, and animated while a run is going. Click it to see every automation with an **Inherit / On /
Off** switch. Inherit follows the board, and the switch says what that means ("Inherit (On from board)").

An **epic** has the same switch, in a small round **Autopilot** button on its band and in its panel's top bar. It
covers only the tasks in that epic, and Inherit follows the project ("Inherit (On from project)"). So you can
switch an automation on for one epic in a project that has it off, or off for one epic in a project that has it
on. The button looks like the pill: dim, a ring, or animated while one of the epic's tasks is being worked on.
An epic only lists the automations that work on tasks in an epic (not Auto-archive Done or Recurring tasks, for
instance). An archived epic has no button and no say.

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
