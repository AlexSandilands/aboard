# Using the board

The board has one swimlane per project and five columns: **Backlog → Planned → In Progress → Review →
Done**. Agents move tasks along over MCP; you can do everything they can from the UI.

![A task in Review with its labels, a PR with changes requested, review findings and its plan](../../.github/assets/task-panel.png)

## The General project

Not everything you track belongs to a code project: a presentation to update, something a colleague sent you to
review. Every board starts with a **General** lane, a project with no folder, for these. Click the inbox button in the
board's top bar, or choose _New general task_ in the command palette, to add a task to it. Agents file a task there
when they pass `general: true`. General is an ordinary project: rename it, archive it or delete it in its settings,
and when a task turns into real work, move it into the right project with _Move to project_ in the task panel.
Projects you add later appear before General, so it stays the last lane until you reorder it. Since it has no
folder, you can't start a terminal session or a T3 Code thread from a General task.

## Plans

A backlog task can be rough (an idea, a to-do, a Jira ticket), but it can't leave Backlog until it has a plan. A plan is a list of phases, each
with a few concrete steps. The task panel shows exactly which step a task is on, and the card shows its
progress.

## Writing descriptions and notes

The boxes for a task's description, plan context and step notes, and the description box when you create a task,
show Markdown as it will read. Type `- ` for a bullet, `1. ` for a numbered list, `[ ] ` for a checkbox, `# ` for a
heading, `> ` for a quote and three backticks for a code block; `**bold**`, `*italic*` and backticks around code
work as in Markdown. Pasted Markdown turns into the same, and copying gives Markdown back. Text with something the
editor can't show (a table, HTML) opens as plain Markdown instead, and says so under the box.

## Pasting images

Paste (or drag) a screenshot into a task's description, plan context or a step's notes, or into the description box
when you create a task. It shows in the text as a small pill, with thumbnails under the text once it is saved; click
either to see the image large. Big images are shrunk in your browser first, and anything still over 5 MB is refused. Agents that read the task
(`get_task`) get the image's file path, so they can open a screenshot of the bug. The images are part of
the board's backups, and are deleted with the task.

The dialogs that start a T3 Code thread or a Claude Code / Copilot CLI session take images too: paste or drop them
into the first message, or use the image button. They go with the first message (T3 Code passes them to the agent;
a CLI session gets each image's file path) and are kept with the task.

## Closing, archiving and deleting

- **Closing without doing it:** a task that another task already delivered, a duplicate, or one you no
  longer want can be closed as **Done by #N**, **Duplicate of #N** or **Won't do** (task menu, or
  `close_task` over MCP). It moves to Done without needing a plan, and the other task lists it under
  "Also resolved". Moving it out of Done reopens it.
- **Archiving** clears a card off the board. It's for tidying up, not for resolving work. Archiving an epic
  (once none of its tasks is open) archives its Done tasks with it, and unarchiving the epic brings them back.
- **Deleting** removes an archived task for good, with its plan, links and activity (task menu, or
  `delete_task` over MCP). Archive first; active tasks can't be deleted.

## Links

A task can link to:

- **GitHub PRs**, on github.com or GitHub Enterprise, with their live state (checks, review, conflicts)
  and a **Merge** button once the task is in Review, through the account the `gh` CLI is signed in with. When
  checks fail, the PR conflicts or changes are requested, **Fix in** takes the button's place (see
  [Fixing a PR](#fixing-a-pr)). Checks follow GitHub's merge box: when the base branch requires some, only those
  count, and optional ones that are still running or failing show beside the icon instead. A PR is read every
  20 seconds while its checks run, it was just linked or updated, or its task panel is open; every 2 minutes
  otherwise; and every 30 minutes once it is merged or closed. The row says when it was last checked, and its
  refresh button reads it now.
- **GitHub issues**, with their state when imported (see [Importing issues](importing-issues.md)).
- **Tickets** from the trackers you set up in **Settings → Integrations → Ticket systems**: Jira, Linear or your own.
  Each system has a key pattern (`[A-Z]+-\d+`), a URL pattern and a link template, and **Add** fills them in from
  a preset. Pasting a key or URL makes a link to it, and with **Link keys in titles** on, a key in a task's title is
  linked by itself. A key no system matches stays plain text.
- **T3 Code threads**, one click back to the conversation (see [T3 Code](t3-code.md)).
- **Claude Code and Copilot CLI sessions**, which agents link themselves. The card shows whether the
  session is still running, and **Open in terminal** resumes it in its folder (or forks it, for Claude
  Code, when it is still running). Choose the terminal in **Settings → Integrations → Terminal**; **Copy resume command**
  works anywhere.
- **Any URL.**

In the task panel, sessions (T3 threads, Claude Code and Copilot CLI sessions, Autopilot's runs) have a
**Sessions** section of their own, above **Links**, which holds everything else: PRs first, then issues, tickets
and other URLs. Like the other sections, each can be collapsed, moved or hidden from **Customize sections**. Past
three sessions, **Show N more** reveals the rest. When the task has one T3 thread, its Claude Code sessions are in
the thread's ⌄ menu instead of rows of their own.

Failing checks, requested changes, blocked steps and requests from agents ("please review the plans") show up under
**Needs attention** in the sidebar. An agent's request stays until you press **Dismiss** in the task panel (or the
agent clears it).
Agents are told which ticket, T3 thread and session a task is still missing, so links tend to fill in on
their own.

## Fixing a PR

When a PR on a task has failing checks, a merge conflict or a review requesting changes, its row (in the task panel, and
on the card as a wrench) offers **Fix in** instead of **Merge**: pick **T3 Code thread…**, **Claude Code session…** or
**Copilot CLI session…**, or **Copy fix prompt** for any other agent. The usual launch dialog opens with the prompt
filled in with what is wrong and how to read it (the failed run's log, the review), ready to edit. The session works on
the PR's own branch: a Claude Code or Copilot CLI session in a new worktree on it (never your checkout), a T3 thread in a
new worktree that starts from it. It is told to push its commits to the PR's branch, to fix conflicts with a merge rather
than a rebase, and never to force-push, push to the default branch or merge. The session is linked to the task like any
other. While something needs fixing, **Merge** moves into the row's ⌄ menu.

With [Fix PRs](autopilot.md#fix-prs) on for the task, the row shows **Autopilot is fixing** while it works on the PR, and
**Autopilot gave up** once it has used its attempts; **Fix in** is in the ⌄ menu then, so you can still step in. PRs from
forks, merged and closed PRs and tasks in Done have no **Fix in**, as Autopilot skips them too.

## Labels

Tag tasks with the kind of work (`ui`, `backend`, `bug`) from the task panel, or let agents do it; they
are asked to suggest labels for tasks that have none. Filter the board by one or more labels. Each label
gets a colour you can change.

## Templates

Start a task from a template (Bug, Spike, Feature or your own) in New task, to pre-fill its description, labels and plan. See [Templates](templates.md).

## Blocking

A task can wait on others, in any project: open its panel, find **Relations** and **Add** a task under
**Blocked by** (or under **Blocks**, to make another task wait on this one). A blocked card shows a lock, and
hovering it names what it is waiting on. It is ready once every blocker is Done. Loops are refused.

Hover a card, or open one, to draw lines to the tasks it blocks (green) and is blocked by (red). Hold Shift to
draw the whole chain, with each step further away a little darker. Agents set blockers too and are told not to
start a blocked task.

## Suggested model

The agent that plans a task suggests a model tier (light, standard or deep) for implementing it. Say what
each tier means in **Settings → Model tiers**; copied prompts name it, and new T3 Code threads start on it. For
Claude Code and Copilot CLI you choose the model from the list the CLI gives (or type one the list doesn't have) and
how hard it thinks (its effort); new sessions and Autopilot's headless runs on that tier use both. **Rescan models**
asks the CLIs again after you update them.

The task panel's Details section shows the tier, the model you mapped to it and the planner's reason. Change
or clear the tier from the dropdown there; picking one drops the planner's reason.

## Autopilot flag

Each task has an **Autopilot** setting in the panel's Automation section: Default, On or Off. Autopilot only
starts tasks you flag On, so Default never starts one. When Start planned tasks is switched on for a
project, agents that plan a task ask you whether to flag it, and only set it after you answer. They can
flag tasks but never change Autopilot's own settings.

## Priority

Star a task on its card (the star shows when you hover it), choose **Mark as priority** in the panel's More menu, or turn on **Priority** in the panel's Automation section, and
it moves to a **Priority** lane at the top of the board, above every project, whatever you are filtering. The lane
shows priority tasks from all projects in their usual columns, each with its project's name; drag a card between
columns there to change its status (finished tasks go back to their own project), or onto its own project's lane to take it off the lane. Autopilot starts priority
tasks first. Turn the lane off in Settings → Board → Appearance; priority tasks then stay in their own lanes.

The pin button in the lane's header keeps it under the column headers while you scroll. Once you have scrolled
past the top, a pinned lane shows each card on one line (number, project, title and whether it has a PR, is blocked or
needs you), takes at most a share of the window and scrolls inside itself past that, so it doesn't push the rest of
the board out of view; scroll back to the top and it returns to normal. Choose how much of the window it may take
(Small 20%, Medium 30%, Large 45%) under **Pinned lane height** in Settings → Board → Appearance.

To see only what is in progress, tick **In progress, all projects** in the filter menu.

## Manual tasks

Some work isn't code: asking for access, getting a sign-off, a call to make. Turn on **Manual task** in the task
panel's Automation section, or with the switch under the description when you create a task from the command
palette, and the card gets a **Manual** badge. A manual task needs no plan, so you can drag it to any column, and
agents and Autopilot leave it alone: no hand-off menu, no review round, no Autopilot or auto-merge flag. It can
still sit in an epic and block a code task, and Autopilot still tells you when finishing it unblocks one. Agents
can add one too, say for something only you can do that their work waits on.

## Due dates

A task can have an optional due date: pick one in the panel's Details section (the **Due date** row; the **×** clears it).
It is only a date, with no time, reminders or notifications. A card shows it only when one is set, in muted text, amber on
the day and red once it has passed, using your computer's date. Done cards hide it. Epics don't have one. Agents can set
it with `update_task`, but only when you give them a date.

## Finding a task on the board

Open a task from search, the Needs attention list, a notification, a relation, an epic's tasks or a `#42` in a task's
text, and the board slides to its card and flashes it. A folded project or epic opens first. A card the filters hide is
not shown: the panel opens and your filters stay as they are. Clicking a card on the board never moves it. Turn the
sliding off in Settings → Board → Appearance (**Scroll to a task when opening it**); with reduced motion on in your
system, the board jumps instead.

To get back to the card of the task that is open, use **Jump to card** in the panel's header (also first in its **⋯**
menu, where the pin icon moves it in or out of the header) or press `J`. It always moves the board, whatever the
setting above says. If the card isn't on the board, a message says why: a filter may hide it (your filters stay as they
are), or it is archived and **Show archived** is off.

## Filters and saved views

The filter button in the board's top bar narrows the board by status, model tier, Autopilot flag, epic and labels
(each "any of" what you pick), and by switches for needs attention, has a PR, blocked, priority and archived. The
search box in the sidebar filters by title, `#number`, ticket key or label. While anything is filtered, a pill beside the
title says so, and its ✕ clears every filter.

To show only some of your projects, open the project menu beside the sidebar's search box and tick the ones you want;
the menu stays open while you tick, and **All projects** shows every project again. The sidebar's Projects list shows just the ticked ones. The
stats page has the same choice and starts from the projects you have ticked.

Every filter is part of the page's address, so you can bookmark or share a filtered board, and the browser's Back
button undoes a filter.

To keep a set of filters, choose **Save view…** in the filter menu (or the command palette) and name it. Saved views
list under **Views** in the sidebar: click one to apply it, hover to rename or delete it. The command palette and the
filter menu switch views too. Views are saved on the server, so they follow you to another browser, and they are
included in backups.

## Handing a task to an agent

Every open task has a hand-off menu. **Copy prompt** copies a ready-to-paste prompt for any agent
(Claude Code, Copilot, …), with a planning variant for tasks that have no plan yet. With [T3 Code](t3-code.md) paired,
**New T3 Code thread…** starts a thread for the task directly.

A task of an epic delivered through an integration branch (the branch button in the epic's panel; see
[Merge into epic branch](autopilot.md#merge-into-epic-branch)) is handed off to start from that branch: the prompt
says to open its pull request against it, and the T3 dialog opens on a new worktree from it.

When Claude Code or Copilot CLI is installed (on your PATH, or at the path set in **Settings → Integrations**),
**New Claude Code session…** and **New Copilot CLI session…** open the CLI in a terminal with the task's prompt
already typed in. The dialog lets you edit the prompt, switch to planning, pick a model (filled in from the task's
suggested tier, set in **Settings → Model tiers**) and choose where it runs: a new git worktree
from a branch you pick (the default), or the project's own folder. The board links the session to the task straight
away. On Windows Terminal, a task's sessions open as tabs of one window named after the task, and
opening a session that is still running brings that window back to the front. On Windows a prompt with a `%` in it,
or longer than about 8,000 characters, can't go on the command line: the session starts with a short pointer to the
task instead, and the full prompt is on your clipboard to paste.

## Planning several tasks at once

To plan a batch of tasks in one go, Ctrl-click (⌘-click on a Mac) their cards to pick them, then use **Plan tasks…**
in the project's lane header (the button shows how many are picked; Esc or a plain click drops the pick). Choose a new
T3 Code thread, a Claude Code or Copilot CLI session, or **Copy planning prompt**, tick the tasks you want in the list
(picked cards are already ticked), and continue. One agent then walks you through a plan for each task: it looks into
the code, shows you its draft and asks its questions, lets you approve simple tasks together and goes through bigger
ones one at a time, and saves each plan with its suggested model and labels. The thread or session is linked to every
task, and runs in the project's own folder since planning writes no code.

The agent follows the built-in planning skill. To use one of your own, pick it under **Settings → Tasks → Planning**,
or for one project on that project's settings page.

## Your layout

Collapse a column (Done starts collapsed) or just one project's cell, and collapse, reorder or hide the
sections of the task panel. Your layout is saved per browser.

## Keyboard

| Key          | Action               |
| ------------ | -------------------- |
| `Ctrl/Cmd K` | Command palette      |
| `Ctrl/Cmd ,` | [Settings](settings.md) |
| `N`          | New task             |
| `J`          | Jump to the open task's card on the board |
| `Esc`        | Close the task panel, or leave Settings or Stats |

These are the defaults. Change any of them, or say when one applies, under **Settings → Keybindings**
(it has a search box):
click a key and press the new combination, and use **Reset** (shown once a shortcut differs from its default) to go
back. Click the **When** line under a shortcut to edit its condition; it combines
`editableFocus` (typing in a text field), `popupFocus` (inside a menu or dialog), `overlayOpen`, `paletteOpen`,
`dialogOpen`, `settingsOpen`, `panelOpen` and `canGoBack` with `!`, `&&` and `||`. For example, `!editableFocus` on
the palette stops **Ctrl/Cmd K** from firing while you type in a description. Two commands on one key, where both can
apply at once, are flagged; the one listed later wins. Your changes are saved with the board's settings, so they
follow you to another browser and are in backups.
