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

The panel's sections are Labels, Links, Local review, Autopilot, Plan, Details (description and plan context
together) and Activity. Each can be collapsed, reordered by dragging its handle, and hidden. A collapsed
section shows a one-line summary in its header (`summarizeSection`): the label names, the link count and
any link problem, open findings, the Autopilot run that needs attention, plan progress and the current step, the first line of the description (or of the
plan context), or the event count and how long ago the last one was.

Until the user chooses, sections collapse by content (`collapsedByDefault`):

| Section              | Starts collapsed when                             |
| -------------------- | ------------------------------------------------- |
| Labels, Plan         | Never: one row either way, and an empty plan is the prompt to write one |
| Links                | The task has no links                             |
| Relations            | The task blocks nothing and is blocked by nothing ([relations](relations.md)) |
| Local review         | No review rounds                                  |
| Autopilot            | No run on the task needs attention (the runs aren't in the task detail, so they can't decide) |
| Details              | No description and no plan context                |
| Activity             | Always: it's a log, not a summary                 |

A collapse choice is stored only when it differs from that default, so picking the default again lets
the smart default apply. **Collapse all** and **Expand all** store a choice for every section, which pins
them until **Reset**. The **Customize sections** popover in the panel's top bar reorders, shows and
hides sections, collapses or expands them all, and resets to the defaults. Stored layouts are
re-validated on read (`normalizeSectionLayout`): unknown ids are dropped and sections added later are
appended.

The Autopilot section lists the task's Autopilot runs (`AutopilotSection`: status, automation, what it did,
runner, a thread link or session id, cost and the error). It renders nothing while the task has no runs, so
tasks Autopilot never touched don't show it.

### Autopilot on the board

Four things on the board show Autopilot, all from `BoardSnapshot.autopilot` (pause and the runs in flight,
kept live by `autopilot.changed`) and none of them shown while the catalogue has no automations. A fifth, the
[digest button](#digest-of-what-changed), is always there:

- **The lane's Autopilot pill**, after the lane's other header buttons (`AutopilotPill`). Off (no automation
  is on for the project) is dim; on and idle is a calm ring; paused is warning-coloured with a pause icon; while
  a run is going in the project a bright arc circles the border and a glow breathes behind it (`.autopilot-pill`
  in `index.css`; both animations are off under `prefers-reduced-motion`). A run still going counts as active
  even under Pause all. Clicking it opens a popover with Inherit / On / Off for each automation at the project,
  each with what Inherit resolves to (`inheritLabel`, e.g. "Inherit (On from board)"). Under Recurring tasks a
  "Recurring tasks…" link opens the project's settings at that section.
- **The epic's Autopilot button** (`AutopilotEpicButton`), a small circle at the end of the epic band's header and
  in the epic panel's top bar. It has the pill's four states and the same sweep (it wears `.autopilot-pill`, so
  reduced motion is respected), animates while a run on one of the epic's tasks is going (`epicId` on the active
  run), and opens the same popover (`ScopePopover`) for the epic. Its Inherit labels read the project's entries,
  which already resolve through the board ("Inherit (Off from project)"). Automations with `epicScope: false` (Recurring, Digest) aren't listed and don't count. Off means nothing is on for the epic's
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
| `apps/web/src/components/autopilot/autopilot.logic.ts` | Pill state, Inherit labels, config and limit parsing, run labels (tested) |
| `apps/web/src/components/autopilot/AutopilotPill.tsx`, `AutopilotEpicButton.tsx`, `ScopePopover.tsx`, `PauseAllButton.tsx`, `AutopilotBadge.tsx`, `AutopilotSection.tsx` | The lane pill, the epic button, their shared popover, header pause, card badge, panel section |
| `apps/web/src/components/digest/` (`digest.logic.ts` is tested), `state/digests.ts` | The header button, the panel and the digest queries |
| `apps/web/src/components/markdown/taskRefs.logic.ts` | Linking `#N` task numbers in rendered Markdown (tested) |
| `apps/web/src/components/task/sections.logic.ts`       | Section ids, defaults, summaries, layout validation (tested)      |
| `apps/web/src/components/task/ManagedSections.tsx`, `SectionsMenu.tsx`, `TaskSection.tsx` | Rendering, drag reorder, the customize popover |
| `apps/web/src/state/boardView.logic.ts`                | Board view defaults and the version 0 and 1 migrations (tested)         |
| `apps/web/src/state/ui.ts`                             | The persisted stores                                             |
