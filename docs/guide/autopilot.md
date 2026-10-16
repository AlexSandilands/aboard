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
