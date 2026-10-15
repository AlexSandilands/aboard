# 0003 Localhost only, with an Origin check

Status: Accepted

## Context

The server holds the user's task data and can act on their behalf (start T3 Code threads, run Claude Code
headless in a checkout). It has no user accounts. A local HTTP server is still reachable by any web page the
user visits, through cross-site requests and DNS rebinding.

## Decision

- The server binds `127.0.0.1` only.
- `apps/server/src/http/guard.ts` rejects requests whose `Host` isn't a local name (stops DNS rebinding),
  and requests with an `Origin` that isn't a local http(s) origin on the server's port or the Vite dev
  port (stops cross-site writes from browsers).
- Requests without an `Origin`, such as agents and CLIs, are allowed.
- An optional bearer token (`brandEnv("TOKEN")`) adds auth for `/api/*`, `/mcp` and `/events` when the
  machine is shared: an `Authorization: Bearer` header, or a `token` query parameter (EventSource can't
  send headers, and the desktop's "Copy MCP URL" uses it).

There are no accounts, sessions or roles.

## Consequences

- Agents connect with no setup beyond the MCP URL.
- Any local process can use the API. That's accepted for a single-user tool; the token exists for when it
  isn't.
- New endpoints are covered automatically. Don't add routes that bypass the guard, and keep the
  `/api/health` exemption to the token check only (the desktop shell uses it to find a running server).
- Remote or multi-user hosting would need real auth first.
