# Aboard

A local kanban board for juggling work across many projects, built for working with coding agents.
Agents log ideas, write structured plans and move tasks along over MCP; the board updates live.
Styled after [T3 Code](https://github.com/pingdotgg/t3code), and integrates with it when it's running.

- **Swimlane per project**, columns **Ideas → Planned → In Progress → Review → Done**.
- **Plans first:** ideas can be rough, but a task can't leave Ideas until it has a plan.
  Plans are phases of steps; the detail panel shows exactly where a task is up to.
- **Links:** GitHub PRs (live state via `gh`), Jira keys, T3 Code threads (one click back to the
  conversation), any URL. Failing checks, requested changes and blocked steps surface under
  **Needs attention**.

## Run it

Requires Node 24+ and pnpm.

```sh
pnpm install
pnpm start        # builds the web app and serves everything on http://127.0.0.1:4317
pnpm dev          # development: server on 4317, Vite on http://127.0.0.1:5317
```

Data lives in `~/.aboard/` (override with `ABOARD_HOME`; all env vars use the `ABOARD_` prefix). The server only
listens on 127.0.0.1. Set `ABOARD_TOKEN` to require a bearer token on the API and MCP endpoint. With a token set, open the UI at `http://127.0.0.1:4317/#token=<token>`; the page keeps it for the browser tab and strips it from the address bar.

## Connect your agents

The MCP endpoint is `http://127.0.0.1:4317/mcp`.

```sh
claude mcp add --transport http aboard http://127.0.0.1:4317/mcp
codex mcp add aboard --url http://127.0.0.1:4317/mcp
```

Then give your agent the workflow:

- **Claude Code:** copy `skills/aboard` to `~/.claude/skills/aboard`.
- **Other agents:** paste `skills/aboard/AGENTS-snippet.md` into your `AGENTS.md` / `CLAUDE.md`.

Agents identify the project by passing their working directory, so there's nothing to configure
per repo. Unknown folders become new projects automatically.

## T3 Code integration (optional)

When T3 Code is running, it is detected automatically.

- **Thread links:** agents inside T3 Code attach their thread to the task. The card and detail
  panel then get an **Open in T3 Code** button (desktop app deep link, or your paired browser —
  choose in Settings).
- **Import projects:** command palette → _Add project → From T3 Code_. Read-only; this app never
  touches T3 Code's data files (it only starts threads through T3's own API when you ask it to).
- **Live thread status and Start in T3 Code:** mint a token and paste it in Settings → T3 Code:
  ```sh
  t3 auth session issue --scope orchestration:read --scope orchestration:operate --token-only
  ```
  Linked threads then show whether they're working, waiting for input, or done, and cards get a
  **Start in T3 Code** button that opens a new thread for the task (model, access, worktree and
  branch are picked in a dialog). `orchestration:read` alone is enough for status only.
- **Copy prompt:** every open task has a button that copies a ready-to-paste prompt for any agent
  (Claude Code, Copilot, …), with a planning variant for rough ideas. See
  [docs/integrations/agent-handoff.md](docs/integrations/agent-handoff.md).

## Keyboard

| Key          | Action                 |
| ------------ | ---------------------- |
| `Ctrl/Cmd K` | Command palette        |
| `N`          | New idea               |
| `Esc`        | Close the detail panel |

## Development

```sh
pnpm check       # format, lint, typecheck, unused-code check (knip), tests
pnpm format      # apply formatting
```

Git hooks (lefthook) are installed by `pnpm install`. Commits follow Conventional Commits. Contributor
and agent conventions are in `AGENTS.md`.

Layout: `packages/contracts` (shared zod schemas and helpers), `apps/server` (Hono, `node:sqlite`,
REST, SSE, MCP, integrations), `apps/web` (React, Tailwind v4, Base UI). Design notes live in
`docs/`.

UI primitives and design tokens are adapted from T3 Code under the MIT license — see `NOTICE`.
