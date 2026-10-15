# 0001 Services hold all business logic

Status: Accepted

## Context

The board is changed from three places: the web app over REST, agents over MCP, and background pollers
(GitHub, T3 Code, the review watchdog). If each kept its own rules, an agent could do what the UI forbids,
and a change from one surface might not reach the others.

## Decision

All business logic lives in `apps/server/src/services/*`. REST routes (`http/routes`), MCP tools
(`mcp/tools`) and pollers stay thin: validate input with a contracts schema, call a service, format the
result.

Every mutation goes through `core.write` (`services/core.ts`), which:

1. runs in one SQLite transaction;
2. appends a `task_events` row for each logged change (`fx.log`);
3. after COMMIT, publishes `BoardEvent`s on the in-process bus for whatever it marked changed.

## Consequences

- A rule enforced once (the plan gate, closing, review rounds) holds for every caller, and service tests
  cover all of them.
- The activity log and the live stream can't drift from the data: they're produced by the same write.
- A new surface (a CLI, another protocol) is a thin adapter over services.
- Code that writes to the database outside `core.write` breaks live updates and the activity log. Don't.
