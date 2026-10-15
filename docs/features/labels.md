# Labels

Board tasks: #18, #60.

Labels tag a task with the kind of work it is (`ui`, `backend`, `bug`, `tech-debt`), so the user can
filter the board down to one kind across every project. People set them in the task panel; agents set
them over MCP and are asked to suggest some when they plan an unlabelled task.

## How it works

### The label itself

Labels are free-form and board-wide: there is no list to manage, and a label exists while a task carries
it. `normalizeLabel` (`packages/contracts/src/labels.ts`) makes `"UI"`, `" ui "` and `"#ui"` one label:
trimmed, lowercased, leading `#`s dropped, runs of whitespace and commas turned into one `-`, and
leading or trailing `-` removed (so `"ui,"` is `ui`).

| Rule              | Limit                                       |
| ----------------- | ------------------------------------------- |
| Length            | 1–32 characters after normalising           |
| Labels per task   | at most 10, deduped, stored sorted by name  |
| Invalid input     | `VALIDATION` error naming the bad label     |

A task's labels are replaced whole: `labels` on `PATCH /api/tasks/:id` or `update_task` is the new list,
and `[]` clears it. `create_task`, `create_idea` and `POST /api/tasks` take an initial list. A change logs
one `labels_changed` event with `added` and `removed`, and the card updates through the usual
`task.upserted`. Labels count as "in use" only on non-archived tasks in non-archived projects.

### Colours

Only a hue is stored. A label without an override gets a hue hashed from its name (`hashHue`, FNV-1a), so
it looks the same on every client without a database row. Chips render it as
`oklch(0.62 0.16 <hue>)` through Badge's `label` variant, which tints the chip per theme: picked and
hashed colours keep the same lightness and chroma, so all of them stay readable.

The colour picker opens from the dot on a chip in the panel: twelve suggested hues, a hue slider,
shuffle (at least 40° from the current hue) and **Reset to auto**. Overrides are board-wide, kept in
`label_colors`, and stay when the label falls out of use, so a reused label keeps its colour.

| Route                             | Does                                         |
| --------------------------------- | -------------------------------------------- |
| `GET /api/labels`                 | Labels in use, with task counts and override |
| `PUT /api/labels/:name/color`     | `{hue}` (0–359) sets an override             |
| `DELETE /api/labels/:name/color`  | Drops the override                           |

Both writes return all overrides. `PUT` publishes `labels.colors_changed`, which carries the whole map;
`DELETE` publishes it only when there was an override to remove
([live sync](live-sync.md)). The board snapshot has the same map as `labelColors`.

### Filtering and search

- The board filter menu lists the labels on cards in scope, with counts. Selecting several shows cards
  with **any** of them. The selection lives in the URL as `?labels=a,b`, like `?project=`, and shows as
  removable chips in the header. Lanes with no match are hidden, as with the other filters.
- The sidebar search, the Ctrl+K palette, `list_tasks`' `query` and `GET /api/tasks?q=` all match label
  names.
- `list_tasks(labels)` and `GET /api/tasks?labels=a,b` filter by any of the labels. Filter terms are
  normalised but not capped or validated: a term that normalises to nothing matches nothing.

Cards show the first three labels and `+N` for the rest.

### Agents

- `labels` on `create_task`, `create_idea` and `update_task`; `list_tasks` takes a `labels` filter, and
  summary lines show `[ui] [backend]` after the title.
- `board_overview` ends with **Labels in use** and counts, so agents reuse the board's vocabulary.
- **Missing labels.** `set_plan`, `create_task` and `get_task` results add a hint when the task has no
  labels and isn't resolved, done or archived. The hint names the labels in use (or offers generic
  examples on a board with none) and asks the agent to suggest 1–3 and call `update_task` once the user
  agrees. Other mutation results leave it out. See [mcp.md](mcp.md#results).

## Decisions

- **Free-form and board-wide.** No label admin: a label is created by using it, and suggestions come from
  labels already on the board. The cost is near-duplicates (`bug` vs `bugs`), which the suggestions and
  the agent hint push against.
- **Store a hue, not a colour.** Fixed lightness and chroma keep every chip readable in both themes, and
  hashed defaults mean most labels never need a row.
- **OR filter.** Labels describe the kind of work, and "show me UI or backend" is the common question.
  There is no AND mode.
- **A board-wide event for colours.** A colour change affects every card with that label, so
  `labels.colors_changed` sends the whole override map instead of re-sending each card.
- **Suggest, don't apply.** The Missing labels hint asks the agent to wait for the user's OK. Switching to
  apply-and-report would only change the hint's wording.
- **The hint only at planning moments.** On every mutation result it would be noise that agents learn to
  ignore.

## Alternatives considered

| Option                                   | Why not chosen                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| A managed label list with fixed colours  | Extra admin for a personal board; free-form labels plus suggestions cover it     |
| Storing full colours per label           | Picked colours could clash with a theme; a hue with fixed lightness and chroma can't |
| A label hint on every mutation result    | Noise; set_plan, create_task and get_task are where labelling is decided         |

## Code map

| File                                                        | What it does                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `packages/contracts/src/labels.ts`                          | `normalizeLabel(s)`, limits, `LabelHue`, `LabelUsage` (tested)       |
| `apps/server/src/db/migrations/005_task_labels.sql`         | `task_labels` and `label_colors`                                     |
| `apps/server/src/db/repos/labels.ts`                        | Labels per task, usage counts, colour overrides                      |
| `apps/server/src/services/labels.ts`                        | `setIn` (used by task create/update), usage, colour overrides        |
| `apps/server/src/services/tasks.ts`                         | Label filter and label matching in `matchesQuery`                    |
| `apps/server/src/http/routes/labels.ts`                     | `/api/labels` routes                                                 |
| `apps/server/src/mcp/format.ts`                             | Labels in renders, `labelHint` (Missing labels)                      |
| `apps/web/src/components/labels/labels.logic.ts`            | Hashed hue, chip style, suggestions, `?labels=` parsing (tested)     |
| `apps/web/src/components/labels/LabelChip.tsx`, `LabelsSection.tsx` | Chips, the colour picker, the panel's Labels section        |
| `apps/web/src/components/board/BoardHeader.tsx`             | Label filter menu and active filter chips                            |
| `apps/web/src/state/mutations.ts`                           | `useSetTaskLabels`, `useSetLabelColor`                               |
