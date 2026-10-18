# Stats

The stats page shows how work on the board has gone, week by week: how much was created and finished, how long
it took, how often reviews looped, how many pull requests merged, and what Autopilot and agent sessions did.
Nothing is set up for it; the board works it out from the history it already keeps, so it covers your whole
past, not just the time since you opened the page.

## Opening it

Click the **Stats** icon at the bottom of the sidebar, or run **Open stats** from the command palette. The page
starts on the project the board is showing, if any.

At the top, pick a **project** (or **All projects**) and a **period**: the last **4w**, **12w** or **52w**.
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
- **PRs and reviews**: pull requests the board saw merge, review rounds per finished task, and review findings
  by severity.
- **Autopilot**: runs by outcome, by automation, and what they cost.
- **Sessions**: agent sessions, by the week they were first linked to a task.

Weeks start on Monday, and the last bar or point is the current week so far, so it is usually the smallest.

Point at a bar or point to see the exact values for that week. With the keyboard, tab to a chart and use the
**left and right arrow keys**, **Home** and **End** to move between weeks. Screen readers get each chart's
values as a table.
