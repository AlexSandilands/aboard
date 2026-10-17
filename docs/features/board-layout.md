# Board and panel layout

Board tasks: #54 (columns), #56 (panel sections), #58 (thread links on cards), #118 (Sessions section), #22 (priority lane).
The filters and saved views are in [saved-views.md](saved-views.md).

A board with many projects and a long Done column gets tall, and the task panel gets crowded. This doc
covers how the board and the panel decide what to show: collapsible columns, collapsible and reorderable
panel sections, and which links a card shows. These are browser-only preferences: nothing here is stored
on the server (saved views, which are, are in [saved-views.md](saved-views.md)). It also covers the settings page, which takes the board's place.

## How it works

A lane stacks its epic bands above its loose cards; how bands are laid out is in [epics.md](epics.md#on-the-board).
A finished epic has no band: it is one card in the lane's Done cell, so it counts as one card for the column
counts and the collapsed preview below. Bands and that card share a frame that tells epics from task cards, and
the task card's thread and session chips and start button ([epics.md](epics.md#on-the-board)).

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
  and `priority` on `create_task`, `add_to_backlog` and `update_task` (and REST). Agents set it only when asked.
- **Dragging** (`computeDrop`, `canDropIn` in `dnd.logic.ts`). A card in the lane moves between its columns, which
  changes its status. It takes no place in the column: positions only mean something inside one project's lane, and
  the server refuses a neighbour from another project. Dropped on its own project's lane (or its epic's band) it is
  placed there like any card and **stops being priority** (`PATCH priority: false`, sent once the move has landed so a
  refused move leaves the card in the lane, and applied to the cache at once). While the card is dragged its project's
  row, or its epic's band when the lane has one (`homeRowId`), is drawn in full so there is a place to drop it, unless its lane is collapsed, filtered out or not the scoped project, when
  the star is the way out. Other lanes refuse it. Cards from project lanes can't be dragged into the lane; use the star.
- **Dependency lines** work across the lane as anywhere; a related card that isn't shown gets its stub toward the lane
  as above the first project.
- **Autopilot** starts priority tasks first ([autopilot.md](autopilot.md#automations)).

### In progress, all projects

The filter menu's **In progress, all projects** (`?inprogress=true`) shows only In Progress cards,
across every project: it ignores a project scope while it is on (the scope returns when it is turned off, and choosing a project in the
sidebar turns it off). Epic
bands keep only their In Progress tasks, and the priority lane holds its In Progress ones.

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

### Revealing a task

Opening a task from anywhere but a board card scrolls the board to its card. `useOpenTask` (`boardNavigation.ts`) sets a
reveal request in `useReveal` (`state/ui.ts`: `{ taskId, nonce, at }`, not persisted) once the navigation has landed;
`reveal: false` opts out, which the board's own card clicks do (`BoardContext.openTask`; `revealTask` is for a link on a
card that leads to another task). The request is made only when the `scrollToTask` appearance setting (browser-local,
on by default) is on.

`BoardContent` acts on the request as the board changes, one step at a time (`revealStep` in `reveal.logic.ts`):
expand the project lane or folded epic band hiding the card (each once per request), wait for the task to be the open
one (which keeps its card in a collapsed column), then `revealCard` scrolls the board's scroll box to it. A card in no
lane (filtered out, archived) ends the request: the panel opens, nothing scrolls, the filters stay. A request nobody
fulfils expires after `REVEAL_EXPIRY_MS`.

`revealScrollTarget` centres the card on each axis it isn't fully visible on, allowing for the sticky column header, and
leaves the other axis. The scroll is smooth (instant under `prefers-reduced-motion`), followed by one correction once it
settles (off-screen cards are laid out at an estimated height, and the panel may still be docking) and a fading ring on
the card, drawn with the Web Animations API because React would drop a class on re-render. `#N` in the panel's Markdown
links through `useTaskLinks` and the same path.

### Task panel sections

The panel's sections are Labels, Sessions, Links, Local review, Autopilot, Plan, Details (description and plan context
together) and Activity. Each can be collapsed, reordered by dragging its handle, and hidden. A collapsed
section shows a one-line summary in its header (`summarizeSection`): the label names, the number of threads and sessions (folded ones included) and any thread that needs you, the link count and
any link problem, open findings, the Autopilot run that needs attention, plan progress and the current step, the first line of the description (or of the
plan context), or the event count and how long ago the last one was.

Until the user chooses, sections collapse by content (`collapsedByDefault`):

| Section              | Starts collapsed when                             |
| -------------------- | ------------------------------------------------- |
| Labels, Plan         | Never: one row either way, and an empty plan is the prompt to write one |
| Sessions             | The task has no T3 threads or agent sessions      |
| Links                | The task has no PRs, issues, Jira keys or URLs    |
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
appended, except Sessions, which goes before Links in a layout saved without it (and takes its hidden and collapsed state from Links when that layout
had them, since it used to be part of Links).

The Autopilot section lists the task's Autopilot runs (`AutopilotSection`: status, automation, what it did,
runner, a thread link or session id, cost and the error). It renders nothing while the task has no runs, so
tasks Autopilot never touched don't show it.

#### The Sessions section

Sessions is a section of its own, above Links by default (`SessionsSection`). It holds what used to sit in a
Sessions group of the Links section (#111, split out by #118). A task with none shows "No coding sessions yet" and
starts collapsed.

- **Rows** (`groupLinks` in `links.logic.ts`): the task's T3 threads, needing attention first (`orderLinks`), then its
  agent sessions, newest first. When there are more than three rows (`SESSION_PREVIEW_COUNT`) the first three show,
  and **Show N more** expands the rest inline (**Show fewer** folds them again; the state is per panel visit, not
  stored).
- **Folded sessions.** When the task has exactly one T3 thread, its Claude Code sessions leave the rows and sit in
  the thread's ⌄ menu, one submenu each (open, fork, copy the resume command, copy the id, remove), as the thread
  runs a Claude session underneath. Sessions don't say which thread they belong to, so with several threads
  nothing folds. Autopilot's sessions (`isAutopilotSession`: their run's finished or failed status, or the
  runner's "Autopilot ·" name) and Copilot CLI sessions always stay rows.

#### The Links section

PRs, then issues, Jira keys and other URLs, each kind in link order (`groupLinks`). Its header has **Copy link**
and the list ends with **Add link**; pasting a T3 thread there still works, and the thread lands in Sessions.

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
  "Recurring tasks…" link opens the project's settings at that section. The chosen **On** is the app's info blue
  (`ModeSwitch`), and an Inherit that resolves to On shows its note in the same blue.
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

### The settings page

Settings is a route, `/settings/<group>` with group `board`, `tasks`, `autopilot`, `integrations` or `project`
(`/settings` and unknown groups redirect to `board`). The editors are sub-routes: `tasks/templates/<id>`,
`autopilot/custom/<id>` and `project/recurring/<id>`, with `new` for one not saved yet. The project page and the
rule editor take `?project=`; without it the page shows the project the board was scoped to, else the first.

- **Shell.** The board and Settings sit under one pathless layout route (`_app`, `AppFrame`) that renders a single
  `AppShell`: the resizable sidebar (an off-canvas sheet on narrow windows), the palette, the app dialogs, live sync
  and the shortcuts. It stays mounted between them, so the event stream doesn't reconnect and miss events. On `/settings` the sidebar holds the settings list instead of the
  projects: every group with its sections, always expanded, and **Back** at the bottom. Esc leaves an editor for its
  page and a page for the board; Back and Esc restore the board's search as it was (`boardReturn`).
- **Ids.** `SETTINGS_GROUPS` (`settingsNav.logic.ts`) lists the groups and their sections. A section's id is
  `<group>.<section>` (`tasks.review`); the groups and rows inside carry `<group>.<section>.<row>` ids
  (`integrations.claude-code.cli-path`). The ids are element ids and URL hashes, and are stable: settings search
  targets them.
- **Leaving.** Navigations to the board from Settings (opening a task from the palette or a notification) build on
  `boardReturn` rather than the settings page's search (`boardSearchFrom`), so `?project=` doesn't leak onto the board.
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
  through the shared headless runner (`agentArgs` with `access: "none"`, the CLI from `headlessReviewCli`) on
  `haiku`, with a $0.05 budget and a 60 s timeout, in an empty temp folder, and asks for `{ settingId | null,
  answer }`. The question and the index are fenced as data with a random fence. A `settingId` that isn't one of the
  request's ids becomes null (the answer stays). Only one question runs at a time (the page discards an edited pending question but can't stop its run), so a second
  one meanwhile gets "Another question is still being answered". A failed run, a timeout or an answer of the wrong shape comes back
  as `{ ok: false, error }` with status 200, like the CLI test, so the row can show the message. The row holds the
  whole exchange: thinking, then the answer with **Go there** (the same jump and highlight as a result), or the
  error with "Click to try again". `GET /api/settings/ask` says whether the CLI resolves (not whether it is signed
  in; that shows as the run's error); when it doesn't, the row is disabled with the reason and **Set up Claude
  Code**, which opens `integrations.claude-code.cli-path`. Copilot as a second engine isn't built.
- **Scroll-spy.** `SettingsScroller` reads the tops of the `SettingsSubsection` anchors on scroll and resize, and
  `activeSectionId` picks the last whose top has passed a line near the top (the last one when scrolled to the
  bottom). The list highlights that section.
- **Ways in.** The sidebar gear, Ctrl/Cmd+, (`settings.open`), the palette's "Settings: <group or section>"
  entries (sections only once a query is typed), a project's gear or right-click (project page), and the Autopilot
  popover (its Settings link, and Recurring tasks… for the project's rules).
- **Editors.** `EditorFrame`'s parts render the template, custom automation and rule editors as a dialog by
  default and as page blocks inside `EditorPage`, so Save as template keeps its dialog. Cancel, Save and Esc all
  leave an editor for the section listing what it edits (`editorListSection`, `useLeaveEditor`): opened from that
  list (the `settingsEditorFromList` history state), it steps back in history, so the browser's Back doesn't
  repeat the page; opened from a link or a reload, it opens the list as a new entry.

### Keyboard shortcuts

The app-wide shortcuts are a registry in `packages/contracts/src/keybindings.ts`: each command (`palette.open`,
`idea.new`, `settings.open`, `back`) has a title, a group, a default key and a default `when`. Shaped like T3
Code's keybindings: a command, a key and a `when`, and when several match a key event the later one wins.

- **Keys.** `mod+k`, `shift+n`, `escape`: lowercase modifiers (`mod` is Cmd on macOS and Ctrl elsewhere, plus
  `shift` and `alt`), then one key. The space and plus keys are `space` and `plus`. The match is exact: extra
  modifiers don't match (`matchesShortcut` in `layout/keyboard.logic.ts`).
- **`when`.** An expression over the context flags with `!`, `&&`, `||` and parentheses (`!` binds tightest, `||`
  loosest); empty means always. The flags (`KEYBINDING_CONTEXT_KEYS`) are `editableFocus`, `popupFocus`,
  `overlayOpen`, `paletteOpen`, `dialogOpen`, `settingsOpen`, `panelOpen` and `canGoBack`; `AppShell` builds them per
  key event (`overlayOpen` is the palette or the digest, as it always was; `dialogOpen` is any app dialog, via
  `anyDialogOpen`). An unknown name is a parse error (`parseWhen`), so the server refuses it on save. The defaults are the old
  hard-coded behaviour, e.g. `n` is `!overlayOpen && !editableFocus && !popupFocus`.
- **Overrides.** The setting `keybindings` holds only what the user changed, per command: `{ key?, when? }` (an empty
  `when` means always). A command left out always follows the current default, so a default added or changed later
  reaches everyone who didn't customise it. `PATCH /api/settings` replaces the whole map; loading drops entries for
  commands that no longer exist or values that no longer parse. They are in `EXPORTED_SETTINGS`, so backups carry them.
- **Dispatch.** `resolveKeybindings` merges defaults and overrides into `ResolvedKeybinding`s (a `when` that doesn't
  parse falls back to the default); `resolveCommand` picks the command. `palette.open` is `immediate`, and so is any
  command the user moved to a key with Ctrl/Cmd or Alt (browsers keep print, find and save there): it runs in the
  keydown and prevents its default. The rest wait to see whether something nearer the focus claimed the key
  (see the comment on `useGlobalKeybindings`). Keys are stored normalized (each modifier once, in the order mod,
  shift, alt). The control recording a new key carries `data-recording-shortcut`,
  and the shortcuts stand down for it.
- **Conflicts.** `keybindingConflicts` flags two commands on the same key whose `when`s can both be true
  (`whenOverlaps` tries every assignment of the flags the two use). The flags are treated as independent, so
  `overlayOpen` and `paletteOpen` are not known to imply each other; it may flag a pair that can't really collide.
- **Editor.** Settings → Board → Keybindings (`KeybindingsSection`): a row per command, grouped by the registry's
  `group`, with a button that records the next key combination (Esc records too; clicking away cancels), a `When`
  field that saves on blur and shows the parse error, a conflict note, a warning when a bare character would run the
  command while typing in a field (`triggersWhileTyping`), and Reset / Reset all (`keybindings.logic.ts` keeps the
  stored map free of values equal to the default; saves are built from the cache, which is patched at once, or
  from the newest save while any is still in flight (an earlier reply must not rewind it), so edits in a row don't
  lose each other). Rows have ids `board.keybindings.<command>`, which the
  settings index generates from the registry.
- **Showing them.** `useShortcutLabel(command)` gives the current key as text (`Ctrl+K`, `⌘K`) for the board
  header's search button, the close-panel and new-task tooltips, and the palette rows for New task and Settings:
  Board (`PaletteItem.shortcut`). The desktop app has no menu accelerator for these, so there is nothing to keep in sync.

To add a command: add it to `KeybindingCommand` and `DEFAULT_KEYBINDINGS`, run it in `useGlobalKeybindings`'s `run`
(the `never` check fails until you do), and give it a test.

### Persistence

Both live in zustand stores in `apps/web/src/state/ui.ts`, persisted in localStorage under
`storageKey(...)`:

- `board-view` holds the column collapse state, which epic bands are folded and the priority lane switch
  (`collapsedEpics` and `showPriorityLane`, added without a version bump: a stored view without them takes the
  default). The filters aren't here: they are the board's URL params ([saved-views.md](saved-views.md)). It is at
  version 2: `migrateBoardView` drops the filters older versions stored and version 0's per-lane `expandedDone`, which
  has no per-column equivalent, and renames version 1's `idea` collapse keys to `backlog`.
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
| `apps/web/src/components/board/PriorityLane.tsx`, `dnd.logic.ts` | The priority lane, and the drop rules in and out of it (tested) |
| `apps/web/src/components/board/cardLinks.logic.ts`     | Which links a card shows (tested)                                |
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
| `apps/web/src/components/layout/AppShell.tsx`, `AppFrame.tsx` | The frame the board and Settings share (one layout route); the app-wide shortcuts |
| `packages/contracts/src/keybindings.ts`               | The shortcut registry, `when` parser and evaluator, overrides schema, conflicts (tested) |
| `apps/web/src/components/layout/keyboard.logic.ts`, `useKeybindings.ts` | Matching key events, recording and formatting shortcuts (tested), the resolved bindings hook |
| `apps/web/src/components/settings/KeybindingsSection.tsx`, `keybindings.logic.ts` | Settings → Board → Keybindings, and the override edits (tested) |
| `apps/web/src/components/settings/settingsNav.logic.ts` | Settings groups and section ids, targets, scroll-spy, the project shown (tested) |
| `apps/web/src/components/settings/SettingsShell.tsx`    | The `/settings` route: the settings list, top bar and `SettingsScroller` |
| `apps/web/src/components/settings/SettingsSearch.tsx`, `settingsIndex.logic.ts`, `settingsSearch.logic.ts` | Settings search: the box and results, the index of every setting, matching and ranking (tested) |
| `apps/web/src/components/settings/SettingsAskRow.tsx`, `apps/server/src/integrations/settingsAsk.ts` | The settings Ask: its row in the results, and the endpoint that asks Claude Code (server tested) |
| `apps/web/src/components/settings/settingsNavigation.ts` | `useOpenSettings`, `useLeaveSettings`                            |
| `apps/web/src/components/settings/pages/`              | The group pages, the project page and the editor sub-pages      |
| `apps/web/src/components/settings/integrations.logic.ts` | The integrations' status dots (tested)                          |
