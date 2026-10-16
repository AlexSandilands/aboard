# Handing tasks to agents

Board task: #9. Verified against T3 Code 0.0.46 (nightly, October 2026).

The board tracks work, but the work itself happens in an agent harness: Claude Code, Copilot, T3 Code and
similar. This document covers how a task on the board becomes a running agent session, and how that session
finds its way back to the task.

## How it works

### How the board and a harness talk to each other

There are two directions, and they use different channels.

**Agent → board: MCP.** Every agent session talks to the board through the MCP server at
`http://127.0.0.1:4317/mcp`. The agent reads the task (`get_task`), writes the plan (`set_plan`), updates
steps, links PRs and leaves handover notes. The skill in `skills/aboard/` teaches agents that workflow.
This direction works with any MCP-capable harness and needs no configuration on the board's side.

**Board → agent: a hand-off.** Starting a session is the harness's job, so the board can only help in a
harness-specific way. It offers two levels:

| Hand-off | Works with | What the board does | What you do |
|---|---|---|---|
| **Copy prompt** | Any harness with the MCP server registered | Copies a ready-to-paste prompt | Open a session, paste, send |
| **New T3 Code thread** | T3 Code, with a token set | Creates the T3 thread, starts the agent and links the thread to the task | Pick model and workspace, press Send |

Both hand-offs send the same kind of prompt, so the agent behaves the same either way.

### The hand-off prompt

The prompt is deliberately short. It points the agent at the task rather than copying the task's content,
so the agent always reads the current plan and notes from the board:

- the task reference (`#9 Easier way to hand an idea…`) and its board link (`<board>/?task=<id>`);
- "call `get_task` on the board's MCP server and follow the board's skill";
- for T3 launches, a note that the thread is already linked to the task, so the agent shouldn't link it again;
  otherwise, a request to link the Jira issue and, in T3 Code, the agent's own thread. Task results also
  list any **Missing links** until they are added.

It is built by one pure helper in `packages/contracts` (`taskHandoffPrompt`), so the copy button and the T3
launch can't drift apart.

#### Plan with me

A task in Backlog usually needs a conversation before it needs code. The **Plan with me**
option switches the prompt to a planning brief:

- the task has no plan yet, and the user wants to shape the plan together;
- explore the task and the relevant code, then ask clarifying questions;
- propose phases and steps, and wait for agreement;
- only then call `set_plan` and move the task to Planned. Don't implement anything.

The option only changes the prompt. T3 threads always start in T3's default interaction mode: T3's own plan
mode is a legacy beta behind a client setting the board can't read, and a thread started in it could be left
with no visible way to switch back. The option is on by default for tasks in
Backlog or without a plan, and off otherwise. The copy button offers "Copy prompt" and "Copy planning prompt".

#### Suggest epics (projects)

A project has one hand-off, in its lane header: **Suggest epics**, as a new T3 Code thread or a copied prompt. An
agent proposes epics for the project's open tasks and creates the ones the user agrees to. The launch dialog is
the same, without **Plan with me** or a task to link
([epics.md](epics.md#suggesting-epics)).

#### Orchestrate (epics) and subagents

An epic has no plan of its own, so it gets a third prompt, mode `orchestrate`: start the epic's tasks in other
sessions (subagents, or prompts for the user to paste), plan the unplanned ones with the user first, monitor
them and run the review loop for subagents. It is the only prompt an epic offers. A work prompt can also be
built for a **subagent** of that orchestrator, which reports back instead of asking the user or running its own
review loop. Both are described in [epics.md](epics.md#orchestrating-an-epic).

An orchestrator in any harness can also start an epic's tasks in T3 Code threads itself, with
`start_task_thread`. That is the launch below without the dialog: [epics.md](epics.md#t3-code-threads) says what it
picks instead.

Agents get the same prompts over MCP with `get_handoff_prompt(task, mode?, subagent?)`, which defaults the mode
like the menu does. Its board link points at this server when it serves the built web app, else at the Vite dev
server (`boardUrl` in `apps/server/src/mcp/shared.ts`). Under `pnpm dev` with a `dist/` left from an earlier
build, that means the server's stale copy on :4317 rather than Vite.

### Suggested model

Planning often wants the strongest model; implementing a well-planned task often doesn't. So the agent that
plans a task suggests a **model tier** for implementing it, and hand-offs use it.

- **The task stores a tier, not a model:** `suggestedModel` is `{tier: light | standard | deep, reason}` or
  null. Agents set it with `set_plan`, `create_task` or `update_task` (`null` clears it), and never need to
  know any harness's model names. The user can change or clear it under Details in the task panel. A change
  is logged as `suggested_model_changed`.
- **Settings → Model tiers** says what each tier means for you: a free-text description (e.g. "Sonnet 5.5,
  medium effort") for any harness, and, when T3 Code is connected, a T3 model with its effort and fast mode.
  The T3 model's label is saved with it, so prompts can name it without asking T3.
- **Copied work prompts** get one line: `Suggested model: standard (Sonnet 5.5, medium effort): <reason>.
  Switch your session's model if it differs.` The tier is named by its description, else its T3 label, else
  just the tier (`suggestedModelLine`).
- **The T3 launch dialog** starts a work launch on the tier's T3 model, and shows the suggestion under the
  composer. When the tier has no T3 model, its provider isn't ready or T3 no longer offers the model, it stays
  on T3's default and says why. Effort and fast mode values the model no longer supports are dropped.
- **Planning ignores it.** Planning prompts leave the line out, and turning on **Plan with me** switches the
  dialog to T3's default model (and back when turned off), unless you picked a model by hand. A
  board-started thread's prompt leaves the line out too: the thread already runs on the chosen model.

### Starting a thread in T3 Code

#### Setup

The board needs a T3 session token with two scopes:

```sh
t3 auth session issue --scope orchestration:read --scope orchestration:operate --token-only
```

Paste it in Settings → T3 Code. `orchestration:read` powers live thread status and the launch dialog's
options. `orchestration:operate` allows starting threads. The token is stored in the board's local
database and never sent to the browser.

The flag is `--scope`, repeated once per scope. Older instructions in this repo said `--scopes`, which T3's
CLI doesn't accept.

#### When the menu appears

The hand-off menu (a terminal icon) sits at the right of the card's bottom line and in the task panel
header. It only shows on open work: not on Done or archived tasks.

It offers "Copy prompt" and "Copy planning prompt", with the one that suits the task marked _Suggested_. An epic
offers only "Copy prompt to start its tasks" (its orchestrating prompt), and its T3 dialog has no
**Plan with me**. **New T3 Code thread…** is added at the top when all of these hold (`canStartT3Thread`):

- T3 Code is running (auto-detected from `~/.t3/userdata/server-runtime.json`);
- a token is set;
- the project has a T3 project id or a workspace folder T3 could know.

Linked threads don't hide it: a task can have several (a follow-up for conflicts, a review). Each linked
thread shows on the card while it is active, as a button that opens it in T3 Code; settled and archived
threads are listed in the panel only ([board-layout.md](board-layout.md#links-on-cards)).

Whether T3 really has the project (by its id, or the same folder) is checked when the dialog opens. If it
doesn't, the dialog says so and offers to copy the prompt instead.

#### The launch dialog

**New T3 Code thread…** opens a dialog modelled on T3's own new-thread screen:

- the prompt, editable before sending, and the **Plan with me** toggle;
- **model**: providers down the side with favorites first, search, a Legacy models section and NEW badges;
- **effort** (and fast mode where the model has it) and **access**: Supervised, Auto-accept edits, Auto or
  Full access, limited to what the provider supports;
- **workspace**: Current checkout, New worktree or Previous worktree;
- **branch**: a searchable list of refs, labelled current, worktree, remote or default. The list holds the
  first 100 refs T3 returns, searched in the browser; a branch beyond that can't be picked yet.

The choices start from your T3 settings, resolved the way T3 resolves them for a new thread: the project's
default model, then the environment default, then the first ready provider's default model. A work launch
for a task with a suggested model starts on that tier's model instead (see [Suggested model](#suggested-model)). Runtime mode,
worktree default and "start new worktrees from origin" come from the same settings, project overrides first.

The thread is titled `#<number> <task title>`. Ctrl+Enter in the prompt sends it.

Launches carry a `commandId`, which T3 uses to de-duplicate them. After a timeout or lost connection the
dialog keeps it, so pressing Send again returns the thread T3 may already have started instead of a second
one (with that first attempt's settings, even if you changed them). After T3 rejects a launch, T3 would
keep rejecting that id, so the dialog starts the next attempt with a fresh one.

Not mirrored from T3 (yet): defaults from a repo's `t3.json`, per-project provider enable/disable
overrides, and hidden or reordered models. The dialog shows every model of every enabled provider.

#### How the launch works

T3 Code has no HTTP endpoint for starting threads. The board's server uses the same WebSocket RPC that T3's
own web client uses:

1. `POST <t3-origin>/api/auth/websocket-ticket` with the token as a Bearer header returns a short-lived ticket.
2. Connect to `ws://<t3-origin>/ws?orchestrationProtocol=2&wsTicket=<ticket>`.
3. Send Effect-RPC JSON requests and wait for each reply:
   - `server.getConfig` (providers, models, settings) and `vcs.listRefs` (branches) fill the dialog, and
     `server.getConfig` alone fills the model pickers in Settings → Model tiers;
   - `orchestration.launchThread` creates the thread and sends the prompt as its first message, which starts
     the agent.
4. On success, add a `t3_thread` link to the task. The card shows the thread straight away, and the
   20-second live status poll takes over from there.

The browser only talks to the board's REST API (`GET /api/tasks/:id/t3-launch-options`,
`POST /api/tasks/:id/t3-thread`, and `GET /api/integrations/t3/models` for settings). Each request opens one WebSocket session and closes it when done.

**This protocol is not a public API.** It was worked out from T3 Code's source, so a T3 update can break it.
Failures to load the dialog's options are shown in the dialog, with an offer to copy the prompt instead.
Launch failures are shown as a toast with the reason (for example "the token lacks `orchestration:operate`"
or "T3 Code's protocol may have changed"). The copy-prompt hand-off keeps working regardless.

#### Workspace and branch

The workspace and branch choices map to T3's `workspaceStrategy`:

| You choose | T3 does |
|---|---|
| New worktree, from branch X | Creates a new worktree on a new `t3/xxxx` branch based on X. T3 renames the branch after the first message. With "start new worktrees from origin" on, a local X starts from `origin/X`; a remote ref is used as is. |
| A branch that already has its own worktree, or Previous worktree | Runs the thread in that existing worktree folder. |
| Current checkout | Runs the thread in the project folder on whatever branch is checked out. |

### Linking an existing thread

**Add link** (panel) and `link` (MCP) accept what T3 gives you for a thread, besides `t3code://threads/…`:

- A bare thread ID, as T3's "Copy thread ID" produces (a UUID, or `thread:…`). It carries no environment, so
  it needs a detected T3 (`classifyLink`'s `t3` option, `packages/contracts/src/links.ts`); without one the
  panel says T3 isn't running.
- A browser URL of the detected T3, `<origin>/<environmentId>/<threadId>`. Other URLs stay plain links.

The REST route and the `link` tool call `Integrations.resolveLinkInput` before `links.add`
(`T3Integration.resolveThread`), which asks the live shell whether the thread exists (exact ID, archived
threads included):

| T3 | Result |
|---|---|
| Connected, thread exists | Linked in the detected environment |
| Connected, no such thread | Rejected: "No T3 Code thread with ID …" |
| Detected but unpaired or unreachable | Linked unchecked; the response carries a `warning` (a toast in the panel, a `Warning:` line from `link`) |
| Not detected | A bare ID is rejected; a browser URL is just a URL |

## Decisions

### No branch switching in the current checkout

In T3's own screen, choosing Current checkout and then a different branch runs `git checkout` in the
project folder before the thread starts. The board deliberately doesn't do that. Under Current checkout you
can pick the checked-out branch or a branch that has its own worktree. Other branches are disabled, with a
hint to use New worktree.

**Why.** Switching the branch of the main project folder from a board button has wide side effects:

- Everything using that folder sees its files change: your editor, terminals, other T3 threads in the root
  checkout, and running dev servers. For this repo, that can include the board's own `pnpm dev`.
- Git refuses the checkout when uncommitted changes would be overwritten, so the launch fails.
- The checkout and the launch are two separate calls. If the launch fails after the checkout succeeded, the
  folder is left on the new branch with no thread.
- It needs a third scope, `source-control:write`, which also allows cloning and creating branches and
  worktrees. That makes the token stored on disk more powerful.

**What you give up.** You can't start a thread that works directly on an existing branch X in the main
folder. New worktree from X is not a substitute: it makes a new branch based on X, so commits don't land on
X. To work on X directly, either run `git checkout X` yourself first (X then shows as current), or launch
on the current branch and ask the agent to switch to X in the prompt.

**Changing this later.** The alternative is to add `source-control:write` and call T3's `vcs.switchRef`
before launching, exactly like T3. If that's ever wanted, make the switch an explicit, clearly labelled
choice, warn which folder will change, and refuse when the folder has uncommitted changes.

## Alternatives considered

For starting T3 threads:

| Option | Starts the agent? | Why not chosen |
|---|---|---|
| Deep link `t3code://new?prompt=…&repo=owner/name` | No, it only fills in a draft | You still press Send in T3, and T3 picks the project by GitHub repo rather than by project id. No token needed, so it would suit a lighter, read-only integration. |
| T3's MCP server (`/mcp`, tool `t3_thread_launch`) | Yes | Only accepts OAuth MCP-client sessions, which need a browser or pairing-code approval. CLI tokens are rejected. |
| A T3 scheduled task with a webhook trigger | Yes | One-time setup over the same WebSocket, then a plain HTTP POST per launch. It adds a hidden scheduled task in T3 and gives less control over model and workspace per launch. |
| WebSocket `orchestration.launchThread` | Yes | **Chosen.** One request, full control over model, mode and workspace, and the thread id comes back so the board can link it immediately. |

The chosen option means the board writes to T3 Code, which it originally never did. It still never touches
T3's database or files; it only acts through T3's own API, with a token you issue. [Local review](local-review.md) uses the same channel for one more write: when nobody runs a review
round, it posts a message into the task's linked thread (`orchestration.dispatchCommand`, `message.dispatch`).
Epics add the only writes an agent can trigger: `start_task_thread` and `message_task_thread`. They stay off until
the user turns on **Let agents start threads** ([epics.md](epics.md#t3-code-threads)).

## Code map

| File | What it does |
|---|---|
| `packages/contracts/src/handoff.ts` | The hand-off prompts (`taskHandoffPrompt`: work, plan, orchestrate, subagent), the suggested model line and the default mode |
| `packages/contracts/src/modelTiers.ts` | Model tiers, the task's `suggestedModel` and the tier settings |
| `packages/contracts/src/t3Launch.ts` | Launch options and launch input schemas, runtime modes and clamping, the default base ref |
| `apps/server/src/integrations/t3Rpc.ts` | Minimal Effect-RPC client: ticket, socket, request/Exit frames, error mapping |
| `apps/server/src/integrations/t3Launch.ts` | Lenient schemas for T3's responses, defaults, the suggested tier's model (`resolveSuggestion`), workspace → `workspaceStrategy`, a launch without the dialog (`autoLaunchSettings`) |
| `apps/server/src/integrations/t3.ts` | `launchOptions`, `startThread` and `launchTaskThread`, and linking the new thread to the task |
| `apps/web/src/components/handoff/` | Buttons, the dialog (for a task or a project) and its pickers; pure logic in `handoff.logic.ts` |
| `apps/web/src/components/settings/ModelTiersSection.tsx` | Settings → Model tiers |
