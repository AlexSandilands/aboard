# 0005 Live updates patch the cache, with no replay

Status: Accepted

## Context

Agents change tasks while the user watches the board, so the UI must update within a second without a
reload. The board snapshot is small: one user's projects and their open tasks.

## Decision

- The server pushes every `BoardEvent` to every browser over server-sent events (`GET /events`).
  `task.upserted` carries the whole card (`TaskSummary`), so the client replaces it rather than merging
  fields.
- The web app applies events to the TanStack Query cache (`apps/web/src/state/boardReducer.ts`) and
  refetches an open task's detail on `task.detail_changed`.
- There are no event ids and no replay. After a reconnect the client refetches the board and task
  queries.
- The server's events are the source of truth. The mutation hooks don't write their results into the
  cache. Small edits the user sees at once (moving a card, collapsing or reordering lanes, plan edits,
  removing a link) patch the cache optimistically, and refetch or roll back on error; the event that
  follows confirms them.

## Consequences

- One code path keeps the UI current, whether the change came from the UI, an agent or a poller.
- No event log to store, version or trim.
- A dropped connection costs one refetch, which is cheap at this size. If snapshots grow large, revisit
  with event ids and `Last-Event-ID`.
- Events are not filtered per client, so every connected tab gets everything.
