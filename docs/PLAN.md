# Aboard — Implementation Plan (v1)

A local, agent-integrated kanban board for tracking work across many projects. Agents log ideas and
tasks, write structured plans, and advance them through statuses over MCP; the web UI updates live.
Styled to match T3 Code exactly. Integrates with T3 Code when present, works without it.

Status: **approved scope, ready to build.** Style source of truth: [STYLE_REFERENCE.md](STYLE_REFERENCE.md).

---

## 1. Goals and non-goals

**Goals (v1)**
1. Board with one **swimlane per project** and five status columns: `Ideas → Planned → In Progress → Review → Done`.
2. **Plan gate:** anything may sit in Ideas with no plan. A task can only leave Ideas once its plan has at least one step.
3. **Structured plans:** ordered phases → steps. Each step has a status (`todo | in_progress | done | blocked | skipped`) and optional markdown notes. Rendered as an interactive timeline with a "you are here" marker.
4. **Live updates:** agents and the UI write through the same service layer. Every mutation is pushed to open browsers over Server-Sent Events.
5. **Agent API:** an MCP endpoint (streamable HTTP) plus a REST API underneath. Ships with an agent skill/snippet telling agents how to use it.
6. **Links:** PRs (live state via `gh` for GitHub URLs), Jira keys (plain links), T3 Code threads (deep link), arbitrary URLs.
7. **T3 Code integration (optional, auto-detected):** "Open in T3 Code" thread links, read-only project import, optional live thread status.
8. Card click opens a **right-hand detail panel** in the T3 style. Drag-and-drop between columns.
9. Pixel-faithful T3 Code look: tokens, glass surfaces, grain, sidebar, command palette, project icons.

**Non-goals (v1)** — explicitly out, to fight scope creep:
- Hosting, multi-user, auth beyond a localhost guard.
- Jira API sync (links only). Azure DevOps / Bitbucket PR status (links only; GitHub via `gh` only).
- Git clone / "new repo" project sources. Projects are added by local folder, by T3 import, or as path-less projects.
- Custom columns, custom themes, mobile layout, cross-lane drag (moving a task between projects is a field edit).
- Any modification of T3 Code or writes to its data files. _(Revised: the board may start threads through T3's own
  API when the user asks; see [integrations/agent-handoff.md](integrations/agent-handoff.md).)_

---

## 2. Decisions (from scoping)

| Topic | Decision |
|---|---|
| Location | `C:\Code\taskboard`, own git repo, working name **aboard** (see root `package.json`) |
| Columns | Ideas (no plan needed) → Planned → In Progress → Review → Done |
| Projects | Own DB keyed by normalized `workspaceRoot`; T3-style icon system; optional read-only T3 import |
| Agent API | MCP (streamable HTTP at `/mcp`) + REST (`/api/*`) |
| Links | Store PR URLs / Jira keys; live PR state via `gh` CLI |
| Plan model | Structured phases + steps with statuses, plus a markdown `context` field |
| Thread links | Auto-detected: `t3code://threads/<env>/<thread>` (desktop), fallback `http://<t3-origin>/<env>/<thread>` |
| Stack | Lean TS: Node 24 + Hono + `node:sqlite` (no native deps) + zod contracts; Vite + React 19 + Tailwind v4 + `@base-ui/react` + dnd-kit + TanStack Router/Query + zustand |

---

## 3. Architecture

```
taskboard/
  package.json, pnpm-workspace.yaml, tsconfig.base.json, NOTICE (T3 Code MIT attribution)
  packages/contracts/     zod schemas + inferred types shared by server & web (no runtime logic beyond helpers)
  apps/server/            Hono app: REST, SSE, MCP, services, SQLite, pollers, T3 integration
  apps/web/               Vite React app
  skills/aboard/       SKILL.md for Claude Code + AGENTS snippet for other agents
  docs/                   PLAN.md, STYLE_REFERENCE.md, user README content
```

**One process.** `pnpm dev` runs the server (tsx watch, port **4317**) and Vite (port 5317, proxying `/api`, `/mcp`, `/events` to the server). `pnpm start` builds the web app and the server serves `apps/web/dist` statically on 4317. Bind `127.0.0.1` only.

**Data flow.** REST handlers, MCP tools, and pollers all call the same `services/*` functions. Each mutation:
1. runs in a SQLite transaction,
2. appends a row to `task_events` (the activity log),
3. publishes a typed `BoardEvent` on an in-process bus.

`GET /events` (SSE) streams bus events to browsers. The web app applies them to the TanStack Query cache. On reconnect it refetches `GET /api/board`. There is no replay protocol — the snapshot is small.

**Localhost guard.** Reject requests whose `Host` is not `127.0.0.1:<port>`/`localhost:<port>`. For browser-originated writes, check `Origin` (DNS-rebinding defence). Optional `ABOARD_TOKEN` env enables bearer auth for `/api` and `/mcp`. That's it.

**Data dir.** `~/.aboard/` holds `data.sqlite` and `settings.json`. Override with `ABOARD_HOME`. Tests use a temp dir.

---

## 4. Data model (SQLite via `node:sqlite`)

Plain SQL migrations in `apps/server/src/db/migrations/NNN_name.sql`, applied at startup and tracked in a `migrations` table. A thin typed repository layer per table (no ORM). Rows are mapped to contract types. Enable WAL and `foreign_keys=ON`.

```sql
projects(
  id TEXT PK,                 -- uuid
  title TEXT NOT NULL,
  workspace_root TEXT,        -- absolute path as given; nullable for path-less projects
  workspace_key TEXT UNIQUE,  -- normalized: lowercased on win32, forward slashes, no trailing slash
  icon_json TEXT,             -- ProjectIcon | null (null => derived monogram + color)
  t3_project_id TEXT,         -- set by T3 import / matching
  position TEXT NOT NULL,     -- fractional index (lane order)
  collapsed INTEGER DEFAULT 0,
  archived_at TEXT, created_at TEXT, updated_at TEXT)

tasks(
  id TEXT PK,                 -- uuid
  number INTEGER UNIQUE,      -- human id, global autoincrement, shown as #42
  project_id TEXT FK,
  title TEXT NOT NULL,
  description TEXT,           -- markdown: what/why (set at idea time)
  plan_context TEXT,          -- markdown: plan summary/approach/decisions
  status TEXT CHECK in (idea, planned, in_progress, review, done),
  position TEXT NOT NULL,     -- fractional index within (project_id, status)
  archived_at TEXT, created_by TEXT, created_at TEXT, updated_at TEXT, status_changed_at TEXT)

plan_phases(id PK, task_id FK CASCADE, title, position, created_at, updated_at)
plan_steps(id PK, phase_id FK CASCADE, task_id FK CASCADE, title, notes, -- markdown
  status CHECK in (todo, in_progress, done, blocked, skipped),
  position, started_at, completed_at, updated_at)

task_links(id PK, task_id FK CASCADE,
  kind CHECK in (pr, jira, t3_thread, url),
  url TEXT, label TEXT,
  ref_json TEXT,       -- pr: {host, repo, number}; jira: {key}; t3_thread: {environmentId, threadId}
  snapshot_json TEXT,  -- pr: PrSnapshot; t3_thread: {title, status} — refreshed by pollers
  synced_at TEXT, created_at TEXT,
  UNIQUE(task_id, kind, url))

task_events(id INTEGER PK, task_id FK CASCADE, at TEXT, actor TEXT, -- "user" | agent label
  type TEXT,           -- created | status_changed | plan_set | step_updated | note | link_added | ...
  payload_json TEXT)

settings(key PK, value_json)   -- t3 integration config, gh polling toggle, jira base url, theme default
```

**Rules enforced in services (with tests):**
- **Gate:** moving to any status other than `idea` requires ≥1 plan step. Violations return a typed `PLAN_REQUIRED` error; the UI and agents both surface it.
- `create_task` with a plan lands in `planned`. Without a plan it lands in `idea`.
- Clearing a plan from a non-idea task is rejected (`PLAN_REQUIRED`).
- **"Current step"** is derived, never stored: the first `in_progress` step, else the first `blocked`, else the first `todo` after the last `done`.
- **Progress** = done + skipped over total.
- **Attention** is derived: any blocked step; a PR with failing checks, changes requested, or conflicts; or a T3 thread awaiting input. It drives card rings and the sidebar "Needs attention" section.
- Ordering uses the `fractional-indexing` package. Moves pass `beforeId`/`afterId`, and the server computes the key.

---

## 5. Contracts (`packages/contracts`)

zod schemas, exported as both schemas and `z.infer` types:
- `TaskStatus`, `StepStatus`, `LinkKind`
- `ProjectIcon`: `{kind:"lucide",name,color} | {kind:"emoji",emoji} | {kind:"monogram",text,color}`, with `ProjectIconColor` being T3's 18 colours.
- `Project`, `Task`, `TaskSummary` (card payload: task + progress + current step + links + attention), `TaskDetail` (+ phases/steps + events)
- `PlanInput` (`{context?, phases:[{title, steps:[{title, notes?, status?}]}]}`)
- `PrSnapshot`, `T3ThreadRef`
- `BoardSnapshot` (`{projects, tasks: TaskSummary[]}`)
- `BoardEvent`, a discriminated union: `project.upserted | project.deleted | task.upserted (TaskSummary) | task.deleted | task.detail_changed {taskId}`
- `ApiError` codes: `NOT_FOUND | PLAN_REQUIRED | VALIDATION | CONFLICT`
- Helpers: `deriveProjectIdentity(title)`, a port of T3's monogram + colour hash, and `normalizeWorkspaceKey(path)`.

---

## 6. Server (`apps/server`)

```
src/
  main.ts               boot: open db, migrate, build app, start pollers, listen
  app.ts                Hono app composition (exported for tests via app.request)
  db/                   connection, migrations runner, migrations/*.sql, repos/*
  services/             projects.ts, tasks.ts, plans.ts, links.ts, events.ts (bus), board.ts
  http/                 routes/*.ts — thin: parse with zod → call service → map errors
  sse.ts                GET /events
  mcp/                  server.ts (McpServer + StreamableHTTPServerTransport), tools/*.ts
  integrations/
    github.ts           gh-based PR poller
    t3.ts               discovery, deep links, shell polling, project import
  fs.ts                 GET /api/fs/browse for the Local folder picker
```

**REST (all JSON, zod-validated):**
- `GET /api/board`
- `GET|POST /api/projects`, `PATCH|DELETE /api/projects/:id`, `POST /api/projects/reorder`
- `GET /api/tasks/:id` (detail), `POST /api/tasks`, `PATCH /api/tasks/:id`, `POST /api/tasks/:id/move {status, beforeId?, afterId?}`, `DELETE /api/tasks/:id` (permanent delete; archived tasks only)
- `PUT /api/tasks/:id/plan` (replace), `PATCH /api/steps/:id`, `POST /api/phases/:id/steps`, `POST /api/tasks/:id/phases`, `POST /api/steps/:id/move`, `DELETE /api/steps/:id`, `DELETE /api/phases/:id`
- `POST /api/tasks/:id/links`, `DELETE /api/links/:id`, `POST /api/tasks/:id/notes`
- `GET /api/fs/browse?path=` (directories only, `~` expansion, Windows drive roots)
- `GET|PATCH /api/settings`, `GET /api/integrations/t3/status`, `POST /api/integrations/t3/import-projects`, `POST /api/links/:id/refresh`

**MCP (`/mcp`)**, using `@modelcontextprotocol/sdk` `McpServer` with stateless streamable HTTP via Hono's Node adapter.

Tools take an optional `actor` label (default: the client name from initialize). Projects resolve by `projectId`, or by `workspacePath` (agents know their cwd); an unknown path auto-creates a project with derived identity.

| Tool | Purpose |
|---|---|
| `board_overview` | Projects with counts per status + attention items. Cheap orientation call. |
| `list_tasks` | Filter by project/path, status, text, attention. Returns compact summaries. |
| `get_task` | Full detail: description, plan context, phases/steps with statuses, current step, links, last 20 events. **The "where was I" call.** |
| `create_idea` | title, description?, project. Lands in Ideas. |
| `create_task` | title, description?, project, **plan (required)**, links?, t3Thread?. Lands in Planned. |
| `set_plan` | Replace the plan (phases/steps/context). Preserves statuses of steps matched by id. |
| `add_steps` | Append steps to a phase (or a new phase). |
| `update_step` | status and/or notes (append or replace) by step id. Also accepts `stepNumber` ("2.3"). |
| `move_task` | Change status; returns `PLAN_REQUIRED` guidance when gated. |
| `update_task` | title, description, archive; explicit `moveToProjectId`/`moveToWorkspacePath` to move projects. |
| `delete_task` | Permanently delete an archived task (plan, links and activity cascade). Refuses active tasks. |
| `add_note` | Free-form progress note → activity log ("handover notes"). |
| `link` | Attach PR URL / Jira key / T3 thread `{environmentId, threadId}` / URL. Idempotent. |

Tool descriptions are written for agents: when to call, what a good plan looks like (3–8 steps per phase, verifiable titles), and to call `get_task` before resuming work. Responses include a compact plaintext rendering of the plan (`1.2 [x] Write migrations`) so agents don't need to parse JSON.

**GitHub poller (`integrations/github.ts`):**
- Every 2 minutes, for PR links on non-archived tasks whose host is `github.com`, run `gh pr view <url> --json number,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup,headRefName,baseRefName,updatedAt,url`.
- Concurrency is 4. Runs are skipped when `gh` is missing or unauthenticated; that state shows in settings.
- Computes `PrSnapshot { state: open|draft|merged|closed, checks: passing|failing|pending|none, reviewDecision, mergeable, title }`. Writes it only on change, and emits `task.upserted`.
- Manual refresh is available per link. Non-GitHub PR URLs (Azure DevOps, Bitbucket) are stored as `pr` links with no snapshot.

**T3 integration (`integrations/t3.ts`)** is entirely optional. Every feature degrades gracefully.
- **Discovery:** read `~/.t3/userdata/server-runtime.json` → `origin`. Then `GET <origin>/.well-known/t3/environment` (unauthenticated) → `environmentId`, `label`. Re-check every 60s. Expose `{detected, origin, environmentId}` in the board payload.
- **Deep links** are computed in the web app:
  - desktop: `t3code://threads/<environmentId>/<threadId>`
  - browser: `<origin>/<environmentId>/<threadId>`
  - A setting picks the primary link (default: desktop), and the other is in a menu.
  - Thread links store their own `environmentId`, so links survive T3 restarts and can point at other environments.
- **Live thread status (opt-in):** the user pastes a token minted with `t3 auth session issue --scope orchestration:read --token-only`. Every 20s while any browser is connected, poll `GET <origin>/api/orchestration/shell` with `Authorization: Bearer` and `x-t3-orchestration-protocol: 2`. Map linked threads to `{title, status}` (working / waiting / input / failed / done) and update the link snapshot. **Verify this request shape against the live server in phase 4 before building UI on it. If the bearer isn't accepted on that route, ship without live status — it's a nice-to-have.**
- **Project import:** "Import from T3 Code" lists T3 projects not already present (matched by `workspace_key`) and imports the selected ones with title + `project_icon_json`.
  - Source 1: the shell API, if a token is configured.
  - Source 2: copy `statev2.sqlite` (+ `-wal`, `-shm` if present) to a temp dir, open the copy read-only with `node:sqlite`, and `SELECT project_id, title, workspace_root, project_icon_json FROM projection_projects WHERE deleted_at IS NULL`. Delete the copy afterwards. **Never open T3's live database file directly.**

---

## 7. Web app (`apps/web`)

**Foundation** (copied/adapted from T3 Code — see STYLE_REFERENCE.md):
- `src/index.css`: Tailwind v4 import, custom variants, `@theme inline` token mapping, `:root` + dark tokens, the sidebar scope, glass utilities (`surface-glass`, `dropdown-glass`, `dialog-glass`, `dialog-backdrop`), `surface-grain`, the scrollbar, `text-2xs`/`3xs`, radius scale, skeleton/status-pulse keyframes (stepped), `.no-transitions`. Drop the contrast layer (`--contrast-*` → raw tokens), the theme-palette bridge, and anything chat/terminal/diff-specific.
- `src/lib/utils.ts`: `cn` (`cx` + extended tailwind-merge).
- `src/components/ui/*`, copied from T3 and trimmed of app-specific imports: button, badge, input, textarea, dialog (+ dialog-styles), sheet, popover, menu, tooltip, select, combobox, autocomplete, command, kbd, scroll-area, separator, switch, toggle, toggle-group, collapsible, skeleton, spinner, empty, toast, alert, sidebar (simplified).
- Theme: `dark` class on `<html>`, light/dark/system, with an inline boot script in `index.html` to avoid flash (port T3's). Default dark.
- `ProjectFavicon`, `ProjectMonogram`, `projectIconColors.ts`, `projectIdentity.ts` (ported), and `ProjectIconPickerDialog` (lucide / emoji / monogram + 18 swatches).
- Optional: port `SidebarStageBackdrop.tsx` (the night-sky art) for the sidebar header. It's cheap and is the look the user likes.

**Layout:**

```
┌ Sidebar (resizable, bg-sidebar surface-grain) ┬ Main (bg-background surface-grain) ──────────┬ Detail panel ┐
│ brand row (52px) + stage art                  │ header 52px: "Board", filters, Ctrl+K hint    │ (resizable,  │
│ [Search........] [filter][+project][new task] │ sticky column headers: Ideas | Planned | ...  │  540px,      │
│ NEEDS ATTENTION (n)  — compact task rows      │ ▸ lane: [icon] store   3·2·1·0·4   [+]        │  ?task=ID)   │
│ PROJECTS — rows w/ favicon, counts, gear      │   cards in 5 columns                          │              │
│                                               │ ▸ lane: [icon] t3code  ...                    │              │
└───────────────────────────────────────────────┴───────────────────────────────────────────────┴──────────────┘
```

**Sidebar:**
- Header row has a search field (filters cards by title, `#number` or Jira key) and three `size-7` icon buttons:
  - **project filter**: the T3 combobox with "All projects", projects with favicon, and a gear per row;
  - **add project**: opens the palette at the Sources step;
  - **new task**: opens the palette at "New idea / New task in…".
- "Needs attention" uses T3 sidebar thread-row styling: project favicon + name, status text with an icon, title, and the reason line.
- The project list click-scrolls to a lane; right-click/gear opens project settings.

**Board:**
- Lanes are ordered by project position. Lanes can be dragged to reorder via the sidebar list, collapse persists, and empty lanes show a subtle "+ Add idea".
- Columns are fixed-width (~272px) with horizontal scroll. The header is sticky.
- Done shows the 5 most recent, plus "Show N more". Archived tasks are hidden (filter toggle).
- Filter popover: by project, attention only, has-PR, show archived.

**Card** (T3 sidebar-row × settings-card styling: `rounded-xl border border-border/60 bg-card/40`, hover `bg-accent/40`):
- line 1: `#42` (mono, muted) · Jira key chip · attention icon (`text-warning` / `text-error`) · relative time (`23h`), right-aligned.
- line 2: title, `text-sm font-medium text-foreground/90`, 2-line clamp.
- line 3: segmented progress bar (T3 `TaskSegments` style, up to 12 segments then a continuous bar) + `3/7` + current step title, truncated, `text-xs text-secondary-label`.
- line 4 (only if links exist): PR chip (T3 PR state colours, + checks dot) · T3 thread icon button (opens deep link; title tooltip; live status dot if available).
- The selected card gets `bg-sidebar-row-selected`/ring. Attention cards get `ring-1 ring-warning/40`. Use `content-visibility:auto` for long columns.

**Drag and drop:** dnd-kit `DndContext` with multi-container `SortableContext`s keyed `projectId:status`.
- `PointerSensor` (distance 6) + `KeyboardSensor`, and a `DragOverlay` rendering the card. Cross-lane drops are disallowed (the lane is highlighted as invalid).
- Optimistic move: the cache is updated immediately and rolled back on error.
- A `PLAN_REQUIRED` rejection shows a toast with a "Write plan" action that opens the detail panel's plan editor.
- Click is suppressed after a drag (T3 `suppressClickAfterDragRef` pattern).

**Detail panel** (route search param `?task=<id>`, so it's linkable; Esc closes). Docked right, resizable (T3 `useResizableWidth` + handle), styled like T3's `PreviewPanelShellFrame` / `ThreadDetailsCard`:
1. **Header (52px):** `#42`, status `Select` (gated options disabled with tooltip), menu (move project, archive, copy link, copy MCP id).
2. **Title** inline-editable; project chip.
3. **"Where it's up to" callout:** current step (phase › step), its notes, the last activity note + actor + time. This is the first thing seen when returning to work.
4. **Links section** (T3 thread-details row style, `h-8 rounded-lg text-[13px]`):
   - "Open in T3 Code" (primary deep link, split-menu for the browser link, thread title + live status);
   - PR rows (state icon/colour, `#123 title`, checks, review);
   - Jira rows (key → `jiraBaseUrl/browse/KEY` if configured);
   - URLs;
   - "+ Add link" popover (auto-detects kind from the pasted text).
5. **Plan timeline**: the centrepiece, described below.
6. **Description** and **Plan context**: markdown (react-markdown + remark-gfm, with T3's `.chat-markdown` CSS ported), click to edit (Textarea).
7. **Activity**: compact log (T3 WorkLog line style), newest first, collapsible.

**Plan timeline (centrepiece):**
- **Phases** are collapsible groups. Each header shows the phase title, `done/total`, and a mini segmented bar. Phases containing the current step auto-expand; fully done phases auto-collapse.
- **Steps** sit on a vertical rail: a 1px `bg-border` line with a node per step.
- Node icons (lucide, colour per T3 task-list semantics):

  | Status | Icon | Colour |
  |---|---|---|
  | done | `CheckIcon` on `bg-success/16` | `text-success` |
  | in_progress | `CircleDotIcon` | `text-primary` (rail segment above it tinted primary) |
  | todo | `CircleIcon` | `text-muted-foreground/40` |
  | blocked | `CircleAlertIcon` | `text-warning` |
  | skipped | `CircleSlashIcon` | `text-muted-foreground/40` (title struck through) |

- The **current step** gets a "you are here" treatment: `bg-primary/6` row, `ring-1 ring-primary/20`, and a small `Now` badge. **No continuous animation** (T3 rule) — static emphasis only.
- **Interactions:**
  - Click the node to cycle `todo → in_progress → done`. A menu offers blocked/skipped.
  - Click the title to edit inline.
  - Expand a step to show/edit its notes (markdown).
  - Hover shows timestamps (started/completed).
  - Drag handle reorders within and across phases (dnd-kit, vertical).
  - "+ Add step" per phase and "+ Add phase".
- **Empty plan state** (Ideas): an `Empty` component with "No plan yet" and two actions: **Write plan** (editor) and **Paste plan** (markdown → plan parser).

**Plan editor / parser:**
- `parsePlanMarkdown` (in contracts, unit-tested) converts `## Phase` headings + `- [ ]`/`- [x]`/`1.` list items into `PlanInput`. Text under an item becomes notes. With no headings, everything goes into a single phase named "Plan".
- Used by "Paste plan", and accepted by MCP `set_plan` as an alternative `markdown` input. Agents in plan mode can pass their plan through directly.

**Command palette** (Ctrl/Cmd+K; T3 `command.tsx` + view-stack pattern + Kbd footer):
- Root items: New idea…, New task…, Add project…, Import from T3 Code…, Go to task… (fuzzy over `#n` / title), Go to project…, Toggle theme, Settings.
- **Add project → Sources:**
  - "Local folder": browse via `/api/fs/browse` with T3's path-typing UX, `..` entry, Enter to add.
  - "From T3 Code": multi-select list; disabled with a "Setup Required"-style badge when T3 isn't detected.
  - "Without a folder": title only.
- **New idea:** pick a project (defaults to the filtered or last-used one), then type a title, then Enter. New task opens the panel on a fresh idea with the plan editor focused.

**Project settings** (dialog from the gear): name, icon (picker dialog), workspace path (browse), linked T3 project (auto-matched, shown read-only), archive project.

**App settings** (dialog): theme; T3 integration (detected origin/env, token field for live status, "Test connection"); GitHub (gh detected/auth status, polling toggle); Jira base URL; MCP setup snippet with copy buttons (`claude mcp add --transport http aboard http://127.0.0.1:4317/mcp`, the Codex, GitHub Copilot CLI and Copilot-in-VS-Code equivalents, and the skill install path).

**Client state:**
- TanStack Query for the board snapshot + task detail. A `useBoardEvents()` hook opens `EventSource('/events')` and patches the cache: `task.upserted` replaces the summary; `task.detail_changed` invalidates detail if open.
- zustand (persisted) for UI: sidebar width, panel width, collapsed lanes, filters.
- TanStack Router routes: `/` (board, `?task=`, `?project=` filter); settings are dialogs.

---

## 8. Agent workflow assets (`skills/aboard`)

- `SKILL.md`: a Claude Code skill (install by copying to `~/.claude/skills/aboard/`) covering:
  - At the start of meaningful work, `board_overview` / `list_tasks` for the cwd, then `get_task` if resuming.
  - When an idea comes up mid-work, `create_idea` (one call, don't derail).
  - Before implementation, ensure the task has a plan (`set_plan`), then `move_task in_progress`.
  - Keep steps current with `update_step` as each completes. Leave an `add_note` handover at the end of a session.
  - Link PRs when opened; move to `review` when a PR is up and to `done` when merged/verified.
  - **In T3 Code:** call `t3_thread_configuration` (→ `threadId`) and `t3_environment_read` (→ `environmentId`) once, then `link` the task to the thread. T3 exposes no env var for this, so the skill must say so explicitly.
- `AGENTS-snippet.md`: the same guidance condensed for `AGENTS.md`/`CLAUDE.md` in any repo, for Codex and other agents.
- The README documents MCP registration for Claude Code and Codex.

---

## 9. Testing and verification

- **contracts:** `parsePlanMarkdown`, `deriveProjectIdentity`, `normalizeWorkspaceKey` (Windows paths, case, trailing slashes).
- **server (vitest, temp data dir):**
  - services: plan gate, current-step derivation, attention derivation, fractional reorder, `set_plan` status preservation, archive;
  - REST via `app.request`;
  - MCP via the SDK `Client` + in-memory or HTTP transport against the app — create idea → set plan → move → update step → get_task;
  - SSE emits on mutation;
  - gh snapshot mapping from fixture JSON (no network);
  - T3 discovery with a fake runtime file + mocked fetch;
  - T3 sqlite import against a fixture DB built in the test.
- **web:** logic tests only (event→cache reducer, dnd move computation, deep-link builder). No static-markup render tests.
- **Typecheck + lint** per package (`tsc -b`, oxlint).
- **Manual/integrated pass:** run the app, drive it through MCP from a real Claude Code session, and screenshot the board, panel, and palette. **Ask the user before launching a browser for screenshots.**

---

## 10. Build phases (autonomous execution with subagents)

Each phase ends green: `pnpm -r typecheck && pnpm -r test`. File ownership is explicit to avoid conflicts between parallel agents. The orchestrator (main session) integrates between phases and reviews diffs.

**Phase 0 — Foundation (orchestrator, sequential).**
- Scaffold the pnpm workspace, tsconfig, vitest, oxlint, NOTICE, `.gitignore`, `git init`.
- `packages/contracts` complete (schemas + helpers + tests).
- Server skeleton: db + migrations + repos + empty Hono app + bus + SSE.
- Web skeleton: Vite + Tailwind v4 + `index.css` port + theme boot + `cn` + router shell.
- **Gate:** server boots, web renders an empty styled shell with the grain/sidebar, and tests pass.

**Phase 1 — parallel (4 agents, Sonnet 5.5 or Opus 5.5):**

| Agent | Owns | Delivers |
|---|---|---|
| A — Server core | `apps/server/src/services`, `http/`, `fs.ts` | All services + REST + gate/ordering/attention + tests |
| B — MCP + skill | `apps/server/src/mcp`, `skills/` | MCP server + all tools + agent-facing descriptions + MCP integration test + SKILL.md/snippet. Codes against service signatures defined in phase 0 (stubs if A is not done; rebase after). |
| C — UI primitives + project identity | `apps/web/src/components/ui`, `components/project/*`, `index.css` additions | Port T3 primitives listed in §7, ProjectFavicon/Monogram/IconPicker, toast provider, Empty/Skeleton, stage backdrop |
| D — Integrations | `apps/server/src/integrations` | gh poller + T3 discovery/import/shell-poll + settings routes for them + tests. Verifies the T3 shell bearer request against the live server **read-only** (GET only, with a token the user mints) — or skips and reports. |

**Phase 2 — parallel (3 agents), after phase 1 merges:**

| Agent | Owns | Delivers |
|---|---|---|
| E — Shell + board | `src/routes`, `components/sidebar`, `components/board`, `state/` | App layout, resizable sidebar, attention + project lists, lanes, columns, cards, dnd-kit multi-container with gate handling, SSE cache sync, filters |
| F — Detail panel + plan timeline | `components/task/*` | Resizable docked panel, header/status select, "where it's up to", links section + deep links, plan timeline (all interactions), plan editor + paste parser, markdown sections, activity |
| G — Palette + dialogs | `components/command/*`, `components/settings/*` | Command palette with view stack, add-project sources + folder browser + T3 import, new idea/task flows, project settings dialog, app settings dialog incl. MCP snippet |

**Phase 3 — Integration and polish (orchestrator + 1 review agent).**
- Wire everything up and do a cross-surface pass: every action reachable from the board, panel, palette and MCP, plus reverse states (archive/unarchive, block/unblock).
- Performance pass: no continuous animations, `content-visibility` on cards, memoized cards, SSE patch not refetch.
- An independent review agent diffs against this plan and STYLE_REFERENCE, and reports gaps. Fix the gaps.

**Phase 4 — Verification.**
- Full test/typecheck.
- Start the app on 4317 and register its MCP in a real Claude Code session.
- Run the end-to-end scenario: create idea → plan → in progress → steps → PR link → T3 thread link → review → done, watching the UI update live.
- With user permission, take screenshots (board, panel, palette, light + dark) and compare against T3 side by side.
- Write the README.

**Definition of done (v1):**
- [ ] `pnpm dev` and `pnpm start` work on Windows; data persists in `~/.aboard`.
- [ ] Projects: add via folder browse, T3 import, or path-less; icon picker; reorder; collapse; archive.
- [ ] Ideas → plan gate → full status flow by drag and by status select; the gate error is clear in UI and MCP.
- [ ] Plan timeline: view, current-step emphasis, cycle status, edit, notes, reorder, add phase/step, paste markdown.
- [ ] Links: PR with live gh state + attention; Jira; T3 thread opens T3 desktop (and browser fallback).
- [ ] An MCP session can do the full scenario, and the UI reflects each call within ~1s without reload.
- [ ] Visual parity with T3 Code in dark and light (tokens, grain, glass popovers, sidebar, palette, typography).
- [ ] Skill + AGENTS snippet + README written; tests green.

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `node:sqlite` API gaps (still experimental-flagged in some Node versions) | Node 24.12 ships it without a flag. Keep repos thin so swapping to better-sqlite3 is a one-file change. |
| T3 shell API rejects CLI-minted bearer tokens / requires DPoP | Phase 1-D verifies first. If it fails, drop live thread status; links and import (via sqlite copy) still work. |
| `t3code://` not registered (dev builds of T3) | The browser link fallback is always offered in the split menu. |
| Copying T3 primitives drags in app-specific deps | Agent C trims imports and replaces T3-internal hooks with minimal local equivalents. Lint for unresolved imports. |
| dnd-kit multi-container complexity | Keep cross-lane disabled. A single `onDragOver`/`onDragEnd` reducer in a pure, tested function. |
| Agents bypass the plan gate by skipping planning | Tool descriptions + skill explain the gate. `create_task` requires a plan; `create_idea` is the cheap path. |
