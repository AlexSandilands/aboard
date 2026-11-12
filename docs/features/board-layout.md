# Board and panel layout

Board tasks: #54 (columns), #56 (panel sections), #58 (thread links on cards), #118 (Sessions section), #22 (priority lane), #207 (pinning it), #153 (sorting columns), #149 (the task window), #160 (choosing a section's window column).
The filters and saved views are in [saved-views.md](saved-views.md).

A board with many projects and a long Done column gets tall, and the task panel gets crowded. This doc
covers how the board and the panel decide what to show: collapsible columns, collapsible and reorderable
panel sections, column sorts, and which links a card shows. These are browser-only preferences: nothing here is stored
on the server (saved views, which are, are in [saved-views.md](saved-views.md)). It also covers Settings, a floating window over the board.

## How it works

A lane stacks its epic bands above its loose cards; how bands are laid out is in [epics.md](epics.md#on-the-board).
A finished epic has no band: it is one card in the lane's Done cell, so it counts as one card for the column
counts and the collapsed preview below. Bands and that card share a frame that tells epics from task cards, and
the task card's thread and session chips and start button ([epics.md](epics.md#on-the-board)).

### Card title height

Full task cards reserve two lines for their titles (`min-h-[2lh]` alongside `line-clamp-2`).
Titles can re-wrap as the panel or sidebar slides or the window narrows without changing the card
height and shifting the lanes below it. One-line titles keep the same reserved space. The header
has a fixed height and labels clip rather than wrap. Compact cards keep a single truncated title line.

### The priority lane

A task can be marked **priority** (`tasks.priority`, 0 or 1; epics can't be). The board gathers the priority tasks of
every project in a lane above the project lanes (`PriorityLane`, a `Lane` with `priority: true` whose project is the
stand-in `PRIORITY_PROJECT` and whose row id is `PRIORITY_ROW_ID`, "priority"). `buildLanes` does the gathering.

- **Membership.** Non-epic, non-archived priority tasks that aren't Done. A task that reaches Done goes back to its project's lane (it keeps the flag, so reopening it returns it to the lane), so the lane only holds open work and its Done column stays empty. They **move** into the lane: they aren't in their project's
  lane or its epic's band while it shows. An archived priority task (Show archived) stays in its project. The lane
  has no bands: a card of an epic shows the epic on the card as it does anywhere, and the epic's band loses it.
- **Filters.** A project scope (`?project=`) doesn't hide the lane, since it is for the tasks you want whatever you
  are looking at. The card filters (search, needs attention, has PR, labels, the epic filter, in progress only, and the
  status, tier, Autopilot, blocked and priority filters) apply
  to its cards like any other. A lane with no cards isn't built.
- **Off.** Settings → Board → Appearance → **Priority lane** (`showPriorityLane` in `board-view`, on by default).
  Off, priority tasks sit in their own lanes as any task.
- **Cards** name their project in a small chip. Order is by project (the board's order), then position.
  The cells count in the column headers like any lane's.
- **Setting it.** The star on a card (shown on hover, filled while set), **Mark as priority** in the panel's More menu,
  the Priority switch in the panel's Autopilot section, and `priority` on `create_task`, `add_to_backlog` and `update_task` (and REST). Agents set it only when asked.
- **Dragging** (`computeDrop`, `canDropIn` in `dnd.logic.ts`). A card in the lane moves between its columns, which
  changes its status. It takes no place in the column: positions only mean something inside one project's lane, and
  the server refuses a neighbour from another project. Dropped on its own project's lane (or its epic's band) it is
  placed there like any card and **stops being priority** (`PATCH priority: false`, sent once the move has landed so a
  refused move leaves the card in the lane, and applied to the cache at once). While the card is dragged its project's
  row, or its epic's band when the lane has one (`homeRowId`), is drawn in full so there is a place to drop it, unless its lane is collapsed, filtered out or not the scoped project, when
  the star is the way out. Other lanes refuse it. Cards from project lanes can't be dragged into the lane; use the star.
- **Dependency lines** work across the lane as anywhere; a related card that isn't shown gets its stub toward the lane
  as above the first project.
- **Pinning.** The pin button in the lane's header (`pinPriorityLane` in `board-view`, off by default) makes the lane
  `position: sticky` in the board's scroll box (`data-board-scroll`), under the column header (`top` is the header's
  height) and over the project lanes (z-4: under the header, z-10, and the dependency lines, z-5), with an opaque
  background. It is **stuck** once its top has scrolled past the header (`useStuck`, checked straight from the scroll
  event against a marker before the lane). Stuck, the lane gets `data-stuck` and a shadow, its cells scroll inside it,
  and its cards are `compact` (`BoardCell` → `SortableTaskCard` → `TaskCardContent`): one line with the number, the
  project's icon, the title, the Autopilot badge, the first PR chip, and the blocked and attention icons. It then folds
  up one pixel per pixel scrolled (`stuckHeight` in `stuck.logic.ts`) down to its settled height: `pinnedLaneHeight`
  (Small 20vh, Medium 30vh by default, Large 45vh; Settings → Board → Appearance → **Pinned lane height**, disabled
  while the lane is off), or its one-line cards if they take less. So its bottom stays on the first project's header
  and nothing jumps as it sticks, folds, unfolds or unsticks. A spacer after the lane takes up the height it gave up,
  set together with the lane's own height with nothing measured in between: if the lanes under it moved even for one
  layout, the browser's scroll anchoring would scroll the board to follow them (the lane, its marker and the spacer
  are `overflow-anchor: none` for the same reason). The full height is the last one seen unstuck, so tasks added or
  removed while stuck leave the fold off by that much until it unsticks. The lines re-measure on scroll (once per frame) while the lane is pinned, since
  its cards don't scroll with the content (`DependencyLines`' `pinnedLane`). `revealCard` treats the pinned lane's
  bottom as the top of the visible area for cards outside it, and scrolls the lane itself for a card inside it. Drags work
  in and out of a stuck lane as in an unpinned one, with two differences: the drag preview is one line, and the board
  doesn't auto-scroll while a card from the stuck lane is dragged (its top scroll zone would reach the lane itself and
  unstick it), so use the wheel to reach a lane out of view.
- **Autopilot** starts priority tasks first ([autopilot.md](autopilot.md#automations)).

### In progress, all projects

The filter menu's **In progress, all projects** (`?inprogress=true`) shows only In Progress cards,
across every project: it ignores a project scope while it is on (the scope returns when it is turned off, and choosing a project in the
sidebar turns it off). Epic
bands keep only their In Progress tasks, and the priority lane holds its In Progress ones.

### The sidebar's Projects list

The sidebar lists the projects in lane order: drag to reorder, click to scroll the board to a lane. While a project scope
is on ([saved-views.md](saved-views.md#the-project-scope)) it lists only the ticked projects, so a click always has a
lane to scroll to; In progress, all projects suspends the scope, and every project is listed again. Dragging in a short
list still saves the order of the whole board: the listed projects trade the places they already hold and the hidden ones
stay where they were (`moveAmongVisible`).
The scope itself is remembered across restarts, so the list is still narrowed after the app reopens.

### Collapsing columns

Every column header has a collapse toggle. A collapsed column shows the first five cards of each lane
(`COLUMN_PREVIEW_COUNT`); Done is newest-first, so that's the most recently finished. Done starts
collapsed.

- **Per project.** A cell with more cards than the preview gets a toggle row at its top that overrides
  the column for that project. The other cells in the lane keep a spacer so cards stay aligned.
- **Mixed state.** When a shown project differs from its column, the header shows a mixed state.
- **The header wins.** Pressing it sets the column for every project (collapsing it when mixed) and
  clears that column's overrides, including those of projects hidden by filters.
- A collapsed cell ends with **Show N more**, which expands that cell. A card dropped past a collapsed
  cell's preview expands the cell too, so it doesn't vanish.
- **Never hidden:** the selected card and the card being dragged stay visible past the preview
  (`visibleCellTasks`).

State is `collapsedColumns` (per status) plus `cellOverrides` (keyed by `cellKey(projectId, status)`).
An override equal to its column's setting is pruned, so any override present means the project differs.

### Sorting columns

Every column header has a sort menu beside its collapse toggle (`ColumnSortMenu` in `Board.tsx`). The orders are in
`columnSort.logic.ts`:

| Sort | Order |
| --- | --- |
| Manual | By position, the order cards are dragged into. The default for Backlog to Review; Done doesn't offer it. |
| Recently finished | Newest first by when cards entered the column (`statusChangedAt`). Done's default and only Done's. |
| Newest created, Oldest created | `createdAt` |
| Recently updated | `updatedAt`, newest first |
| Needs a plan first | Tasks with no plan steps first; epics and manual tasks need none, so they count as planned |
| Number, high to low / low to high | `number` |
| Due date | Soonest first; tasks without one last |

Every sort but Manual and Recently finished breaks ties by newest created, then by position. The defaults are exactly
the board's order before sorting existed.

- **Everywhere in the column.** `buildLanes` applies the column's sort to loose cells, epic bands and a finished
  epic's children. The priority lane stays grouped by project (in project order) and sorts within each.
- **The collapsed preview follows it.** The first five cards are the first five in the sort, so Newest created in
  Backlog keeps a new task in view while the column is collapsed. That was the request behind it (#153).
- **Highlighted when not the default.** The sort button turns `secondary` and its tooltip and `aria-label` name the
  sort ("Sort Backlog: Newest created").
- **Changing it slides the cards** (`snapshotCardRects`, then a `useBoardFlip` keyed on the sorts, since no board
  data changes).
- **Sorting never writes positions.** The server's order stays the hand-made one, and Manual brings it back.

Dragging (`sortedDrop` and `sortedLandingIndex` in `dnd.logic.ts`):

- **From another column into a sorted one,** the card lands in its sorted place whatever slot it is dropped on. The
  drag gap opens there, the move is sent with no neighbours (the server puts it at the end of the lane), and a
  collapsed cell expands when that place is past the preview. The card counts as just updated and just moved.
- **Within a sorted cell,** the user is choosing an order, which only Manual can show. The column switches to Manual,
  the move keeps the neighbours it was dropped between, and a toast says the column is back to manual order. The
  rest of the column returns to its hand-made order.

The choice is per column, per browser: `columnSorts` in the `board-view` store, holding only columns off their
default. It isn't in the URL or in saved views.

### Revealing a task

Opening a task from anywhere but a board card scrolls the board to its card. `useOpenTask` (`boardNavigation.ts`) sets a
reveal request in `useReveal` (`state/ui.ts`: `{ taskId, nonce, at, explicit }`, not persisted) once the navigation has landed;
`reveal: false` opts out, which the board's own card clicks do (`BoardContext.openTask`; `revealTask` is for a link on a
card that leads to another task). The request is made only when the `scrollToTask` appearance setting (browser-local,
on by default) is on.

The task panel's **Jump to card** action and the `j` shortcut (`task.reveal`) make an *explicit* request instead
(`useJumpToTask` in `boardNavigation.ts`, `requestReveal(taskId, { explicit: true })`): it ignores `scrollToTask`, and
when the card isn't on the board it says why in a toast (`revealHiddenMessage`: "The filters hide #N." for a task in the
board snapshot, else a neutral "This task isn't on the board" that points at Show archived, since a task missing from
the snapshot may be archived or just not loaded yet). Filters are never changed. Requests made when a task opens stay
silent. The action is `jump` in `PINNABLE_ACTIONS`: first in the More menu and pinned by default. It is offered for
archived tasks too: with Show archived on their card is on the board, and the reveal decides.

`BoardContent` acts on the request as the board changes, one step at a time (`revealStep` in `reveal.logic.ts`):
expand the project lane or folded epic band hiding the card (each once per request), wait for the task to be the open
one (which keeps its card in a collapsed column), then `revealCard` scrolls the board's scroll box to it. A card in no
lane (filtered out, archived) ends the request (`drop` with reason `hidden`): the panel opens, nothing scrolls, the
filters stay. A request nobody fulfils expires after `REVEAL_EXPIRY_MS` (`drop` with reason `expired`, always
silent). The decisions are `advanceReveal` (pure, tested). A request that ends is
cleared from the store (`consumeReveal`), so a board that remounts doesn't act on it again.

`revealScrollTarget` centres the card on each axis it isn't fully visible on, allowing for the sticky column header, and
leaves the other axis. The scroll is smooth (instant under `prefers-reduced-motion`), followed by one correction once it
settles (off-screen cards are laid out at an estimated height, and the panel may still be docking; if the card's node was
swapped meanwhile it aims at the fresh one, and if there is none it stops) and a fading ring on the card, drawn with the
Web Animations API because React would drop a class on re-render. `#N` in the panel's Markdown links through
`useTaskLinks` and the same path; the task panel builds them once (`PanelTaskLinksProvider`) and its rows read them with
`usePanelTaskLinks`.

### Card motion

`cardMotion.ts` holds all card animation. A card moved by an agent's `move_task` or any other event, by a status change
from the panel or by a rolled-back move slides to its new place, and so do the neighbours closing or opening the gap; a
card with no previous place fades in. It is a board-level FLIP:

- Right before a cache write that can move cards, `snapshotCardRects()` records the rects of the rendered
  `[data-task-card]` elements, relative to the board's scroll box. The writes that do: `task.*` and `project.*` events
  in `useBoardEvents` (only a task whose status, place, project, epic, priority, title or labels changed, see
  `eventMovesCards`) and the optimistic write in `useMoveTask`. Other direct writes (clearing the priority lane,
  collapsing or reordering lanes, a refetch) don't, and their cards jump. Writes in one burst share the first snapshot,
  which expires after 300 ms if no commit used it.
- `useBoardFlip(board)` in `BoardContent` runs in the commit that renders the new board, diffs the rects
  (`planCardMotion` in `cardMotion.logic.ts`, tested) and animates transform (or opacity, for a fade-in) with
  `element.animate`. A card with no new rect (collapsed column, filtered out), or off screen before and after, is
  skipped. Scrolling in between is compensated; if the scroll box itself resized (the task panel or sidebar sliding)
  nothing animates, since every card moved (the slide itself moves them, see
  [appearance.md](appearance.md#contrast-glass-panel-animations-and-fonts)). A card drawn twice (say an epic's child row beside its own card) has no
  single place to slide from and is left alone.
- It is off while a card is lifted: the drag overlay's drop animation lands the dropped card, and the drag preview has
  already put the neighbours in their final places. It is also off in a hidden tab and when `data-panel-animations`
  isn't `true` (Panel animations at 0, or `prefers-reduced-motion`). Otherwise the duration is the Panel animations
  setting times 1.75 (150 ms gives 263 ms) with the same ease-out as the drop.
- A rejected move calls `snapshotCardRects(taskId)`: that card's rect is the drop overlay's (it may still be
  landing), and the overlay hides so the card isn't shown twice.

### Task panel sections

The panel's sections are Labels, Sessions, Usage, Links, Relations, Automation, Local review, Autopilot, Plan, Details (description and plan context
together) and Activity. Each can be collapsed, reordered by dragging its handle, and hidden. A collapsed
section shows a one-line summary in its header (`summarizeSection`): the label names, the number of threads and sessions (folded ones included) and any thread that needs you, the cost, tokens and cache share, the link count and
any link problem, the blockers and what the task blocks, the automation settings that aren't at their default, open findings, the Autopilot run that needs attention, plan progress and the current step, the first line of the description (or of the
plan context), or the event count and how long ago the last one was.

That text is the fallback and what screen readers read. Where there is something to show, the section passes
`TaskSection` a rich `summary` instead (`SectionSummaries.tsx`), drawn beside the toggle rather than inside it so its
controls work on their own (clicking one never toggles or drags the section; the empty part of the header still
toggles):

| Section      | Rich summary                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| Labels       | Coloured label chips, 3 then `+N`                                                                                  |
| Sessions     | The card's chips: T3 thread buttons and harness-icon buttons with a status dot and their menu, one per expanded row (sessions folded into a thread stay in its menu), 4 then `+N`         |
| Usage        | The cost in a blue pill (the tokens when nothing had a price), then tokens and the cache share as text. "Not tracked" and "None" stay text |
| Links        | PR chips coloured by state with a checks dot, 3 then `+N` for the rest. Without a PR the text stays                |
| Relations    | `#N` chips, red for an open blocker, green once Done, outlined for what the task blocks; each opens its task       |
| Automation   | Text only                                                                                                          |
| Local review | The review badge                                                                                                   |
| Autopilot    | A **Needs attention** pill (warning or error colour) while a run still has a Dismiss in the open section (`summaryRun`), else the latest run's status |
| Plan         | The step bar (grey to-do, blue current, green done) with done/total and the current step                           |
| Details, Activity | Text only                                                                                                     |

**The attention icon.** A collapsed section that holds one of the task's attention reasons draws an `AttentionIcon`
(its severity's colour) right after the title, whether its summary is plain or rich, so a warning the rich summary
hides (a flagged Autopilot run reads "Done", PR and session chips carry no message) still shows. The message is the
toggle's tooltip and part of its accessible name. `SECTION_ATTENTION` in `sections.logic.ts` is the one rule for which
reasons belong where: Autopilot takes `autopilot`; Sessions `thread_needs_input` and `thread_failed`; Links
`pr_checks_failing`, `pr_changes_requested` and `pr_conflict`; Plan `blocked_step`; Local review `review_stalled`,
`review_stuck`, `review_failed` and `review_unattended`. `import_failed` and `agent_request` belong to no section: the
callouts at the top of the panel show them. `sectionAttention` picks the reason to show, an error before a warning, and
`summarizeSection` uses it too. An open section shows no icon (its content says it), and a collapse the user saved still
wins: the icon makes the warning visible, it never forces the section open.

Until the user chooses, sections collapse by content (`collapsedByDefault`):

| Section              | Starts collapsed when                             |
| -------------------- | ------------------------------------------------- |
| Labels, Plan         | Never: one row either way, and an empty plan is the prompt to write one |
| Sessions             | The task has no T3 threads or agent sessions      |
| Links                | The task has no PRs, issues, tickets or URLs      |
| Relations            | The task blocks nothing and is blocked by nothing ([relations](relations.md)) |
| Local review         | No review rounds                                  |
| Autopilot            | A task: never, the settings are its content. An epic (runs only): no run needs attention |
| Details              | No description and no plan context                |
| Activity             | Always: it's a log, not a summary                 |

A collapse choice is stored only when it differs from that default, so picking the default again lets
the smart default apply. **Collapse all** and **Expand all** store a choice for every section, which pins
them until **Reset**. The **Customize sections** popover in the panel's top bar reorders, shows and
hides sections, collapses or expands them all, and resets to the defaults. Stored layouts are
re-validated on read (`normalizeSectionLayout`): unknown ids are dropped and sections added later are
appended, except Sessions, which goes before Links in a layout saved without it (and takes its hidden and collapsed state from Links when that layout
had them, since it used to be part of Links). There was once a separate Automation section; it is part of Autopilot now,
so a saved layout that names it loses that id (its hidden and collapsed choice with it), and Autopilot keeps its own.

The Autopilot section (`AutopilotSection`) is where a task's Autopilot settings and runs are. Its first part is
`AutopilotFlags`, the task's automation settings (the old Automation section, #168, merged in by #125): **Autopilot
may** with three chips, **start it** (`autopilot`: whether Start planned tasks may start it), **review it** (`autoReview`:
whether moving to Review opens a local review round) and **merge it** (`autoMerge`: whether its PR may merge into the
default branch without the user: by `merge_task_pr`, or by Autopilot's Merge ready PRs with Into main on); **Reviewer** (the task's [reviewer model](local-review.md#the-reviewer-model) in the shared model picker:
Inherit, which names what the project's or board's comes down to, a tier, a custom model or a provider's model; shown
only while review is effectively on); a **Priority** switch; and **For a person** (the old Manual task switch). A chip is
on or off: the data keeps Default / On / Off, but off saves Default (null), which acts as Off for start and merge and
follows the board's Auto-review for review, so review is saved as an explicit On or Off only when it differs from the
board's setting (`automationUpdate`, `mayState`); an explicit Off already stored reads as off. Each change saves through
`useUpdateTask` at once. The actions menu's "Mark as priority" and the card's star stay as shortcuts to the same field.
Each control's hint is a tooltip and also its group's description, so screen readers read it. Local review's header only
shows whether auto-review is on, as plain text. A task for a person shows only Priority and For a person. An epic has no
flags (no plan to start, no PR, no priority), so its panel shows the section only once Autopilot has run on it, with the
runs alone.

Under the settings come the run notice and the task's Autopilot runs (status, automation and age with **Retry** on the
same line; what it did; runner, the thread and session as links, cost; and the error), or "Autopilot hasn't run on this task". The collapsed header reads what it may do
("May start, review · Priority", "Not automated", "For a person"; "Runs on this epic" for an epic), from the same chips
(`mayState`, so a task that follows the board's Auto-review counts review when the board has it on), or the attention
message when a run needs a look.

#### The due date

A task has an optional `tasks.due_date` (`YYYY-MM-DD` text, NULL for none; #84): a plain calendar date with no time or
timezone, validated by `DueDate` in contracts (a real date), and refused on epics. "Today" and "overdue" are the
**viewer's local date** (`localToday`, `dueState` from contracts compares the two), so nothing is stored per timezone and
there are no reminders, notifications, sort, filters or columns. The panel's Details section has a **Due date** row
(`DueDateField`: native date input, clear button, saved through `useUpdateTask`; an emptied input is ignored, the button
clears). The card shows a small chip in its meta row only when a date is set and the task isn't Done: muted, amber due
today, red overdue. A change logs `updated` with `fields: ["dueDate"]`. Agents set it with `update_task` (`dueDate`,
`null` clears) only when the user gives a date, and see it in `get_task` and `list_tasks` only when set.

#### The Sessions section

Sessions is a section of its own, above Links by default (`SessionsSection`). It holds what used to sit in a
Sessions group of the Links section (#111, split out by #118). A task with none shows "No coding sessions yet" and
starts collapsed.

- **Rows** (`groupLinks` in `links.logic.ts`): the task's T3 threads, needing attention first (`orderLinks`), then its
  agent sessions, newest first. When there are more than three rows (`SESSION_PREVIEW_COUNT`) the first three show,
  and **Show N more** expands the rest inline (**Show fewer** folds them again; the state is per panel visit, not
  stored).
- **Folded sessions.** A Claude Code session leaves the rows and sits in a thread's ⌄ menu, one submenu each (open,
  fork, copy the resume command, copy the id, remove), as the thread runs a Claude session underneath. Sessions don't
  say which thread they belong to, but an agent links its thread and its session together, so a session goes to the
  newest thread linked at or before it (by link creation time). A session linked before every thread goes to the
  oldest one, so a task with a single thread folds all of its Claude sessions.
  Autopilot's sessions (`isAutopilotSession`: their run's finished or failed status, or the
  runner's "Autopilot ·" name) and Copilot CLI sessions always stay rows.

#### The Links section

PRs, then issues, tickets and other URLs, each kind in link order (`groupLinks`). Its header has **Copy link**
and the list ends with **Add link**; pasting a T3 thread there still works, and the thread lands in Sessions.

Row labels in Links and Sessions (`PanelLabel`) are one line with an ellipsis. They clip on x (`overflow-x-clip`) instead of using `truncate`, whose `overflow: hidden` would turn the `overflow-y-visible` that keeps trimmed text from being cut into a scroll container. While a truncated label is hovered it pans to show its end, pauses, and jumps back (`label-pan` in `index.css`, distance from `labelPan` in `labelPan.logic.ts`); it stays still under `prefers-reduced-motion`.

### The task window

The open task can be shown in a large window over the board instead of the docked panel (`TaskWindow`, on the same
`AppRouteModal` shell as the Settings and Stats windows; it isn't tied to a route). The state is the URL:
`?task=<id>&expanded=true` on the board route (`BoardSearch.expanded`, not a filter param, so saved views don't hold
it). It isn't a preference: a task opened normally is docked, and a `#N` link followed inside the window stays in the
window (`withOpenTask` in `board/taskWindow.logic.ts`: an `expanded` left out keeps what the open task had). Closing the
task drops it (`withClosedTask`).

- **Ways in.** Double-click a card, Alt+click a card, **Open in window** in the shared task menu (the card's right-click
  menu and the panel's More menu, epics included; in the window's own menu it reads **Dock to the side**), the expand
  button at the end of the panel's top bar, and `panel.expand` (default `f`), a toggle for the open task. Nothing is
  added to the card. The two pointer gestures sit beside the Ctrl/⌘ pick in `boardSelection.logic.ts`
  (`cardClickOpens`): a plain click opens the docked panel at once, as before, and the second click of a double-click
  (`event.detail === 2`, no `dblclick`, so single clicks wait for nothing) expands the task the *first* click opened
  (Board remembers it by id), whichever card is under the pointer by then. While the board narrows for the panel its
  View Transition snapshot takes that second click, which lands on `<html>`; a window listener in `Board`
  (`useDoubleClickOutsideCards`) catches it there. Alt+click opens the window in one step; an Alt or repeated press
  starts no drag and selects no text (`isWindowPress`). Shift is left alone: holding it shows the full dependency
  chains. Some Linux window managers take Alt+click; double-click, the menu and `f` cover them.
- **Closing.** Esc (the `back` shortcut: `AppFrame` closes the window before the task), the dock button, `f`, a press
  on the backdrop and the browser's Back dock the task again; a second Esc closes it. The window's **×**, a delete and
  `panel.toggle` close the task (`closeTaskWindow`). Docking and closing play the window's out-animation first, then navigate. `j` (`task.reveal`) docks and jumps
  to the card.
- **Zoom.** The window grows out of the docked panel when that is open, otherwise out of the task's card, and shrinks
  back into the panel when it docks or onto the card when the task closes; with the card off screen it fades. It is
  the **Zoom windows from their source** setting ([appearance.md](appearance.md#window-zoom)). A task opened straight
  into the window starts no board transition: the board is at its new width at once, under the window.
- **One live panel.** `TaskPanelContent` renders in the window or in the docked aside, never both: it runs things
  once per task (`useTaskView`'s PR ping, the plan editor request). The aside stays mounted at its width with a
  placeholder, so the board doesn't reflow, and doesn't slide when the window opens or docks; a task opened straight
  into the window gets its aside in place, and one closed from the window doesn't slide a placeholder out. Moving
  between them remounts the contents, so the body starts again at the top; a field being edited is blurred first
  (and so saved) even when the window goes without closing, as on the browser's Back. Behind the
  Settings or Stats window the task window steps aside (one window at a time) and its contents go back to the aside
  until that window closes.
- **Layout.** From a window width of 56rem (`TWO_COLUMNS_FROM` in `TaskPanel.tsx`, measured with a ResizeObserver) the
  body is two columns: the title, callouts and where-it's-up-to (or an epic's tasks) then the main sections, and a
  21rem properties rail. `SECTION_COLUMNS` in `sections.logic.ts` is each section's default column (Plan, Details and
  Activity in the main column, the rest in the rail); the user can move any section to the other column, saved in the
  section layout's `columns`, which holds only the sections off their default (`sectionColumn`,
  `moveSectionToColumn`; unknown ids and values, and choices equal to the default, are dropped on read, and Reset
  clears them). The saved order, hidden and collapsed choices apply within each column, and each column is its own
  drag list in the window. The **Customize sections** popover lists the two columns as one drag area: a row dragged
  into the other list moves there as it crosses (at the row under the pointer, or into an empty list, which shows
  "Drag a section here"), and each row's **Move to side column / Move to main column** button sends it to the end of
  the other one, for the keyboard. With no shown section in one of the columns (every section moved, or the rest
  hidden), the window is one column instead of leaving an empty strip.
  The two columns are side-by-side scroll areas, so the rail's top is always in view and a tall rail scrolls on its
  own under the pointer, like the main column. The rail's border sits on its scroll area, outside the scroll fade, and
  both columns' scrollbars start at the header's bottom line (`COLUMN_SCROLLBAR_CLASS`), so nothing leaves a gap
  there; the rail's first section drops its own top hairline, which the header's line replaces. A section header whose
  actions are wider than the rail (Local review's) puts them on a line of their own, wrapped (`TaskSection`). Narrower, it is one column in the panel's saved order, one scroll area, and full screen on phones.
- **Either column.** The layout context (`useTaskLayout()` in `task/taskLayout.ts`) also says which column a part is
  in. A section in the rail reads at panel size (`useReadsLarge()` is false there): small Markdown, thumbnails. A
  section whose default is the rail stops at 34rem in the main column (`SectionFrame.capped`), so a row's ends (a
  session's status, the Add buttons) don't drift across the window; one column on a wide window counts as the main
  column.
- **Reading size.** Parts that read larger ask `useReadsLarge()`: in the window, outside the rail. The description and plan
  context render `Markdown size="md"` (15px, a 72ch measure, a real heading scale, roomier code and tables:
  `.markdown-md` in `index.css`) with pasted images in place ([attachments](attachments.md)), and their editors open
  taller (`MarkdownInput tall`). Step notes are body size at an 80ch measure, with larger screenshot thumbnails.

Fenced code blocks are syntax-highlighted wherever `Markdown` renders them, the docked panel included (`CodeBlock`):
`codeBlock.logic.ts` maps the fence's language to a parser, and `codeHighlight.ts`, loaded on first use, parses with
the CodeMirror languages the script editor already ships (JavaScript/TypeScript/JSX, JSON, Python, and legacy modes for
shell, PowerShell, YAML, TOML, SQL, CSS, Go, Rust, diff, C-likes and Dockerfile) and maps highlight tags to `.tok-*`
classes, coloured from theme tokens like the script editor. A block shows plain until the highlighter has loaded, and
stays plain for any other language.

### Autopilot on the board

Four things on the board show Autopilot, all from `BoardSnapshot.autopilot` (pause and the runs in flight,
kept live by `autopilot.changed`) and none of them shown while the catalogue has no automations. A fifth, the
[digest button](#digest-of-what-changed), is always there:

- **The lane's Autopilot pill**, after the lane's other header buttons (`AutopilotPill`). Off (no automation
  is on for the project) is dim; on and idle is a calm ring; paused is warning-coloured with a pause icon; while
  a run is going in the project a bright arc circles the border and a glow breathes behind it (`.autopilot-pill`
  in `index.css`; both animations are off under `prefers-reduced-motion`). A run still going counts as active
  even under Pause all. Clicking it opens a popover (`ScopePopover`) with a header ("Autopilot" and a cog button,
  tooltip "Autopilot settings", that closes it and opens Settings → Autopilot) and one row per automation, the compact
  form of the **Where it runs** widget in Settings ([autopilot.md](autopilot.md#the-ui)). Every row is a `WhereRow`
  (a `ScopeRow` in a `ScopeCard`): the name (its description is the name's tooltip), a muted line saying where the
  automation runs overall ("On everywhere except storefront", the widget's sentence from `describeWhere`) and an on/off
  switch for this project. The switch always shows what the automation does here, and a click saves the project's
  switch the way the widget's exceptions do (`scopeToggle`: an override only when the board gives something else, so
  turning it back leaves no row; there is no faded state or ↺). An automation in [Preview](autopilot.md#preview) here
  is on, with an amber **Preview** badge by its name. The rows read the same cached switches
  (`useAutopilotModes`, one request for every scope) and save with `useApplyWhere`, so the popover
  and the widget never disagree. An automation that can't be turned on (`blocked`, an empty required tool slot)
  shows a ⚠ with the reason as its tooltip and its switch can only be turned off. An automation with no switch
  (`alwaysOn`: Recurring tasks, whose rules have their own) isn't listed. Paused is a one-line `Alert` with a **Resume** button
  (`PausedNotice`). A row waits behind a skeleton until the switches and the board have loaded (a failed load shows
  its error instead), so no switch shows a made-up Off, and a long list scrolls in a `ScrollArea`.
  - **Orchestrate** is pinned above, in a card of its own (`OrchestrateSection`): its row, then one line with
    "Next check in 12:34" (hover it for the latest run, `lastRunText`) ticking every second (`useNow`; the slot is counted in the browser with
    `nextMinutesSlot`), or instead why no check is coming (`orchestrateLine`: running, run requested, off, paused, quiet
    hours until their end, today's cap, idle), beside a **History** button (`RunHistoryLink`, not marked as opened from
    Settings) that opens the run history page filtered to the project and a **▶ Run now** button
    (`useRunOrchestrateNow`; disabled with a spinner while a run is going or asked for, a refusal is a toast with the
    server's reason). It reads `useOrchestrateState`, refetched on
    `autopilot.changed`, on task changes and every minute. Epic popovers don't have it (Orchestrate has no epic scope).
    The rest of the automations follow under an "Automations" label.
  - **The pill's countdown.** While Orchestrate is on in the project the pill reads `Autopilot · 12m`
    (`pillTimerAt`, `formatPillCountdown`): only when a slot would run, so not while paused, while its run is going,
    with nothing to look at (`useProjectHasOrchestrateWork`, from the snapshot with the server's rule) or in quiet hours
    at the slot. The daily caps are left to the popover. One display preference, `showAutopilotTimer` in
    `useBoardView` (default on), is switched in Settings → Appearance (**Autopilot countdown on lanes**,
    `board.appearance.autopilot-countdown`; the old `autopilot.engine.orchestrate.countdown` target redirects there).
- **The epic's Autopilot button** (`AutopilotEpicButton`), a small circle at the end of the epic band's header and
  in the epic panel's top bar. It has the pill's four states and the same sweep (it wears `.autopilot-pill`, so
  reduced motion is respected), animates while a run on one of the epic's tasks is going (`epicId` on the active
  run), and opens the same popover (`ScopePopover`) for the epic, whose rows switch the epic against its project (a row's
  line is the widget's sentence, so "epic #5 Off" shows when it is). The epic's delivery control is a card of its own below the automations. Automations with `epicScope: false` (Digest) aren't listed and don't count. Off means nothing is on for the epic's
  tasks, whether the epic or its project says so. It isn't shown for an archived epic.
- **The header's pause button** (`PauseAllButton`): Pause all, which turns into a labelled "Autopilot paused ·
  Resume" while set.
- **A card badge** (`AutopilotBadge`) with a spinner while a run is working on the task.

### Digest of what changed

The digest (what it makes is in [autopilot.md](autopilot.md#automations)) has a button in the header, between the
pause button and the notifications bell (`DigestButton`). It is always shown, since "Generate now" works with the
automation off. A dot marks unread digests (with screen-reader text "Digest of what changed, N unread"), and the
icon becomes a spinner while a run of the `digest` automation is active; it stays clickable then, so older digests
can still be read. It opens the panel (`DigestDialog`, opened by `digestOpen` in `useDialogs`):

- The newest digest: its period in local time, a badge for Plain or Summarised, whether it was made on the schedule
  or on request, the cost when there is one, and the `note` (why a summary came out plain) as a muted line. The
  body is Markdown through the app's shared `Markdown` component with `taskLinks`: a `#N` that is a task on the
  board becomes a link that closes the panel and opens the task (`taskRefs.logic.ts`, a remark plugin that skips
  code and existing links; an archived task isn't on the snapshot, so its number stays text).
- Older and Newer buttons and a select (the last 30, unread ones marked) in the footer. Opening the panel marks the
  digest on screen read, and browsing to another marks that one; only the one being looked at is marked.
- **Generate now** makes a digest; it is disabled while an agent is writing one, which shows as an info alert. A 409
  shows a toast. The command palette's **Autopilot: digest now** opens the panel and generates.

The list is a query (`useDigests`, `state/digests.ts`) refetched on every `autopilot.changed` and on reconnect.

### Dependency lines

Hovering a card, or opening one, draws lines to the cards it blocks and is blocked by; Shift shows the whole
chain. The overlay and its rules are in [relations.md](relations.md#on-the-board).

### Links on cards

The card's link row shows PRs and **active** T3 threads, in the panel's order (`cardLinks`). A thread
with no snapshot yet counts as active, since it may be. The first ticket key shows as a badge in the card's
top row. Settled and archived threads, other ticket keys and plain URLs appear in the panel only, where
inactive threads are dimmed.

### The card menu

Right-click, the Menu key or Shift+F10 on a card (or an epic's header, in its band or as a finished epic's card) opens its menu: **Move to**
(the statuses, through `useSetTaskStatus`, so the plan gate still opens the plan editor; not offered for an epic, whose
status follows its tasks), the **Turn Autopilot / auto-merge / auto-review on / off** items (`AutomationMenuItems`;
see below), then the panel's More menu without **Jump to card** (the card is in view; a click opens it), which starts
with **Open in window** ([the task window](#the-task-window)). The two share their items (`TaskMenuItems` in `components/task`),
which take a `TaskSummary`, since a card has no more; **Save as template…** fetches the task's detail when picked
(`fetchTaskDetail`). Pin toggles are the panel's only. `CardContextMenu` wraps the card in a `ContextMenu`
(`components/ui/context-menu.tsx`, Base UI) whose trigger draws no box (`display: contents`) and whose items mount only
while the menu is open. The close-as and delete dialogs are app-level (`TaskMenuDialogs`, driven by
`useDialogs.closeTaskAs` and `deleteTask`), because the menu is gone by the time they show. **Delete…** is the last item,
set apart, on every task; the bulk menu ends with **Delete N tasks…** ([task-lifecycle](task-lifecycle.md#deleting)). A right-click starts no drag
(dnd-kit's `PointerSensor` takes the primary button only), opens no panel and leaves the pick alone.

With two or more cards picked (Ctrl/⌘-click, any task card; see [agent-handoff.md](agent-handoff.md#plan-tasks-several-tasks-at-once)),
right-clicking a **picked** card opens the bulk menu, headed "N tasks"; right-clicking an unpicked card opens its own.
Each item applies to the picked cards it fits (`bulkMenu.logic.ts`) and is left out when it fits none, so a mixed pick
offers both **Mark as priority** and **Remove priority** while a uniform one offers only the one that does something:

- **Move to**: skips epics, archived cards and cards already there, and refuses planless cards outside Backlog like the
  server does (shown as "N without a plan" beside the status, and counted as skipped in the toast).
- **Mark as priority / Remove priority**, **Archive / Unarchive**.
- **Turn Autopilot / auto-merge / auto-review on / off** (`AutomationMenuItems`, the same component the single-card
  menu uses with one card): skips epics, manual and archived cards, like the panel's Autopilot section. Autopilot and
  auto-merge compare `=== true` and Off clears the flag to Default (it behaves like Off, and the panel keeps reading
  "Default"). Auto-review compares the effective value (`task.autoReview ?? settings.autoReview`) and Off writes
  `false`, because clearing to Default would leave it on while the board's setting is on.
- **Close as**: **Won't do**, or **Done by another task…**, which opens the close dialog for all of them against one
  task. Duplicate needs a task per card, so it is single-card only.
- **Labels**: add (a find-or-create field and the labels in use) or remove one label.
- **Copy references** (`#14, #16, #26`), and **Plan with an agent**, the lane's planning menu for the picked cards that
  a planning session can take (one entry per project when they span several).

Actions run the existing mutations once per card (`useBulkActions`), so optimistic moves and their rollback still work,
and end in one summary toast ("Moved 2 tasks to Review, 1 skipped (no plan)"). The pick stays until a plain click or Esc.

### The settings page

Settings is a floating window over the board, and still a route: `/settings/<group>` with group `board`, `keybindings`, `tasks`, `agents`, `autopilot`,
`integrations` or `project` (`/settings` and unknown groups redirect to `board`). `agents` is one page
(`agents/AgentsPage.tsx`) with three sections, the first two on the same split card (`agents/SplitCard.tsx`: a list on
the left and the selected item's settings on the right, side by side from a 48rem container and stacked below it), so
providers, tiers and custom models are each a row in a list, however many there are:

- **Providers** (`agents.providers`, `agents/ProvidersSection.tsx`, after T3 Code's provider settings): the added
  providers on the left (a dot, the version, an on/off switch and **Add provider**) and the selected one's editor on
  the right (`ProviderEditors.tsx`: Status, Connection, MCP & skill, Hand-off menu, Models). The selected provider is
  `?provider=`, and an `agents.providers.<id>.<row>` target selects `<id>`. Before any provider is added the page is
  one empty card with **Add provider** (which lists them all), and the sidebar shows only Providers
  (`visibleSections`).
- **Models** (`agents.models`, `agents/ModelsSection.tsx`): the tiers, then the custom models, on the left
  (`agents.models.tiers.<tier>`, `agents.models.custom.<id>`), each with its description or the models it runs
  (`modelSummary`); **Add model** adds a custom model. On the right: the description (and a custom model's name and
  labels), one row per provider added and switched on with its model and effort in the shared model picker (T3 Code's
  in `agents/T3TierPicker.tsx`, which adds a **Default model** row), and **Preferred provider**, the CLI headless runs
  on the tier try first (`ModelTierSetting.provider`), left out with fewer than two CLIs. **Rescan models** asks the
  CLIs again. Which item a target names and what the list says is `agents/agents.logic.ts`.
- **Operations** (`agents.operations`, `agents/OperationsSection.tsx`): the board's model for each operation in
  `OPERATIONS`, in cards for Review, Autopilot and Board tools (`OPERATION_GROUPS`, `operations.logic.ts`), a row each
  (`agents.operations.<op>`), whose one line is what it resolves to, with what the operation is behind its ⓘ. The picker offers **Default** (nothing saved: the operation's default), the task's own
  model where that differs from the default (saved as `inherit`), the tiers, the custom models and any provider's
  model. The line under it is the resolver run in the browser (`resolvesTo`): what runs it now and why, the resolver's
  notes, or why nothing can. With no CLI provider added and switched on (`activeProviderIds`) nothing can run, so the
  rows are dimmed and inert under one notice instead of each carrying the same reason.

Board has one section that only exists in the desktop app: **Desktop app** (`board.desktop`,
`components/desktop/DesktopAppSection.tsx`), the app's version with its update status and **Check now** /
**Restart to update** / **Release notes**, and **Check for updates automatically**. `visibleSections` leaves it out
of the sidebar, and `SettingsSearch` out of the results, in a browser (`DESKTOP_ONLY_SECTIONS`). How updates work:
[desktop](desktop.md#updates).

Models and Operations show only once a provider is added.

`autopilot` is three tabs, each a sidebar section with a path of its own: **Automations** (`autopilot.automations`,
`/settings/autopilot`: a status strip, Needs you, and every automation on the same split card, `?automation=`
picking one), **Runs** (`autopilot.runs`, the run history at `/settings/autopilot/runs/<automation>`) and **Limits &
safety** (`autopilot.limits`, `/settings/autopilot/limits`). A target on Runs or Limits navigates to that path
(`autopilotTabOf`), and the two count as pages, not editors (`isEditorPath`), so Esc leaves Settings from them. The
split card takes `detailOpen` there: under 48rem it shows the list or the detail, not both, and the detail has an
**All automations** link back (`SplitBack`). What the tabs hold is in [autopilot.md](autopilot.md#the-ui). The old
page's targets (`autopilot.engine…`, `autopilot.custom…`) redirect to where they are now.

`integrations` keeps GitHub, Ticket systems and Terminal.
Old targets and URLs are read as they are now (`redirectSettingsTarget`, applied by `parseSettingsTarget` and the
route's `beforeLoad`): `integrations.<provider>…` and `providers.…` go to `agents.providers.…`, and `models.tiers…`,
`models.custom…` and `models.operations…` to their place on Agents (`MOVED_TO_AGENTS`).

The reviewer and issue-import models live only under Operations: their
old rows in Tasks show one line of what they resolve to with a **Change** link (`OperationModelLink`). Targets from
before the page (`models.tiers.custom*`, `tasks.review.model`, `tasks.new-tasks.import-model`) redirect to where they
are now (`MOVED_TARGETS`). The editors are sub-routes: `tasks/templates/<id>`, `autopilot/custom/<id>` and
`project/recurring/<id>`, with `new` for one not saved yet. The rule editor's path stays under `project/` for old
links, but its crumbs and the rail say Autopilot and leaving it returns to the Recurring tasks automation
(`editorListSection("project")`). Its `?project=` is the rule's project.

#### The project scope

Only the **Projects** page (group id `project`, kept so `/settings/project…` links still work) has a project scope,
after T3 Code's (`SettingsScope.tsx`, ported from its `SettingsScopeSentence.tsx`; only the project axis, the board
has no environments): **Settings for [All projects ▾]** at its top (`SCOPED_GROUPS` in `settingsScope.logic.ts`;
`SettingsScroller` renders it there, not on editors). The picker (`ProjectPicker`) is a menu up to six projects and a
combobox with a search box past that. The scope is `?project=`, which `settingsRoute` validates for every settings
route: `useOpenSettings` keeps the current one only for a move within the Projects page (`project: null` is All
projects), opening from the board starts in All projects unless a project is passed (a project's gear or
right-click in the sidebar). An unknown or archived id reads as All projects (`scopeProject`). The board behind the
window reads its own search from `boardReturn`, so the settings `?project=` never reaches it. The run history's
**Project** filter is the runs route's own `?project=`: nothing carries it to or from other pages.

The page shows the scope's project, or a prompt to pick one in All projects: General (name, icon, folder, T3 link),
**This project's overrides** (`project.overrides`) and Danger zone. Archiving or deleting it sets the scope back to All
projects. The overrides are the project fields that beat the board's, each row with an **Overridden for this
project** badge and a reset to the board's while one is set (`override` on `SettingsRow`):

| Row | Project field | The board's row |
| --- | --- | --- |
| Planning skill (`project.overrides.plan-skill`) | `planSkill`, the project's folder skills listed first | Tasks › Planning skill |
| Review skill (`project.overrides.review-skill`) | `reviewSkill` | Tasks › Review skill |
| Reviewer model (`project.overrides.reviewer`) | `reviewModel`, both reviewers' resolves-to lines | Agents › Operations › Reviewer |

Every other page shows only the board's values. A board row some projects override has an **Overridden in N
projects** line (`OverriddenInProjects`, fed by `useOverridingProjects(field)`, a board `select` so it re-renders only
when that list changes): with one project a link to its row on the Projects page, with several a menu of them. On
Autopilot, what a project sets for itself has its own picker inside the section, in local state rather than the URL
(an old link's `?project=` only picks its first value):
Limits & safety › Variables (`variables`, the board's shown as inherited) and the Recurring tasks detail (that
project's rules and the example rules). Where an automation runs per project is its Where it runs table.

Old targets still land: the Project page's sections from before #151 (`project.plan-skill`, `project.review-skill`,
`project.models` and their rows) redirect to `project.overrides…` (`MOVED_TARGETS`), and `project.autopilot…` and
`project.recurring…` to Autopilot. A link from when Tasks, Agents and Autopilot had the scope, to one of the three
board rows above with `?project=`, goes to that project's row on the Projects page (`redirectSettingsTarget(target,
project)`, applied by the route's `beforeLoad` and `useOpenSettings`), and the router keeps `?project=` on every
redirect.

- **Shell.** Every page sits under one pathless layout route (`_app`, `AppFrame`) that renders a single `AppShell`:
  the resizable projects sidebar (an off-canvas sheet on narrow windows), the palette, the app dialogs, live sync and
  the shortcuts. `AppFrame` also renders the board itself (`AppLayout`), on `/` and on the window paths (`/settings…`
  and `/stats`, `isAppModalPath` in `layout/appModal.logic.ts`), so the board, its scroll, its open task panel and the
  event stream survive opening and closing a window. The board route has no component of its own. Only `/social` is a
  page that takes the board's place.
- **The window.** `AppRouteModal` (`layout/AppRouteModal.tsx`, after T3 Code's) is a Base UI dialog the route
  component renders itself in: at most 80rem by 60rem, full screen below `sm`, over the dialog backdrop. Settings and
  Stats use it, and it is meant for other route windows too. The close button and a press on the backdrop close it
  (a text selection that ends on the backdrop doesn't, and nor does any press while `backdropDismisses` is false,
  which Settings sets on an editor sub-page so a stray press can't drop a half-filled form); it blurs the focused field first, so commit-on-blur fields
  save, animates out and then calls `onClosed`, which navigates to the board (`useLeaveWindow`). It fades and scales
  only while Panel animations is on (`data-panel-animations` on `<html>`, which has reduced motion resolved).
  While a window is open `AppShell` makes the sidebar and the main area `inert`, and a sidebar sheet left open by the
  pick that opened the window is closed (`CloseSheetOnWindow`).
- **Esc.** The dialog's own Escape handling is cancelled. Esc is the `back` shortcut as everywhere else, so it can be
  rebound and yields to whatever nearer the focus claims it (a menu or dialog over the window, the shortcut recorder,
  a non-empty search box, a text field). In Settings it leaves an editor for its page and closes the window from a
  page (`useSettingsBack`); in Stats it closes the window. `closeAppWindow()` is what it calls.
- **The board behind.** A window's URL carries its own search (`?project=` is the project being configured, or the
  stats page's projects), so the board must not read it. `useBoardSearch` (`board/boardNavigation.ts`) reads the board
  route's own match on `/` (its validated search, not the layout route's raw one) and `useSettingsNav.boardReturn`
  anywhere else; `AppLayout` saves `boardReturn` while on `/`. Every board
  hook (`useSelectedTaskId`, `useProjectFilter`, the filters) goes through it, so the board behind a window shows
  exactly what it showed, open panel included. When the app starts in a window (a reload, a link), `main.tsx` seeds
  `boardReturn` with the remembered project scope, and closing the window goes to the board with it.
- **The rail.** The settings list is a rail inside the window (`SettingsRail` in `SettingsShell.tsx`): the search
  box, then every group with its sections, always expanded; the page shown is scrolled into view. The app sidebar
  stays the projects list. Below `md` the rail is a strip of the groups' icons with a search button; searching
  spreads it over the page with the full list, until a pick, Esc in the empty box, or the box's close button.
- **The header.** `SettingsTopBar` is the window's header: the breadcrumb, the page's actions and the close button.
  It is not a drag region.
- **Ids.** `SETTINGS_GROUPS` (`settingsNav.logic.ts`) lists the groups and their sections. A section's id is
  `<group>.<section>` (`tasks.review`); the groups and rows inside carry `<group>.<section>.<row>` ids
  (`providers.claude-code.cli-path`). The ids are element ids and URL hashes, and are stable: settings search
  targets them.
- **Rows.** The column is `max-w-4xl` (as T3's readable page width). A `SettingsRow` (`settingsLayout.tsx`) is a
  title, at most one short line of description (or none when the title says it), and the control on the right.
  Anything longer goes in `info`, an `InfoHover` button beside the title that opens a popover on hover, click or Enter
  (setup steps, how Jira tools are matched, what a CLI path is used for). Status details (Found / version /
  path, Registered / scope, Connected) go in `status`, a compact line under the description built with
  `StatusLine`, so they never squeeze beside the control. The search index has its own descriptions and keywords,
  so text moved behind an info button is still found. A setting with a default can pass `resetAction`: a
  `SettingResetButton` beside the title, shown while the value differs from the default (the Appearance sliders and
  fonts, see [appearance.md](appearance.md)).
- **Leaving.** Navigations to the board from a window (opening a task from the palette or a notification) build on
  `boardReturn` rather than the window's search (`boardSearchFrom`), so `?project=` doesn't leak onto the board. They
  unmount the window at once; only its own close animates.
- **Getting there.** `useOpenSettings()(target, { project })` takes a group, section or row id, navigates with the
  anchor as the hash and asks the page to scroll to it (`requestScroll`). The page (`SettingsScroller`) waits up to
  about two seconds for the target to render and opens a folded section that holds it. On a page that has just
  opened, sections are still filling in as their queries load, so the target stays pinned to the top until that
  settles (`pinInView`, about 1.5 s, or until the user scrolls). A request counts as handled only then, so the page
  being left, which sees the request first, leaves it for the page being opened. A reload honours the hash.
- **Search.** `SettingsSearch` sits between the brand row and the list. `settingsIndex()`
  (`settingsIndex.logic.ts`) is the index it searches, and the settings Ask sends: every sub-section (from
  `SETTINGS_GROUPS`), card and row with its title, description, keywords, group, sub-section and `foldedIn` (the
  folded section to open, for the built-in automations). Notification kinds and model tiers are generated from
  their contracts; the rest is written by hand, since the rows are JSX. `settingsIndex.logic.test.ts` scans the
  component sources for rendered ids and fails on a row without an entry, or an entry without a row. Only
  per-GitHub-host rows (`DYNAMIC_ROW_PREFIXES`) go unlisted. A new setting therefore needs an entry in `WRITTEN`
  there. `searchSettings` (`settingsSearch.logic.ts`) needs every word to match and ranks by the worst word's best
  field: title (exact, prefix, word start, contains), keyword, group or sub-section name, description. `/` and
  Ctrl/Cmd+F focus the box (`isSearchShortcut`). A pick calls `useOpenSettings` with `highlight`, which
  `requestScroll` carries to `SettingsScroller`; it scrolls, `FoldedSettingsSection` opens when the id is its own or
  under it, and `flashElement` adds `.settings-flash` for 1.6 s, once a smooth jump has landed (`afterScroll`). Picking a
  sub-section only scrolls. A row that isn't rendered (the issue import's model with import off) falls back to the nearest id that is,
  dropping trailing segments (`nearestRendered`): after about a third of a second for a pick within a loaded page, after
  the two-second wait for a page that is still opening. A URL hash never falls back. The index's titles
  may be more specific than the rendered label ("Backup interval" for "Every"); the rendered label goes in its
  keywords.
- **Ask.** The first option of the results is "Ask: <question>" (`SettingsAskRow.tsx`), which puts the typed
  question to Claude Code. It starts highlighted when `looksLikeQuestion` says the text is one (a `?`, or a question
  word and at least four words), else the best result is. `POST /api/settings/ask` (`integrations/settingsAsk.ts`)
  takes the question and the index as `askEntries` sends it, since the web app owns the index. It runs `claude -p`
  through the shared headless runner (`agentArgs` with `access: "none"`, the Claude Code provider's CLI path, `harnessCliSetting`) on
  the Ask operation's model (the light tier unless set; `resolveOperationModel`, which refuses with the reason when no
  added provider can return structured output with no tools), with a $0.05 budget and a 60 s timeout, in an empty temp folder, and asks for `{ settingId | null,
  answer }`. The question and the index are fenced as data with a random fence. A `settingId` that isn't one of the
  request's ids becomes null (the answer stays). Only one question runs at a time (the page discards an edited pending question but can't stop its run), so a second
  one meanwhile gets "Another question is still being answered". A failed run, a timeout or an answer of the wrong shape comes back
  as `{ ok: false, error }` with status 200, so the row can show the message. The row holds the
  whole exchange: thinking, then the answer with **Go there** (the same jump and highlight as a result), or the
  error with "Click to try again". `askUnavailableReason` says whether it can run, from the
  providers list and `GET /api/providers` (Claude Code added, on, and its CLI found; not whether it is signed in, which
  shows as the run's error); when it can't, the row is disabled with the reason and **Set up Claude Code**, which
  opens `providers.claude-code.cli-path`. Copilot as a second engine isn't built.
- **Scroll-spy.** `SettingsScroller` reads the tops of the `SettingsSubsection` anchors on scroll and resize, and
  `activeSectionId` picks the last whose top has passed a line near the top (the last one when scrolled to the
  bottom). The list highlights that section.
- **Ways in.** The sidebar gear, Ctrl/Cmd+, (`settings.open`), the palette's "Settings: <group or section>"
  entries (sections only once a query is typed), a project's gear or right-click (project page), and the Autopilot
  popover (its settings cog).
- **Editors.** `EditorFrame`'s parts render the template, custom automation and rule editors as a dialog by
  default and as page blocks inside `EditorPage`, so Save as template keeps its dialog. Cancel, Save and Esc all
  leave an editor for the section listing what it edits (`editorListSection`, `useLeaveEditor`): opened from that
  list (the `settingsEditorFromList` history state), it steps back in history, so the browser's Back doesn't
  repeat the page; opened from a link or a reload, it opens the list as a new entry.

### The model picker

Every model control is one picker (`components/models/`), ported from T3 Code's composer picker
(`ProviderModelPicker`, `ModelPickerContent`, `ModelPickerSidebar`, `ModelListRow`, `modelPickerSearch`, and the
effort column of `ComposerModelEffort`). A trigger opens a popup with a rail of tabs (a Base UI `Toolbar`), a search
over a virtualised list (`LegendList` inside a Base UI `Combobox`), and an effort column docked beside them.

- **Adapters.** `ModelChoicePicker` picks a `ModelChoice` for an operation: a **Tiers and custom models** tab (inherit
  with what it comes down to, each tier and custom model with what it resolves to for the operation), then one tab per
  added CLI with the models `/api/agent-models` lists. `CliModelPicker` is the same locked to one CLI, with **Default
  model** first (the tier cells, the session and planning dialogs). `T3ModelPicker` lists T3 Code's catalog,
  Favorites first, legacy models folded under **Show more**, with the model's reasoning levels and fast mode in the
  column (a tier's T3 Code cell, the T3 launch dialog).
- **Greyed providers.** A provider that isn't added, is switched off, or can't do what the operation needs
  (`missingNeeds` over `OPERATIONS[op].needs`) is greyed out in the rail, its reason in a tooltip and on its rows
  (`providerDisabledReason`). Each tab's footer links to that provider's settings and says when its scan failed.
- **Typing.** A search that is a valid model name and isn't listed is offered as **Use `<model>`** on each CLI that can
  run it (only the open tab's when a CLI's tab is open), so a model the scan doesn't list and a failed scan still work.
- **Defaults.** When the scan says which model the CLI runs with none given (Codex's `isDefault`), the **Default
  model** row names it ("GPT-6.1-Sol, unless Codex is set to another": the CLI's own config can pick another), and the effort
  column's **Default** names the level the model runs at (`defaultEffort`).
- **Effort.** Picking a model with levels keeps the popup open and moves focus to the column; a tier, inherit, or a
  model with no levels closes it. A saved level the new model doesn't take is dropped.
- **Keys.** Left from an empty search goes to the rail, Right at its end to the column, Ctrl+[ and Ctrl+] change tab,
  Enter picks the highlighted row.

### Keyboard shortcuts

The app-wide shortcuts are a registry in `packages/contracts/src/keybindings.ts`: each command (`palette.open`,
`idea.new`, `settings.open`, `back`, `task.reveal`, `sidebar.toggle`, `panel.toggle`, `panel.expand`, `task.delete`) has a title, a group, a default key and a default `when`. Shaped like T3
Code's keybindings: a command, a key and a `when`, and when several match a key event the later one wins.

- **Keys.** `mod+k`, `shift+n`, `escape`: lowercase modifiers (`mod` is Cmd on macOS and Ctrl elsewhere, plus
  `shift` and `alt`), then one key. The space and plus keys are `space` and `plus`. The match is exact: extra
  modifiers don't match (`matchesShortcut` in `layout/keyboard.logic.ts`). With Alt held, a letter or digit is read
  from the physical key (`event.code`), since macOS's Option turns `b` into `∫`.
- **`when`.** An expression over the context flags with `!`, `&&`, `||` and parentheses (`!` binds tightest, `||`
  loosest); empty means always. The flags (`KEYBINDING_CONTEXT_KEYS`) are `editableFocus`, `popupFocus`,
  `overlayOpen`, `paletteOpen`, `dialogOpen`, `settingsOpen`, `panelOpen`, `cardFocus` (a board card has focus) and
  `canGoBack`; `AppShell` builds them per
  key event (`overlayOpen` is the palette or the digest, as it always was; `dialogOpen` is any app dialog, via
  `anyDialogOpen`). The Settings and Stats windows are dialogs in the DOM but not for these flags: `popupFocus`
  (`isInsidePopup`) skips `[data-app-modal]`, and `dialogOpen` only counts the app dialogs, so the pages inside take
  shortcuts as a page does. `settingsOpen` is the Settings window, `panelOpen` is the task panel on the board (false
  while a window covers it), and `settings.open` in Settings closes the window (not from an editor sub-page). `panel.toggle` does nothing while a
  window is open. `panelOpen` stays true in the task window (it is on the board), so `j`, `f` and Delete work there. An unknown name is a parse error (`parseWhen`), so the server refuses it on save. The defaults are the old
  hard-coded behaviour, e.g. `n` is `!overlayOpen && !editableFocus && !popupFocus`.
- **Overrides.** The setting `keybindings` holds only what the user changed, per command: `{ key?, when? }` (an empty
  `when` means always). A command left out always follows the current default, so a default added or changed later
  reaches everyone who didn't customise it. `PATCH /api/settings` replaces the whole map; loading drops entries for
  commands that no longer exist or values that no longer parse. They are in `EXPORTED_SETTINGS`, so backups carry them.
- **Dispatch.** `resolveKeybindings` merges defaults and overrides into `ResolvedKeybinding`s (a `when` that doesn't
  parse falls back to the default); `resolveCommand` picks the command. `palette.open`, `sidebar.toggle` and `panel.toggle` are `immediate`, and so is any
  command the user moved to a key with Ctrl/Cmd or Alt (browsers keep print, find and save there): it runs in the
  keydown and prevents its default. The rest wait to see whether something nearer the focus claimed the key
  (see the comment on `GlobalKeybindings` in `AppShell`). Keys are stored normalized (each modifier once, in the order mod,
  shift, alt). The control recording a new key carries `data-recording-shortcut`,
  and the shortcuts stand down for it.
- **Conflicts.** `keybindingConflicts` flags two commands on the same key whose `when`s can both be true
  (`whenOverlaps` tries every assignment of the flags the two use). The flags are treated as independent, so
  `overlayOpen` and `paletteOpen` are not known to imply each other; it may flag a pair that can't really collide.
- **Editor.** Settings → Keybindings (`KeybindingsSection`), laid out like T3 Code's keybindings page. A search box
  on top filters by title, group, key, condition or command name (`keybindingSections`; every word must match, and
  a settings link to a row clears it). Below it is one sub-section per `group` of the registry, taken from
  `keybindingGroups()` (the settings nav builds its sections from the same list), so a command in a new group
  needs no layout work. A row is the title, a small `When` line under it (`Always`, or the expression in mono) that
  opens the editor (a field that saves on blur; the helper on what can be written is one info hover in it, and a parse
  error shows there and on the row until the value changes), and on the right the key as chips, which is the button
  that records the next key combination (Esc records too; clicking away cancels). A conflict note and a warning
  when a bare character would run the command while typing in a field (`triggersWhileTyping`) sit under the title.
  Reset shows only on a row that differs from the default, and Reset all beside the search box once anything does
  (`keybindings.logic.ts` keeps the stored map free of values equal to the default; saves are built from the cache,
  which every settings write patches at once and an earlier reply can't rewind ([live-sync](live-sync.md#mutations)),
  so edits in a row don't lose each other). Sub-sections have ids `keybindings.<group>` and rows
  `keybindings.<group>.<command>`, which the settings index generates from the registry.
- **Showing them.** `useShortcutLabel(command)` gives the current key as text (`Ctrl+K`, `⌘K`) for the board
  header's search button, the close-panel, new-task and hide-sidebar tooltips, and the palette rows for New task and Settings:
  Board (`PaletteItem.shortcut`). The desktop app has no menu accelerator for these, so there is nothing to keep in sync.

To add a command: add it to `KeybindingCommand` and `DEFAULT_KEYBINDINGS`, run it in `GlobalKeybindings`'s `run`
(the `never` check fails until you do), and give it a test.

### Persistence

Both live in zustand stores in `apps/web/src/state/ui.ts`, persisted in localStorage under
`storageKey(...)`:

- `board-view` holds the column collapse state, which epic bands are folded, the priority lane switch and its
  pinning, and the column sorts (`collapsedEpics`, `showPriorityLane`, `pinPriorityLane`, `pinnedLaneHeight` and
  `columnSorts`, added without a version bump: a stored view without them takes the default, a stored height that isn't
  a size reads as Medium, and a stored sort a column doesn't offer reads as its default). The filters aren't here: they are the board's URL params ([saved-views.md](saved-views.md)). It is at
  version 2: `migrateBoardView` drops the filters older versions stored and version 0's per-lane `expandedDone`, which
  has no per-column equivalent, and renames version 1's `idea` collapse keys to `backlog`.
- `appearance` holds the sidebar banner, `scrollToTask`, and the contrast, glass, panel animation and font prefs
  ([appearance.md](appearance.md); the theme itself has its own keys there).
- `task-panel` holds pinned actions and the section layout. Read the layout through `useSectionLayout`,
  which validates it and keeps it referentially stable. It is at version 1: `migrateTaskPanelPrefs` pins `jump` for
  saves from before it existed. New browsers start with `["jump"]` (`DEFAULT_PINS`); unpinning it sticks.
- `project-scope` holds the last project scope (a list of project ids) so a restart can put it back
  ([saved-views.md](saved-views.md#the-project-scope)). The URL's `?project=` stays the source of truth while the app runs.

## Decisions

- **Column default plus project overrides.** One click handles the common case (collapse Done
  everywhere), and a busy project can still be opened on its own. Pruning overrides keeps "mixed"
  meaningful.
- **Smart defaults, explicit choices win.** Empty sections start collapsed, but once the user picks, the
  choice sticks across tasks.
- **Browser preferences, not server settings.** Layout is per device and per person; storing it on the
  server would push one window's layout to every other.
- **Only active threads on cards.** Cards have little room, and finished threads are history, which the
  panel keeps.

## Code map

| File                                                   | What it does                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| `apps/web/src/components/board/columnCollapse.logic.ts` | Column and cell collapse state, mixed state (tested)           |
| `apps/web/src/components/board/board.logic.ts`         | `COLUMN_PREVIEW_COUNT`, `visibleCellTasks` (tested)              |
| `apps/web/src/components/board/columnSort.logic.ts`    | Column sorts: the orders, their labels, defaults and comparators (tested) |
| `apps/web/src/components/board/Board.tsx`, `BoardCell.tsx` | Column toggles in the sticky header, cell toggle rows |
| `apps/web/src/components/board/cardMotion.ts`, `cardMotion.logic.ts` | Card motion: the drop animation and the board FLIP (diff tested) |
| `apps/web/src/components/board/PriorityLane.tsx`, `dnd.logic.ts` | The priority lane, and the drop rules in and out of it (tested) |
| `apps/web/src/components/board/useStuck.ts`, `stuck.logic.ts` | Whether the pinned lane is stuck, how far it has folded, and keeping its footprint (`stuckHeight` is tested) |
| `apps/web/src/components/board/cardLinks.logic.ts`     | Which links a card shows (tested)                                |
| `apps/web/src/components/board/CardContextMenu.tsx`, `BulkMenuItems.tsx`, `bulkActions.ts`, `bulkMenu.logic.ts` | The card menu, its bulk variant, the bulk mutations and which cards each item fits (`bulkMenu.logic.ts` is tested) |
| `apps/web/src/components/task/TaskMenuItems.tsx`, `TaskMenuDialogs.tsx` | The items shared by the panel's More menu and the card menu, and their dialogs |
| `apps/web/src/components/task/TaskWindow.tsx`, `taskLayout.ts`, `board/taskWindow.logic.ts` (tested) | The task window, the layout context its parts read, and its URL state |
| `apps/web/src/components/markdown/CodeBlock.tsx`, `codeHighlight.ts`, `codeBlock.logic.ts` (tested) | Highlighted fenced code blocks |
| `apps/web/src/components/board/reveal.logic.ts`, `revealCard.ts` | Revealing a task: the steps and scroll target (tested), the scroll and flash |
| `apps/web/src/components/autopilot/autopilot.logic.ts` | Pill state, Inherit labels, config and limit parsing, run labels (tested) |
| `apps/web/src/components/autopilot/AutopilotPill.tsx`, `AutopilotEpicButton.tsx`, `ScopePopover.tsx`, `PauseAllButton.tsx`, `AutopilotBadge.tsx`, `AutopilotSection.tsx` | The lane pill, the epic button, their shared popover, header pause, card badge, panel section |
| `apps/web/src/components/digest/` (`digest.logic.ts` is tested), `state/digests.ts` | The header button, the panel and the digest queries |
| `apps/web/src/components/markdown/taskRefs.logic.ts` | Linking `#N` task numbers in rendered Markdown (tested) |
| `apps/web/src/components/task/sections.logic.ts`       | Section ids, defaults, summaries, layout validation (tested)      |
| `apps/web/src/components/task/links.logic.ts`, `LinksSection.tsx`, `SessionsSection.tsx` | Which links are sessions, the two sections' rows, folding and "Show N more" (`groupLinks` and `previewRows` are tested) |
| `apps/web/src/components/task/ManagedSections.tsx`, `SectionsMenu.tsx`, `TaskSection.tsx` | Rendering, drag reorder, the customize popover |
| `apps/web/src/state/boardView.logic.ts`                | Board view defaults and the version 0 and 1 migrations (tested)         |
| `apps/web/src/state/ui.ts`                             | The persisted stores, and `useSettingsNav` (scroll-spy, scroll requests, `boardReturn`) |
| `apps/web/src/components/layout/AppShell.tsx`, `AppFrame.tsx` | The frame every page shares (one layout route), which keeps the board mounted behind a window; the app-wide shortcuts |
| `apps/web/src/components/layout/AppRouteModal.tsx`, `appModal.logic.ts` | The floating route window (Settings, Stats), `closeAppWindow`; which paths are windows and where the board reads its search |
| `packages/contracts/src/keybindings.ts`               | The shortcut registry, `when` parser and evaluator, overrides schema, conflicts (tested) |
| `apps/web/src/components/layout/keyboard.logic.ts`, `useKeybindings.ts` | Matching key events, recording and formatting shortcuts (tested), the resolved bindings hook |
| `apps/web/src/components/settings/KeybindingsSection.tsx`, `keybindings.logic.ts` | Settings → Keybindings: the page, grouping, search and the override edits (tested) |
| `apps/web/src/components/settings/settingsNav.logic.ts` | Settings groups and section ids, targets, scroll-spy, the project shown (tested) |
| `apps/web/src/components/settings/SettingsShell.tsx`    | The `/settings` route: the window, its rail (the settings list), header and `SettingsScroller` |
| `apps/web/src/components/settings/SettingsSearch.tsx`, `settingsIndex.logic.ts`, `settingsSearch.logic.ts` | Settings search: the box and results, the index of every setting, matching and ranking (tested) |
| `apps/web/src/components/settings/SettingsAskRow.tsx`, `apps/server/src/integrations/settingsAsk.ts` | The settings Ask: its row in the results, and the endpoint that asks Claude Code (server tested) |
| `apps/web/src/components/settings/settingsNavigation.ts` | `useOpenSettings`, `useLeaveWindow`                              |
| `apps/web/src/components/settings/pages/`              | The group pages, the project page and the editor sub-pages      |
| `apps/web/src/components/settings/integrations.logic.ts` | GitHub's and the terminal's status dots (tested)                |
| `apps/web/src/components/settings/agents/` | Settings → Agents: the page, the split card, Providers (list, Add provider dialog, empty state), Models (tiers, custom models) and Operations; `agents.logic.ts` is tested |
| `apps/web/src/components/settings/ProviderEditors.tsx`, `providers.logic.ts` | Each provider's editor, its dots and the selected provider (logic tested) |
| `apps/web/src/components/settings/OperationModelLink.tsx`, `ProjectModelsSection.tsx` | The one-line links to an operation's row, and a project's reviewer model |
| `apps/web/src/components/models/` | The shared model picker and its adapters (`ModelChoicePicker`, `CliModelPicker`, `T3ModelPicker`); options, search, disabled reasons, effort and the Operations list in `*.logic.ts` (tested) |
