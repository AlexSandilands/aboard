# Stats

The stats page shows how work on the board has gone, week by week: how much was created and finished, how long
it took, how often reviews looped, how many pull requests merged, what Autopilot and agent sessions did, and where agents got stuck.
Nothing is set up for it; the board works it out from the history it already keeps, so it covers your whole
past, not just the time since you opened the page.

## Opening it

Click the **Stats** icon at the bottom of the sidebar, or run **Open stats** from the command palette. The page
starts on the project the board is showing, if any.

While the page is open the icons at the bottom of the sidebar give way to a **Back** button (or press Esc) that returns to the board, on the same project.

At the top, pick a **project** (or **All projects**) and a **period**: the last **1w**, **4w**, **12w** or **52w**.
The 1w view shows one bar or point per day instead of per week: the last 7 days, ending today, against the 7 before.
Both are in the address, so a link or a browser bookmark opens the same view. The charts refresh when you come
back to the window and when you change either choice.

## Reading it

Each section has a few headline numbers and charts. A headline shows the total over the period and how it
compares with the period of the same length just before it ("+20% vs previous 12 weeks"). Green and red mean
better and worse only where that is clear: more tasks finished is better, a longer cycle time is worse. Counts
such as PRs merged or runs are shown neutrally, since more or fewer isn't good or bad by itself.

- **Throughput**: tasks created and finished each week. Epics aren't counted, and neither are tasks closed as a
  duplicate or won't do.
- **Cycle time**: the median time from starting a task (its first move to In Progress) to finishing it, and
  from creating it to finishing it. A gap in the line is a week where nothing finished.
- **Flow**: where work waits. The median and average time tasks spent in Backlog, Planned, In progress and
  Review before moving on, counted in the week the stay ended (so a long wait shows up when the task finally
  moves), and how many tasks were open in each status at the end of each week.
- **PRs and reviews**: pull requests the board saw merge, review rounds per finished task, and review findings
  by severity.
- **PR flow**: for the PRs that merged, how long they were open (from when the PR was linked to a task to when the
  board saw it merge), how many rounds of Autopilot review and how many Autopilot fix attempts they took, and how
  often Autopilot gave up on a PR.
- **Autopilot**: runs by outcome, by automation, and what they cost.
- **Sessions**: agent sessions, by the week they were first linked to a task.
- **Friction**: where agents got stuck or needed you: steps marked blocked or skipped, requests for your attention
  and Autopilot flags, tasks that stalled (quiet for too long, or waiting on input), and runs cut short because
  the board restarted. A blocked step is often an agent doing the right thing, so a rise isn't marked as bad.
- **Breakdowns**: the whole period split by category, largest first, each with the previous period beside it:
  finished tasks by label (a task with several labels counts under each) and by suggested model tier, and
  sessions by what ran them (Claude Code, Copilot CLI or a T3 Code thread). Labels and tiers are as they are now.

Weeks start on Monday, and the last bar or point is the current week so far, so it is usually the smallest.

Point at a bar or point to see the exact values for that week. With the keyboard, tab to a chart and use the
**left and right arrow keys**, **Home** and **End** to move between weeks. Screen readers get each chart's
values as a table.
