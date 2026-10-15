# Handing tasks to agents

Status: **shipped** (board task #9). Verified against T3 Code 0.0.46 (nightly, October 2026).

The board tracks work, but the work itself happens in an agent harness: Claude Code, Copilot, T3 Code and
similar. This document covers how a task on the board becomes a running agent session, and how that session
finds its way back to the task.

## How the board and a harness talk to each other

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
| **Start in T3 Code** | T3 Code, with a token set | Creates the T3 thread, starts the agent and links the thread to the task | Pick model and workspace, press Send |

Both hand-offs send the same kind of prompt, so the agent behaves the same either way.

## The hand-off prompt

The prompt is deliberately short. It points the agent at the task rather than copying the task's content,
so the agent always reads the current plan and notes from the board:

- the task reference (`#9 Easier way to hand an idea…`) and its board link (`<board>/?task=<id>`);
- "call `get_task` on the board's MCP server and follow the board's skill";
- for T3 launches, a note that the thread is already linked to the task, so the agent shouldn't link it again;
  otherwise, a request to link the Jira issue and, in T3 Code, the agent's own thread. Task results also
  list any **Missing links** until they are added.

It is built by one pure helper in `packages/contracts` (`taskHandoffPrompt`), so the copy button and the T3
launch can't drift apart.

### Plan with me

A rough idea in the Ideas column usually needs a conversation before it needs code. The **Plan with me**
option switches the prompt to a planning brief:

- the idea is still basic, and the user wants to shape the plan together;
- explore the task and the relevant code, then ask clarifying questions;
- propose phases and steps, and wait for agreement;
- only then call `set_plan` and move the task to Planned. Don't implement anything.

The option only changes the prompt. T3 threads always start in T3's default interaction mode: T3's own plan
mode is a legacy beta behind a client setting the board can't read, and a thread started in it could be left
with no visible way to switch back. The option is on by default for tasks in
Ideas or without a plan, and off otherwise. The copy button offers "Copy prompt" and "Copy planning prompt".

## Starting a thread in T3 Code

### Setup

The board needs a T3 session token with two scopes:

```sh
t3 auth session issue --scope orchestration:read --scope orchestration:operate --token-only
```

Paste it in Settings → T3 Code. `orchestration:read` powers live thread status and the launch dialog's
options. `orchestration:operate` allows starting threads. The token is stored in the board's local
database and never sent to the browser.

The flag is `--scope`, repeated once per scope. Older instructions in this repo said `--scopes`, which T3's
CLI doesn't accept.

### When the button appears

Both buttons sit at the right of the card's bottom line and in the task panel header. They only show on
open work: not on Done or archived tasks.

**Copy prompt** is always there. Its menu offers "Copy prompt" and "Copy planning prompt", with the one
that suits the task marked _Suggested_.

**Start in T3 Code** shows when all of these hold:

- T3 Code is running (auto-detected from `~/.t3/userdata/server-runtime.json`);
- a token is set;
- the project has a T3 project id or a workspace folder T3 could know;
- the task has no T3 thread linked yet. Once it does, the card shows **Open in T3 Code** instead.

Whether T3 really has the project (by its id, or the same folder) is checked when the dialog opens. If it
doesn't, the dialog says so and offers to copy the prompt instead.

### The launch dialog

Clicking the button opens a dialog modelled on T3's own new-thread screen:

- the prompt, editable before sending, and the **Plan with me** toggle;
- **model**: providers down the side with favorites first, search, a Legacy models section and NEW badges;
- **effort** (and fast mode where the model has it) and **access**: Supervised, Auto-accept edits, Auto or
  Full access, limited to what the provider supports;
- **workspace**: Current checkout, New worktree or Previous worktree;
- **branch**: a searchable list of refs, labelled current, worktree, remote or default. The list holds the
  first 100 refs T3 returns, searched in the browser; a branch beyond that can't be picked yet.

The choices start from your T3 settings, resolved the way T3 resolves them for a new thread: the project's
default model, then the environment default, then the first ready provider's default model. Runtime mode,
worktree default and "start new worktrees from origin" come from the same settings, project overrides first.

The thread is titled `#<number> <task title>`. Ctrl+Enter in the prompt sends it.

Launches carry a `commandId`, which T3 uses to de-duplicate them. After a timeout or lost connection the
dialog keeps it, so pressing Send again returns the thread T3 may already have started instead of a second
one (with that first attempt's settings, even if you changed them). After T3 rejects a launch, T3 would
keep rejecting that id, so the dialog starts the next attempt with a fresh one.

Not mirrored from T3 (yet): defaults from a repo's `t3.json`, per-project provider enable/disable
overrides, and hidden or reordered models. The dialog shows every model of every enabled provider.

### How the launch works

T3 Code has no HTTP endpoint for starting threads. The board's server uses the same WebSocket RPC that T3's
own web client uses:

1. `POST <t3-origin>/api/auth/websocket-ticket` with the token as a Bearer header returns a short-lived ticket.
2. Connect to `ws://<t3-origin>/ws?orchestrationProtocol=2&wsTicket=<ticket>`.
3. Send Effect-RPC JSON requests and wait for each reply:
   - `server.getConfig` (providers, models, settings) and `vcs.listRefs` (branches) fill the dialog;
   - `orchestration.launchThread` creates the thread and sends the prompt as its first message, which starts
     the agent.
4. On success, add a `t3_thread` link to the task. The card shows the thread straight away, and the
   20-second live status poll takes over from there.

The browser only talks to the board's REST API (`GET /api/tasks/:id/t3-launch-options`,
`POST /api/tasks/:id/t3-thread`). Each request opens one WebSocket session and closes it when done.

Where the code lives:

| File | What it does |
|---|---|
| `packages/contracts/src/handoff.ts` | The hand-off prompt (`taskHandoffPrompt`) and the default mode |
| `packages/contracts/src/t3Launch.ts` | Launch options and launch input schemas, runtime mode labels |
| `apps/server/src/integrations/t3Rpc.ts` | Minimal Effect-RPC client: ticket, socket, request/Exit frames, error mapping |
| `apps/server/src/integrations/t3Launch.ts` | Lenient schemas for T3's responses, defaults, workspace → `workspaceStrategy` |
| `apps/server/src/integrations/t3.ts` | `launchOptions` and `startThread`, and linking the new thread to the task |
| `apps/web/src/components/handoff/` | Buttons, the dialog and its pickers; pure logic in `handoff.logic.ts` |

**This protocol is not a public API.** It was worked out from T3 Code's source, so a T3 update can break it.
Failures to load the dialog's options are shown in the dialog, with an offer to copy the prompt instead.
Launch failures are shown as a toast with the reason (for example "the token lacks `orchestration:operate`"
or "T3 Code's protocol may have changed"). The copy-prompt hand-off keeps working regardless.

### Workspace and branch

The workspace and branch choices map to T3's `workspaceStrategy`:

| You choose | T3 does |
|---|---|
| New worktree, from branch X | Creates a new worktree on a new `t3/xxxx` branch based on X. T3 renames the branch after the first message. With "start new worktrees from origin" on, a local X starts from `origin/X`; a remote ref is used as is. |
| A branch that already has its own worktree, or Previous worktree | Runs the thread in that existing worktree folder. |
| Current checkout | Runs the thread in the project folder on whatever branch is checked out. |

#### Decision: no branch switching in the current checkout

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

## Alternatives considered for starting T3 threads

| Option | Starts the agent? | Why not chosen |
|---|---|---|
| Deep link `t3code://new?prompt=…&repo=owner/name` | No, it only fills in a draft | You still press Send in T3, and T3 picks the project by GitHub repo rather than by project id. No token needed, so it would suit a lighter, read-only integration. |
| T3's MCP server (`/mcp`, tool `t3_thread_launch`) | Yes | Only accepts OAuth MCP-client sessions, which need a browser or pairing-code approval. CLI tokens are rejected. |
| A T3 scheduled task with a webhook trigger | Yes | One-time setup over the same WebSocket, then a plain HTTP POST per launch. It adds a hidden scheduled task in T3 and gives less control over model and workspace per launch. |
| WebSocket `orchestration.launchThread` | Yes | **Chosen.** One request, full control over model, mode and workspace, and the thread id comes back so the board can link it immediately. |

Choosing this option reverses the original v1 non-goal "no writes to T3 Code" in [PLAN.md](../PLAN.md).
The board still never touches T3's database or files; it only acts through T3's own API, with a token you
issue. [Local review](local-review.md) uses the same channel for one more write: when nobody runs a review
round, it posts a message into the task's linked thread (`orchestration.dispatchCommand`, `message.dispatch`).
