# Live sync

Every open board updates within a second when anything changes, whether the change came from the UI, an
agent over MCP or a poller. The server pushes events over server-sent events, and the web app applies them
to its TanStack Query cache.

## How it works

### Server

- Services publish `BoardEvent`s on the in-process `EventBus` after each committed write
  ([architecture.md](../architecture.md#how-a-change-flows)). The T3 poller publishes
  `integrations.changed` itself when T3 Code's status changes.
- `GET /events` (`apps/server/src/sse.ts`) sends `event: ready` first, then each event as a default
  `message` with JSON data, and `event: ping` after 25 seconds idle. Every client gets every event.

| Event                  | Carries                       | Client does                                         |
| ---------------------- | ----------------------------- | --------------------------------------------------- |
| `project.upserted`     | the project                   | Upserts it; an archived project drops its lane      |
| `project.deleted`      | `projectId`                   | Removes the lane and its tasks                      |
| `task.upserted`        | the full `TaskSummary` (card) | Replaces the card; an archived task is removed      |
| `task.deleted`         | `taskId`                      | Removes the card, resets an open panel's query      |
| `task.detail_changed`  | `taskId`                      | Invalidates that task's detail query                |
| `integrations.changed` | T3 Code status                | Patches the board's T3 status, invalidates the integrations query |
| `labels.colors_changed` | every label colour override  | Replaces the board's `labelColors`                  |
| `autopilot.changed`    | Autopilot's pause and runs in flight | Replaces the board's `autopilot` ([autopilot](autopilot.md)) |

`task.upserted` is always followed by `task.detail_changed`. Changes that only affect a task's detail send
`task.detail_changed` alone.

### Web app

- `useBoardEvents` (`apps/web/src/state/queries.ts`), mounted once in `AppLayout`, opens the
  `EventSource` and applies events with `applyBoardEvent` (`state/boardReducer.ts`).
- **Reconnect:** EventSource retries by itself; if it gives up, the hook reconnects with backoff (500 ms
  doubling to 5 s). On a `ready` after a reconnect it invalidates the board, archived tasks and every
  task query. There's no replay ([ADR 0005](../decisions/0005-sse-without-replay.md)).
- **Token:** EventSource can't send headers, so `eventsUrl()` adds `?token=` when one is set.

### Mutations

The hooks in `state/mutations.ts` don't write their results into the cache: the server's event brings
the change. Errors become toasts, unless the caller handles them. Two exceptions write the response: settings
replace the settings query, and `useSetLabelColor` replaces the board's `labelColors`.

Edits the user should see at once are applied to the cache before the request:

- **Moving a card:** `useMoveTask` applies the move (`optimisticMove`) so a drag never snaps back while
  the request is in flight. On failure it rolls back only if the card is still where the optimistic move
  put it (`rollbackMove`), so a newer event isn't undone.
- **Lanes:** collapsing and reordering projects patch the board (`Board.tsx`, `ProjectsSection.tsx`).
- **Task detail:** step and phase edits (`usePlanActions.ts`) and removing a link (`LinksSection.tsx`)
  patch the open task's detail.
- **Label colours:** `useSetLabelColor` patches `labelColors` before the request and refetches the board
  on error.

Apart from the card move and label colours, these are patched by the caller and refetch the query on
error. Follow the same
pattern for new edits that must feel instant.

Label edits send the whole list, so `useSetTaskLabels` puts every call for a task in one mutation
`scope`: they reach the server in order, and an earlier list can't overwrite a later one. The Labels
section shows the intended list while edits are in flight.

### UI state

State that isn't server data lives in zustand stores in `state/ui.ts`: board filters (not the search),
column collapse, appearance, pinned panel actions, the panel's section layout and the palette's last
project are persisted under `storageKey(...)`; dialogs and panel requests aren't. The label and project
filters live in the URL (`?labels=`, `?project=`). See [board-layout.md](board-layout.md).

## Decisions

- **Whole cards, not field patches.** `task.upserted` carries the full summary, so the reducer replaces
  rather than merges and can't get a card half right.
- **Detail is refetched, not pushed.** Detail (plan, events, reviews) is larger and only needed for the
  open panel, so the event only says it changed.

## Code map

| File                                     | What it does                                                    |
| ---------------------------------------- | --------------------------------------------------------------- |
| `apps/server/src/bus.ts`                 | `EventBus`                                                      |
| `apps/server/src/services/core.ts`       | `write` and `flush`: which events a write produces              |
| `apps/server/src/sse.ts`                 | `GET /events`                                                   |
| `packages/contracts/src/schemas.ts`      | `BoardEvent`, `TaskSummary`                                     |
| `apps/web/src/state/queries.ts`          | Queries and `useBoardEvents`                                    |
| `apps/web/src/state/boardReducer.ts`     | `applyBoardEvent`, optimistic moves and rollback (tested)       |
| `apps/web/src/state/mutations.ts`        | Mutations, `useMoveTask`, `useSetLabelColor`                    |
| `apps/web/src/state/ui.ts`               | zustand UI stores                                               |
| `apps/web/src/lib/api.ts`                | `api()` fetch wrapper, token capture, `eventsUrl()`             |
