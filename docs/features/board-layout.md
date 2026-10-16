# Board and panel layout

Board tasks: #54 (columns), #56 (panel sections), #58 (thread links on cards).

A board with many projects and a long Done column gets tall, and the task panel gets crowded. This doc
covers how the board and the panel decide what to show: collapsible columns, collapsible and reorderable
panel sections, and which links a card shows. These are browser-only preferences: nothing here is stored
on the server.

## How it works

A lane stacks its epic bands above its loose cards; how bands are laid out is in [epics.md](epics.md#on-the-board).

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

### Task panel sections

The panel's sections are Labels, Links, Local review, Plan, Details (description and plan context
together) and Activity. Each can be collapsed, reordered by dragging its handle, and hidden. A collapsed
section shows a one-line summary in its header (`summarizeSection`): the label names, the link count and
any link problem, open findings, plan progress and the current step, the first line of the description (or of the
plan context), or the event count and how long ago the last one was.

Until the user chooses, sections collapse by content (`collapsedByDefault`):

| Section              | Starts collapsed when                             |
| -------------------- | ------------------------------------------------- |
| Labels, Plan         | Never: one row either way, and an empty plan is the prompt to write one |
| Links                | The task has no links                             |
| Local review         | No review rounds                                  |
| Details              | No description and no plan context                |
| Activity             | Always: it's a log, not a summary                 |

A collapse choice is stored only when it differs from that default, so picking the default again lets
the smart default apply. **Collapse all** and **Expand all** store a choice for every section, which pins
them until **Reset**. The **Customize sections** popover in the panel's top bar reorders, shows and
hides sections, collapses or expands them all, and resets to the defaults. Stored layouts are
re-validated on read (`normalizeSectionLayout`): unknown ids are dropped and sections added later are
appended.

### Links on cards

The card's link row shows PRs and **active** T3 threads, in the panel's order (`cardLinks`). A thread
with no snapshot yet counts as active, since it may be. The first Jira key shows as a badge in the card's
top row. Settled and archived threads, other Jira keys and plain URLs appear in the panel only, where
inactive threads are dimmed.

### Persistence

Both live in zustand stores in `apps/web/src/state/ui.ts`, persisted in localStorage under
`storageKey(...)`:

- `board-view` holds the filters, the column collapse state and which epic bands are folded
  (`collapsedEpics`, added without a version bump: a stored view without it takes the default). It is at version 2:
  `migrateBoardView` keeps version 0's filters and drops its per-lane `expandedDone`, which has no
  per-column equivalent, and renames version 1's `idea` collapse keys to `backlog`.
- `task-panel` holds pinned actions and the section layout. Read the layout through `useSectionLayout`,
  which validates it and keeps it referentially stable.

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
| `apps/web/src/components/board/Board.tsx`, `BoardCell.tsx` | Column toggles in the sticky header, cell toggle rows |
| `apps/web/src/components/board/cardLinks.logic.ts`     | Which links a card shows (tested)                                |
| `apps/web/src/components/task/sections.logic.ts`       | Section ids, defaults, summaries, layout validation (tested)      |
| `apps/web/src/components/task/ManagedSections.tsx`, `SectionsMenu.tsx`, `TaskSection.tsx` | Rendering, drag reorder, the customize popover |
| `apps/web/src/state/boardView.logic.ts`                | Board view defaults and the version 0 and 1 migrations (tested)         |
| `apps/web/src/state/ui.ts`                             | The persisted stores                                             |
