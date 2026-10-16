# Recurring tasks

A recurring rule makes a task from a [template](templates.md) on a schedule: a weekly dependency bump, a
`pnpm audit`, a docs check, a release checklist. It is part of Autopilot, but no agent is involved: the
board creates the task, and you or an agent do the work.

## Setting one up

Open the project's settings (the gear in the sidebar) and find **Recurring tasks**.

1. Switch on **Create recurring tasks here**. Until then no rule in the project runs.
2. **New rule**, or **Add** one of the examples (dependency bumps, security audit, docs drift check, stale
   branch and worktree cleanup, flaky test sweep, release prep, renewing the T3 token). An example adds a
   template for the project, which you can edit under Settings → Templates.
3. In the editor, give it a name and pick the template. The template needs a title pattern, which names each
   task (`Bump dependencies {{date}}`).
4. Choose when: on chosen **weekdays**, or **every N days** counted from a start date, at a time of day. Times
   are local.
5. **Flag for Autopilot** gives the new tasks the Autopilot flag, so Start planned tasks may pick them up.

Each rule shows when it is next due and what became of the last task it made. The switch on a rule pauses it.

## What it does

- When a slot comes, it creates a task from the template, with a note "Created by Autopilot from recurring
  rule …". A template with a plan gives a **Planned** task; one without gives a **Backlog** task.
- If the task it made last time is still open (not Done, closed or archived), the slot is **skipped** and
  logged, so a chore nobody has done doesn't pile up.
- If the board was off when a slot came, it makes **one** task when it is back, not one per missed slot.
- A new rule, a rule switched back on and a rule whose schedule you change start from now: they don't catch up
  on slots that passed before.
- With **dry-run** on, it only records what it would create.

Rules are part of the board's [backup](../features/backup.md). Agents can't see or change them.
