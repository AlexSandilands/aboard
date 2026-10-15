# Live sync

Every open board updates within a second when anything changes, whether the change came from the UI, an
agent over MCP or a poller. The server pushes events over server-sent events, and the web app applies them
to its TanStack Query cache.

## How it works

### Server

- Services publish `BoardEvent`s on the in-process `EventBus` after each committed write
  ([architecture.md](../architecture.md#how-a-change-flows)).
- `GET /events` (`apps/server/src/sse.ts`) sends `event: ready` first, then each event as a default
  `message` with JSON data, and `event: ping` after 25 seconds idle. Every client gets every event.

| Event                  | Carries                       | Client does                                         |
| ---------------------- | ----------------------------- | --------------------------------------------------- |
| `project.upserted`     | the project                   | Upserts it; an archived project drops its lane      |
| `project.deleted`      | `projectId`                   | Removes the lane and its tasks                      |
| `task.upserted`        | the full `TaskSummary` (card) | Replaces the card; an archived task is removed      |
| `task.deleted`         | `taskId`                      | Removes the card, resets an open panel's query      |
| `task.detail_changed`  | `taskId`                      | Invalidates that task's detail query                |
| `integrations.changed` | T3 Code status                | Invalidates the integrations query                  |

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

`state/mutations.ts` doesn't patch the cache after a mutation: the server's event does. Errors become
toasts, unless the caller handles them.

Moving a card is the exception. `useMoveTask` applies the move optimistically before the request
(`optimisticMove`), so a drag never snaps back while the request is in flight. On failure it rolls back
only if the card is still where the optimistic move put it (`rollbackMove`), so a newer event isn't
undone.

### UI state

State that isn't server data lives in zustand stores in `state/ui.ts`: board filters, appearance,
pinned panel actions and the palette's last project are persisted under `storageKey(...)`; dialogs and
panel requests aren't.

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
| `apps/web/src/state/mutations.ts`        | Mutations and `useMoveTask`                                     |
| `apps/web/src/state/ui.ts`               | zustand UI stores                                               |
| `apps/web/src/lib/api.ts`                | `api()` fetch wrapper, token capture, `eventsUrl()`             |
