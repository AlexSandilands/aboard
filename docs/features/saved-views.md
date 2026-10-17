# Board filters and saved views

Board task: #83 (builds on #22's in-progress filter and #7's epic filter).

The board filters by status, model tier, Autopilot flag, labels, epic, free text and a few switches, and any set of
filters can be saved as a named view. This doc covers how filters are stored, how they match, and how views are kept.

## How it works

### Filters are URL params

Every filter is a param of the board's URL (`BoardFilterParams`, `packages/contracts/src/savedViews.ts`), so any
filtered board can be bookmarked or shared, and Back undoes a filter. A default board has an empty search.

| Param        | Filter                                                                                  |
| ------------ | --------------------------------------------------------------------------------------- |
| `project`    | Scopes the board to one project (the sidebar, the palette)                              |
| `epic`       | Shows only that epic's band ([epics.md](epics.md#on-the-board))                         |
| `labels`     | Comma-separated labels, any of them ([labels.md](labels.md))                            |
| `status`     | Comma-separated statuses, any of them                                                   |
| `tier`       | Comma-separated suggested model tiers (`light`, `standard`, `deep`, `none` for no tier) |
| `autopilot`  | Comma-separated per-task Autopilot flags: `on`, `off`, `default`                        |
| `q`          | Free text: title, `#number`, Jira key or label (the sidebar search box)                 |
| `attention`  | `true`: only tasks that need attention                                                  |
| `pr`         | `true`: only tasks with a pull request                                                  |
| `blocked`    | `true`: only tasks blocked by an open task                                              |
| `priority`   | `true`: only priority tasks                                                             |
| `inprogress` | `true`: only In Progress tasks, from every project ([board-layout.md](board-layout.md#in-progress-all-projects)) |
| `archived`   | `true`: include archived tasks                                                          |

The router parses a param as JSON when it can (and writes a string that looks like JSON quoted, so the URLs the app
makes round-trip), so a hand-typed `?q=1e3` reads as the number 1000. The schema accepts a number for text and a boolean or `"true"` for a
flag, and **drops a value it can't read instead of failing the page**. `readFilters` (`boardFilters.logic.ts`) turns
the params into a `FilterState`, dropping unknown list values and writing lists in the order of their choices, so the
same filters always make the same URL. `filterParams` goes back. The hooks in `boardNavigation.ts`
(`useBoardFilters`, `useSetBoardFilters`, `useResetFilters`, `useApplyFilterParams`) read and write them; a change keeps
the open task (`?task=`) and the project scope.

### Matching

`buildLanes` takes `taskFilters` (status, tier, Autopilot flag, blocked, priority) beside the older filters. These look
at the task itself, never at its epic: unlike text, attention, PR and labels (which also match a task through its
epic, so a matching epic shows all its children), a status filter must not let an epic's derived status stand in for
its children. An epic with no matching children shows only when it passes the same filters itself, so a filter leaves
no empty bands behind. Lanes with no match are dropped, as for any filter.

Within one filter, choices are "any of" (`status=review,done` is Review or Done); different filters are "all of".
`In progress, all projects` is also a status filter, but it additionally ignores the project scope.

### The filter menu and "Filters active"

The header's filter menu holds the switches (in progress, needs attention, has PR, blocked, priority, archived),
submenus for status, model tier, Autopilot flag and epic, the label list, and the views (switch, **Save view…**,
**Reset filters**). While any filter is on, a pill beside the title says how many ("2 filters active") with a reset
button, and the filter button is highlighted. When the filters are exactly a saved view's, the pill shows its name
instead. The project scope doesn't count: it has its own chip with its own close button, and a reset leaves it.

### Saved views

A view is a name and the filter params as they were (`SavedView`: `id`, `name`, `filters`), the project scope included.
The open task isn't part of it.

- **Where they live.** The `savedViews` app setting, one list in the order the user keeps (`SavedViews`, at most 50,
  names up to 60 characters). It is on the server, so every browser sees the same views, and it is in the **backup
  allow-list** (`EXPORTED_SETTINGS`), so a restore brings it back. Changing it is `PATCH /api/settings` with the whole
  list; the server keeps the first of a repeated id. There is no SSE event for settings, so another open browser
  shows a new view after its settings query refetches, which the sidebar does when the window gets focus. Saving
  there before that can still overwrite a view added meanwhile elsewhere (the list is replaced whole), and the server
  refuses a list in which two views share a name (ignoring case).
- **Saving.** **Save view…** in the filter menu or the palette opens `ViewDialog` (`viewDialog` in `useDialogs`) for a
  name. Names are unique ignoring case. It is disabled with nothing to save. Filters are stored normalised
  (`normalizeParams`).
- **Switching.** The sidebar's **Views** section (hidden until there is one) applies a view on click; rename and delete
  show on hover (a delete shows a toast with **Undo**). The filter menu's Views submenu and the palette's **Views** group do the same. Applying replaces every
  filter, the project scope included, and leaves the open task.
- **Active view.** The view whose filters equal the board's now (`activeView`, order- and blank-insensitive) is marked
  in the sidebar, the menu and the palette, and named in the pill. Nothing tracks "the view you came from": change a
  filter and it is simply no longer that view. Saving again under the same name is refused; rename or delete first.

## Decisions

- **The URL is the one representation.** A saved view is the search the board would have, so applying it is a
  navigation, and the URL, a bookmark and a view can't drift apart.
- **Filters left the persisted board view.** Needs attention, has PR, show archived and in-progress used to live in
  `board-view` in localStorage, and the search text in memory. They are URL params now; the persisted view keeps only
  layout (collapse state, folded epics, the priority lane switch). A filter no longer outlives a reload on its own, but
  a view (or the URL) brings it back. `migrateBoardView` drops the old keys.
- **Views on the server, not per browser.** The task first suggested a per-browser preference like the layout ones.
  Views are work a person builds up and wants on every machine and in a backup, unlike a column's collapse state.
- **One list, replaced whole.** Views are few and ordered, so a setting holding the list is simpler than a table with
  positions; the cost is that two browsers saving at the same moment, the last write wins.

## Code map

| File                                                                 | What it does                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/contracts/src/savedViews.ts`                               | `BoardFilterParams`, `SavedView`, limits                              |
| `apps/web/src/components/board/boardFilters.logic.ts`                | Params ↔ filter state, equality, counts, task-level matching (tested) |
| `apps/web/src/components/board/boardNavigation.ts`                   | The hooks that read and change filters in the URL                     |
| `apps/web/src/components/board/board.logic.ts`                       | `buildLanes`' `taskFilters` (tested)                                  |
| `apps/web/src/components/board/BoardHeader.tsx`                      | The filter menu, submenus and the "Filters active" pill               |
| `apps/web/src/components/views/views.logic.ts`, `ViewDialog.tsx`     | Names, add, rename, remove, the active view (tested); the dialog      |
| `apps/web/src/state/views.ts`                                        | `useSavedViews`, `useViewActions` over the settings query             |
| `apps/web/src/components/sidebar/ViewsSection.tsx`                   | The sidebar list                                                      |
| `apps/server/src/services/settings.ts`                               | Storing `savedViews`, the backup allow-list                           |
