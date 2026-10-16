# Digest of what changed

The digest is a summary of what happened on the board since the last one: tasks that moved, pull requests that
merged, tasks that started needing you, and what Autopilot ran, with a section for each project. It is part of
Autopilot, and it is off until you switch it on, but you can ask for one at any time.

## Reading it

The **Digest** button in the board header shows a dot while there is a digest you haven't opened. Click it to
read the latest one; task numbers (`#42`) open the task. **Older** digests (the last 30 are kept) are in the
same panel, and opening one marks it read. **Generate now** makes one straight away; so does **Autopilot:
digest now** in the command palette. A new digest also goes to the [inbox](notifications.md).

A digest covers the time since the previous one (the first covers the last 24 hours), so making one by hand
doesn't hide anything from the next.

## What's in it

- **Moved**: where each task started and ended in the period.
- **Merged pull requests**, with the task they finished.
- **Needs attention**: tasks whose agent started waiting for you, whose checks started failing, or that got
  change requests. These come from the notifications, so a type you switched off under Settings → Notifications
  isn't reported.
- **Autopilot**: how many runs there were, which failed or need you, and what they cost.

Projects with nothing to report are left out.

## Switching it on

Under **Settings → Autopilot**, switch **Digest of what changed** on for the board, and open its **Settings**:

- **Digest**: **Plain list** (built by the board, no agent, free) or **Written by an agent**.
- **Time** (local) and **Weekdays only**. After the board has been off, you get one digest for the lot.
- For an agent-written digest: the **Digest skill** to follow (the built-in one, or any skill you have), the
  **Agent budget**, **Agent timeout** and **Agent model** (blank uses the model for your light tier).

Switching it on, or changing its time, doesn't make a digest for a time that has already passed that day; the
first one is at the next set time. Use **Generate now** for one straight away.

To leave a project out, switch the digest **Off** in that project's Autopilot settings. A digest made now covers
every project that isn't Off, even while the automation itself is off.

## The agent-written digest

The agent gets the plain digest and rewrites it as a short update. It runs headless, on its own with no access
to the board, your files or any tools, so a task title can't make it read or do anything. The digest shows no images, since the agent's text could
carry a link that sends it out when the page loads. If it fails, runs
out of budget or answers nothing, you get the plain digest instead, with a line saying why. A quiet period never
starts an agent. It waits out Autopilot's quiet hours, and goes plain while Pause all is set, in dry-run, or once
today's spend cap is used up.

How it works: [docs/features/autopilot.md](../features/autopilot.md#automations).
