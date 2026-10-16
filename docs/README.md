# Docs

These docs are for people and agents changing this repo, except [guide/](#guides), which is for people
using the board and is linked from the root [README.md](../README.md). Conventions and commands are in [AGENTS.md](../AGENTS.md) and the AGENTS.md
files under each app.

## What goes where

| Doc                                      | Holds                                                                                  | Write or update it when                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `guide/<name>.md`                        | How to use one part of the board, for users: what it does and how to set it up         | What a user sees or has to do changes. Keep the detail of how it works in the feature doc   |
| [architecture.md](architecture.md)       | The system overview: packages, how a request flows, data model, guard, data dir        | A package, a cross-cutting flow, a table or an env var changes                           |
| `features/<name>.md`                     | How one feature works, the decisions behind it, the alternatives turned down, its code | You add a feature, or change how one behaves                                             |
| `decisions/NNNN-title.md`                | One cross-cutting decision (an ADR): context, decision, consequences                   | A choice constrains code beyond one feature. Never rewrite one; supersede it with a new one |
| `reference/<name>.md`                    | Lookup material that isn't about our behaviour, such as where the styles come from     | The source it describes changes                                                          |
| [templates/](templates/)                 | Starting points for feature docs and ADRs                                              | The shape of those docs changes                                                          |

## Rules

- **Docs describe the code as it is now.** Planned work belongs on the board, not here. A feature doc
  doesn't say "will"; if part of a feature isn't built, the doc says what's missing.
- **Docs change in the same PR as the behaviour they describe.** A PR that changes how a feature behaves
  updates its feature doc; one that changes a flow, a table or an env var updates `architecture.md`.
- **Decisions sit with what they decide.** A choice that only affects one feature goes in that feature
  doc's Decisions section. A choice that constrains several features or the whole repo gets an ADR.
- **ADRs are append-only.** To reverse one, write a new ADR and set the old one's status to
  `Superseded by [NNNN](NNNN-title.md)`. The next number is the highest existing number plus one.
- **Keep the product name out of prose** where a neutral phrase ("the board", "the server") works. The
  name lives in the root `package.json`.
- **Link with relative paths** and name code by path (`apps/server/src/services/tasks.ts`).
  `pnpm docs:check` (part of `pnpm check`) fails on broken relative links in Markdown files and on
  `docs/...` paths in source comments that don't exist.

## Index

- [architecture.md](architecture.md): start here.

### Guides

- [Using the board](guide/using-the-board.md): plans, closing, links, labels, layout, shortcuts
- [Templates](guide/templates.md): Bug, Spike, Feature and your own starting points for tasks
- [Importing issues](guide/importing-issues.md): a task from a Jira or GitHub issue URL
- [Connecting agents](guide/connect-agents.md): MCP setup and the shipped skill
- [Local review](guide/local-review.md): turning on the review loop
- [Autopilot](guide/autopilot.md): switching automations on, limits, pausing
- [T3 Code](guide/t3-code.md): thread links, pairing, starting threads
- [Configuration](guide/configuration.md): data folder, ports, access token, the desktop tray
- [Notifications](guide/notifications.md): the inbox, pop-ups, taskbar badge and what you're told about

### Features

- [Task lifecycle](features/task-lifecycle.md): statuses, the plan gate, closing, archiving, deleting, numbering
- [Plans](features/plans.md): phases and steps, the current step, Markdown plans
- [Epics](features/epics.md): grouping a feature's tasks, derived status, bands on the board
- [Templates](features/templates.md): starting points for tasks: title pattern, labels, plan, per project or board-wide
- [Task relations](features/relations.md): blocks / blocked by, the card lock, dependency lines
- [MCP](features/mcp.md): the agent API, its tools and how they're written
- [Live sync](features/live-sync.md): server-sent events and the web app's cache
- [Labels](features/labels.md): task labels, colours, filtering, and asking agents to suggest them
- [Board and panel layout](features/board-layout.md): collapsible columns and panel sections, links on cards
- [GitHub PRs](features/github-prs.md): live PR state and merging, on github.com and Enterprise hosts
- [Issue import](features/issue-import.md): a task from a Jira or GitHub issue URL, filled in by Claude Code
- [Agent hand-off](features/agent-handoff.md): copy a prompt, or start a T3 Code thread
- [Agent sessions](features/agent-sessions.md): linked Claude Code and Copilot CLI sessions, their status, resuming them in a terminal
- [Local review](features/local-review.md): the review loop before a PR
- [Desktop app](features/desktop.md): the Electron shell
- [Notifications](features/notifications.md): the attention inbox, OS pop-ups, badges
- [Backup and restore](features/backup.md): JSON dumps, restore, scheduled push to a git repo
- [Autopilot](features/autopilot.md): the automation engine: scopes, limits, runs, pause

### Decisions

- [0001 Services hold all business logic](decisions/0001-service-layer.md)
- [0002 SQLite through `node:sqlite`](decisions/0002-node-sqlite.md)
- [0003 Localhost only, with an Origin check](decisions/0003-localhost-guard.md)
- [0004 A task needs a plan to leave Ideas](decisions/0004-plan-gate.md)
- [0005 Live updates patch the cache, with no replay](decisions/0005-sse-without-replay.md)
- [0006 GitHub through its GraphQL API, with the token `gh` holds](decisions/0006-github-graphql-via-gh-token.md)
- [0007 An epic is a task with kind 'epic'](decisions/0007-epic-is-a-task-kind.md)
- [0008 Autopilot is a deterministic rule engine inside the server](decisions/0008-autopilot-engine.md)

### Reference

- [Style reference](reference/style.md): where the UI's styles come from in T3 Code
