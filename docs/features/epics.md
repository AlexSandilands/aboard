# Epics

Board task: #7.

An epic groups the tasks of a large feature ("One-page checkout") that would otherwise be scattered across a
project's lane. It shows as a band across the columns its tasks are in, with a roll-up of how far they've got,
and agents can create epics, put tasks in them and see every task's state in one call.

## How it works

### An epic is a task

An epic is a `tasks` row with `kind = 'epic'`; its tasks point at it with `parent_id`
([ADR 0007](../decisions/0007-epic-is-a-task-kind.md)). So it has a `#N`, a description, labels, links (such
as the T3 thread coordinating it), notes and activity like any task. What differs:

| Rule                                 | Enforced in                                                    |
| ------------------------------------ | -------------------------------------------------------------- |
| No plan: `set_plan`, adding a phase and creating one with a plan are refused | `noPlanOnEpic` in `services/plans.ts`, `create` in `services/tasks.ts` |
| No status of its own: `move` refuses a status change (reordering within the column is fine), except marking an integration epic merged ([Delivery](#delivery)) | `move` in `services/tasks.ts` |
| Can't be closed or reviewed, and its PRs merging doesn't move it as it would a task (for an integration epic the merge of its own PR from the branch is an input to its derived status, [Delivery](#delivery)) | `close`, `reviews.openRoundIn`, `links.completeIfPrsDone`, `links.setSnapshot` |
| Epics don't nest                     | `create` / `update` in `services/tasks.ts`                     |
| A task and its epic share a project  | `epicFor` in `services/tasks.ts`                               |
| Can't be archived (so can't be deleted) while it has open tasks | `update` in `services/tasks.ts` |
| Archiving it archives its Done tasks too; unarchiving brings those back | `archiveWithEpic`, `unarchiveWithEpic` in `services/tasks.ts` |
| An archived epic is never re-derived | `syncEpicStatus` in `services/tasks.ts` |
| Reopening or unarchiving one of its tasks unarchives it | `unarchiveEpicFor` in `services/tasks.ts` |

Errors are `VALIDATION` with a message that says what to do instead (plan the tasks, move the tasks).

### Status follows the tasks

An epic's status is derived from its tasks that aren't archived (`deriveEpicStatus` in
`packages/contracts/src/derive.ts`): the furthest-back status any of them is in, Done once every one is done or
closed, Backlog while it has none. It is stored on the row, so lists, filters and column counts read it like
any other status. The exception is an epic delivered through an integration branch, which is Done only once that
branch has also merged into the default branch: until then it stays in **Review** even with every task done
([Delivery](#delivery)). Integration epics already Done when this rule arrived are counted as merged by migration 038
(`integration_merged_at` set to when they finished), so they stay Done.

`syncEpic` in `services/tasks.ts` recomputes it in the same write whenever a task joins or leaves the epic,
changes status, is closed or reopened, archived or unarchived, moved to another project, or deleted, and when what
an integration epic waits for changes: a PR on it is linked, unlinked or changes state, its delivery changes, or it is
marked merged. A change
logs `status_changed` on the epic with `fromChildren: true` ("follows its tasks" in the activity log) and
moves the epic to the end of its new column.

### Joining and leaving

- `epicId` on create or update (uuid, `#N` or `N`) puts a task in an epic; `null` takes it out. Each change
  logs `epic_changed` on the task and `child_added` / `child_removed` on the epic.
- Pasting a Jira epic, or a GitHub issue with sub-issues, as a new task's title makes the task an epic once its import
  finishes (`tasks.makeEpic`, logging `became_epic`), with its child issues as its tasks; a child already on the board
  in the project joins it. The only way a task becomes an epic; see [Issue import](issue-import.md#epics).
- Moving a task to another project takes it out of its epic, unless the same update names an epic there.
- Moving an epic to another project takes its tasks with it.
- `create_epic` creates the epic and adds its `tasks` in one write (`tasks.createEpic`), and refuses a task
  already in another epic rather than moving it.
- Renaming an epic republishes its tasks, whose cards and panels show its title.
- An epic is archived only once none of its tasks is open: an archived epic leaves the board, and its open
  tasks would show loose while still claiming it. Restoring an epic from a backup takes back only the tasks
  still in its project.
- Archiving an epic (`update`, so UI, REST and MCP alike) archives its unarchived tasks, all Done by then, in the
  same write: each gets the epic's `archived_at` and an `archived` event with `withEpic`. They aren't archived
  through `update`, which would re-derive the epic from its remaining tasks and drop it to Backlog. Unarchiving
  the epic unarchives the tasks with that same `archived_at` (`unarchived` with `withEpic`, at the end of their
  lane) and re-derives it; tasks archived on their own earlier stay archived, and so do leftover tasks Auto-archive
  archived one at a time (the match is on the stamp, so it is best effort). `archiveFinishedEpic` uses the same helper.
- `syncEpic` does nothing for an archived epic, which keeps the Done it left with. A task of an epic archived before
  this (its Done tasks stayed unarchived and still point at it) can be archived without moving the epic, and
  Auto-archive treats such a Done task as loose. There is no migration for these.
- **Bringing a task back unarchives its epic.** Reopening a task in an archived epic (`move` out of Done) or
  unarchiving it (`update`) unarchives the epic in the same write (`unarchiveEpicFor`), then `syncEpic` re-derives
  its status from the tasks that are unarchived. Otherwise the open task would show loose while still saying
  "in epic #N". The epic logs `unarchived` with `becauseTask` and `reopened`. Its other archived tasks stay archived
  (unlike unarchiving the epic itself). Archiving that task again doesn't archive the epic with it: the epic stays
  unarchived and, with no unarchived tasks left, drops to Backlog; archive it by hand if that isn't wanted. Creating a task in an archived epic, or moving one into it, is still refused
  (`epicFor`: "unarchive it first"). Both paths go through the tasks service, so the UI, REST and MCP share the rule.
- An epic is also an Autopilot scope: its settings apply to the tasks in it while it isn't archived, and are deleted
  with it ([Autopilot](autopilot.md#switches-and-scopes)).
- Deleting an epic leaves its tasks loose (`ON DELETE SET NULL`) and logs `epic_changed` with
  `epicDeleted` on each. Deleting a task logs `child_removed` with `deleted` on its epic.
- The roll-up (`rollup` on `TaskSummary`: total, done and a count per status) ignores archived tasks; the
  epic's detail (`children`) still lists them.

After commit, a changed task also sends `task.detail_changed` for its epic, whose panel lists the tasks'
cards (`flush` in `services/core.ts`).

### On the board

Each lane stacks its epic bands above the loose cards, oldest epic first (`buildLanes` in `board.logic.ts`):

- A band covers only the columns from its first task's to its last's (`bandSpan`); an empty epic sits in
  Backlog. Each band gets its own grid row, and its cells sit on the lane's columns through a CSS
  `subgrid`, so its cards line up with the loose cards below.
- The header shows `#N`, the title, a roll-up bar and `done/total`; clicking it opens the epic's panel. An epic with an
  integration branch then gets an info **integration** badge (`EpicBranchBadge`, also on the Done card; the tooltip names
  the branch, a click opens the delivery popover; epics delivering to main show nothing). Its threads and
  sessions and the start button (`EpicActions.tsx`, the links line of a task card: the same `CardLinks` and
  `HandoffMenu`) come next, then the Autopilot button, which sets what Autopilot does for the epic's tasks. It
  folds to the header alone (`collapsedEpics` in the board view store, per browser). One column wide, the
  roll-up moves under the title.
- Drag and drop is per **row**: a project's loose cards, or one band (`Row` in `board.logic.ts`; the drag
  data carries `rowId`). Cards change status by dragging within their band, but not across a band's edge;
  that is refused like a drag into another project. While a band's card is dragged, the band covers every
  column so the card can go anywhere.
- Filters keep the tasks that match in their band, and all of an epic's tasks when the epic itself matches.
  `?epic=<id>` shows only that band, with a chip in the board header to clear it.
- Under bands, a lane with no loose cards hides its empty loose row.
- **A finished epic is a card, not a band.** Once an epic is Done, its band would sit above everything in Done and
  several of them would push the column down. So it drops into the lane's Done cell as one card (`EpicCard.tsx`),
  ordered with the other Done cards by when it finished (its `statusChangedAt`, which `syncEpic` sets). The card is
  the band's header in card form: icon, `#N`, title, roll-up bar, `done/total`, its threads, sessions and start button
  (`EpicActions`) and the quick Archive button.
  Clicking it opens the epic's panel. The chevron unfolds its tasks inside the card (folded by default; opening
  one of them from elsewhere unfolds it). Those tasks are in `Lane.epicChildren`, not in the lane's cells, so
  they don't also show loose. The card has no Autopilot button (nothing is left to run; the panel keeps it) and
  can't be dragged. When a task leaves Done, the epic's status changes and the band comes back.
  Filters, search, column counts and the collapsed-column preview treat the card like any Done card; a filter
  that matches only a task inside it keeps the card, listing only the matching tasks. `?epic=` is the exception:
  filtering to a finished epic shows its band, since that filter is for looking at its tasks.

### In the panel

- An epic's panel shows **Tasks** where a task shows where it's up to (`EpicChildren.tsx`): the roll-up, then
  each task by status with its progress, current step, attention and live T3 thread. **Show on board** toggles
  `?epic=`: it sets it (switching from another epic's filter), and while the board shows this epic it reads
  "Showing on board", is pressed and clears it. **Add task** opens the palette with the epic preselected.
- An **Autopilot** button in the top bar switches automations on or off for the epic's tasks
  ([Autopilot](autopilot.md#switches-and-scopes); the band's header has the same button).
- The status in the top bar is read-only (`Epic · Backlog`), and Plan, Local review, Reopen and Close as… are
  hidden.
- A task's panel shows its epic as a chip under the title, and **More actions → Epic** moves it into another
  open epic in its project, out of its epic, or into a new one.
- **New epic…** is in the command palette and the lane header, next to **Suggest epics** (below).
- The hand-off menu offers the epic's one prompt, the orchestrating prompt: **Copy prompt to start its tasks**,
  **New T3 Code thread…** and **New Claude Code / Copilot CLI session…**, the last two without **Plan with me** (see
  [Orchestrating](#orchestrating-an-epic)). The same menu is on the band header and the Done card, and it stays on a
  finished epic. The epic's **Sessions** section lists what was started, and the band and card show the same chips
  as a task card, so a click goes back to the orchestrating session. `get_task` asks an agent running on an epic
  to link its own session, labelled "Orchestrating #N".

### Over MCP

- `create_epic` creates one, optionally with existing `tasks`, all checked before anything is written.
- `add_to_backlog`, `create_task` and `update_task` take `epic`; `list_tasks` filters by it.
- `create_epic` and `update_task` (on an epic) take `delivery` ([Delivery](#delivery)).
- `get_task` on an epic, and `epic_overview`, list its tasks by status with each one's summary line, live T3
  thread, latest note and newest activity: enough to monitor tasks however they were started. The epic's
  render explains that it has no plan instead of asking for one.
- List lines mark epics `[epic]` with their roll-up (and `integration branch epic/…` when it has one), and tasks in one with `in epic #N`. `board_overview`
  counts only tasks and lists open epics per project.

### Delivery

Board task: #123. How an epic's tasks reach the default branch (`tasks.delivery`, `tasks.integration_branch`,
`025_epic_delivery.sql`; only an epic has them):

- **Pull requests to main** (null, or `main` once someone chose it): each task opens its PR to the default branch
  and the user merges it. A task blocked by it becomes startable after that.
- **Integration branch** (`integration`): the epic has a branch `epic/<number>-<slug>` (`epicBranchName`). Its tasks
  start from origin's copy of it and open their PRs against it; Autopilot's Merge into epic branch merges each one
  there once it is reviewed and green, and keeps a draft PR from the branch into the default branch, which only the
  user merges ([Autopilot](autopilot.md)). It suits an epic whose tasks build on each other, which would otherwise
  stop at every merge.

`TaskSummary.delivery` is the epic's choice (null for tasks and for an epic nobody chose for), and
`TaskSummary.integrationBranch` its branch: on the epic, and on each of its tasks too, so whatever starts a task
reads it from the task.

- **Switching.** `PUT /api/tasks/:id/delivery` (the panel's branch button next to the Autopilot button, and the
  bottom of the epic's Autopilot popover: `EpicDelivery.tsx`), `update_task(epic, delivery)` and
  `create_epic(delivery)` all go through `Integrations.setEpicDelivery`. Switching to integration first runs
  `ensureEpicBranch` (`autopilot/epicBranch.ts`): fetch origin, then push `origin/<default branch>` to the new branch.
  A branch already on origin (switching back and forth) is used as it is. A git failure refuses the switch with
  git's message; `create_epic` still creates the epic and says why its delivery wasn't set. Then
  `tasks.setDelivery` stores it, logs `delivery_changed` and republishes the epic's tasks.
- **Finishing.** An integration epic is Done only once all its tasks are Done **and** its branch has merged into the
  default branch; until then `deriveEpicStatus` gets `awaitingMerge` and holds it in Review. The board knows the branch
  merged when a PR linked on the epic whose head is the branch (`snapshot.headRef`) shows `merged` in the poller's
  snapshot (`epicBranchMerge` in `packages/contracts/src/delivery.ts`): Autopilot's draft PR, or one the user links by
  hand. No git is run for it. `TaskSummary.integrationMerge` carries `{ merged, by: "pr" | "manual" | null, pr }` for
  such an epic (null for any other). While all its tasks are Done and it hasn't merged, the band's integration badge
  reads **waiting for merge into main** (warning colour), and the delivery popover names the PR (a link) or says to link
  one.
- **Marking merged.** For a merge with no PR to watch (Merge into epic branch is off, GitHub polling is off, or the
  branch merged some other way), **Mark merged into main** in that popover, or `move_task(epic, done)`, stores
  `integration_merged_at` on the epic (`integration_marked_merged` event) and `syncEpic` makes it Done (`status_changed`
  with `markedMerged`; a PR merge logs `mergedPr` instead). It is refused while the epic has open tasks or none, and for
  any epic that doesn't deliver through a branch; other status moves of an epic are refused as before. Changing the
  delivery clears the mark, and so does a task of the epic being open again (reopened, or added): the mark covered the
  branch as it stood, so the epic waits for a merge again once its tasks finish. A merge seen through the epic's PR stays on record (that PR did merge); Merge into epic branch doesn't open another PR once the epic's has merged, so that new work is delivered by hand. Unlinking the merged PR (or reopening a task) pulls a Done epic back to Review or the
  task's column, and a later merge or finish brings it back.
- **Going back** to main is refused once one of its tasks has started (`startedEpicTasks`: In Progress, Review, or
  Done without being closed), since their branches and PRs already target the epic's branch.
- **Starting tasks.** Start planned passes the branch as `workspace.prBase`; `taskHandoffPrompt` adds
  `integrationBranchLine` to work and subagent prompts, and the orchestrating prompt says how the epic is
  delivered; `start_task_thread` defaults `baseRef` to the branch with `startFromOrigin`; the launch dialog opens
  on a new worktree from it (`initialWorkspaceChoice`). `get_task` shows a `Delivery:` line on the epic and its
  tasks, and `epic_overview` on the epic.
- **Asking the user.** `deliveryHintApplies`: an open epic with no delivery chosen whose open tasks block one
  another (two or more), or that has three or more Planned. Then `create_epic`, `set_plan` / `create_task` for one
  of its tasks and `epic_overview` add **Epic delivery not chosen**, which explains both options and tells the agent
  to ask the user and call `update_task(epic, delivery)` only once they answer (`deliveryHint`, `epicDeliveryHint`).
  Choosing either answers it for good.

### Orchestrating an epic

The point of an epic is to start its tasks together rather than one by one. Handing off an epic (the hand-off
menu, or `get_handoff_prompt` over MCP) gives the agent an **orchestrating prompt** (`taskHandoffPrompt` with
mode `orchestrate`, in `packages/contracts/src/handoff.ts`). The agent that runs it is the **orchestrator**:

1. It reads `epic_overview`.
2. It drafts plans for tasks still in Backlog, shows them to the user together, and once the user approves
   saves each with `set_plan` and moves it to Planned. No task starts before its plan is approved.
3. It works out which tasks can run in parallel and tells the user the order.
4. It starts each task by the first route the harness supports:
   - **T3 Code threads**, when `epic_overview` says T3 Code is available: `start_task_thread(task)` per task (see
     [below](#t3-code-threads)).
   - **Subagents** (Claude Code's Agent tool, Copilot CLI's subagents or the equivalent), one per task, each
     given `get_handoff_prompt(task, subagent: true)`, on its own git worktree and branch when they run in
     parallel.
   - **Manual**: the prompts from `get_handoff_prompt(task)` for the user to paste into new sessions.
5. It monitors through `epic_overview`, which shows what every route writes over MCP: progress, current step,
   blocked steps, review rounds and notes. It talks to a T3 thread with `message_task_thread`, to a subagent
   directly where the harness allows it, and to any other session through `add_note` on its task, which that
   session reads on its next `get_task`.
6. It runs the review loop for subagent tasks (below), and leaves an `add_note` handover on the epic.

The prompt names harnesses only as examples, so the same text reads right in any of them.

#### T3 Code threads

Starting threads with no one watching is off until the user turns on **Settings → Integrations → T3 Code → Let agents start
threads** (`agentT3Threads`). Unlike the launch dialog, nobody sees the model or access before the agent starts,
and messages land in threads as if the user had typed them.

`epic_overview` starts with a line saying whether an agent can start threads for the epic's project
(`t3LaunchBlocker` in `apps/server/src/mcp/shared.ts`). That needs T3 running, a token set, the setting on and a
project folder, the same checks as the board's **New T3 Code thread…**. Whether T3 knows the project, or has a model
ready, is only found out at launch. If it can:

- `start_task_thread(task, mode?, baseRef?, startFromOrigin?)` starts a thread with the task's hand-off prompt
  (the linked-thread variant, with the mode defaulting like the menu) and links it. There is no dialog, so
  `autoLaunchSettings` (`integrations/t3Launch.ts`) picks what the dialog would start on:
  - the model: the suggested tier's model for work, else T3's default;
  - the access: T3's default, or the most the provider allows below it, never more (no supported mode at
    or below it refuses the launch);
  - the workspace: **always a new worktree**, so tasks can run side by side. It branches from `baseRef` (the
    default branch when there is none). With a `baseRef` it starts from the local branch unless
    `startFromOrigin` says otherwise, because a branch to build on is usually another task's unpushed one. A
    folder that isn't a git repository runs in the folder itself, and the result says to start such tasks one
    at a time. If T3 can't list the branches, the launch is refused rather than falling back to the shared
    checkout.

  The result names the model, access and workspace it chose, and says when the suggested model wasn't used.
- Both tools work on any task, in an epic or not, so Autopilot's Orchestrate (and any orchestrating agent) can
  restart or nudge loose tasks too. The user's **Let agents start threads** setting still gates them, and `start_task_thread` refuses a
  task (in work mode) whose blockers aren't Done, as Start planned does. `baseRef` must look like
  a branch name (no leading `-`, `..`, spaces or the characters git refuses).
- The launch's `commandId` is derived from the task and how many threads were ever linked to it (unlinked ones
  included, so removing a link never brings an old id back). A retry after a timeout or an
  unreadable reply therefore gets the same thread back from T3 instead of a second one. The error says so and
  doesn't suggest another route.
- It refuses a task that already has a thread on it: working, waiting, asking for input or approval, or linked
  in the last two minutes and not yet polled. It says to message that thread instead. A thread that is done,
  failed, idle or settled doesn't block a new one.
- When T3 can't take the task, the error says why and points at `get_handoff_prompt(task, subagent: true)` and the
  pasted-prompt route.
- `message_task_thread(task, text)` posts into the thread busy on the task, else its newest one that isn't
  archived. It uses the same `message.dispatch` as the [review nudge](local-review.md), prefixed "From an
  orchestrating agent (sent through the board)". Each call is a new message, so a retry can post it twice.

A Jira import run, which reads untrusted issue text, denies tools named with `message`, `dispatch`, `launch` or
`start` among its write verbs, so an injected instruction can't drive these tools.

T3 threads are top-level sessions, so they run their own review loop.

#### Subagent tasks

A subagent can't ask the user anything, and most harnesses don't let it start subagents of its own, which the
[review loop](local-review.md) needs. So a subagent gets its own variant of the work prompt
(`subagent: true`):

- when it needs an answer, it marks the step blocked with a note and reports back;
- when its `move_task` to Review opens a review round, it doesn't run the loop or open a PR: it reports the
  round number and stops;
- it ends with a short report for the orchestrator, and doesn't link a T3 thread (it has none of its own);
- the suggested model line goes to the orchestrator in `get_handoff_prompt`'s result, since only the
  orchestrator can choose the subagent's model.

The orchestrator then runs the loop for it. It reads the task first: when the board's own reviewer already
submitted the round and left blocking or major findings open, it goes straight to the fixes. Otherwise `start_review(task)` returns the brief of the round that is already
open (it doesn't open another), a fresh reviewer subagent in the task's worktree submits its findings, an implementer subagent in the
task's worktree fixes them and calls `resolve_finding`; the board opens the next round once the last blocking or major finding is resolved, and `start_review` returns its brief.
When the loop ends, the implementer opens and links the PR. If the board's own reviewer has already taken the round
(`start_review` says it is being reviewed), the orchestrator waits for it. The `move_task` result still describes
the loop to the subagent, so its prompt says to ignore that. Sessions the user started run their own loop.

### Suggesting epics

Grouping an existing backlog into epics by hand means reading every task. The lane header's **Suggest epics**
(a sparkles icon) hands that to an agent instead:

- **Suggest epics in a new T3 Code thread…** opens the launch dialog for the project
  (`GET /api/projects/:id/t3-launch-options`, `POST /api/projects/:id/t3-thread`). The thread is named
  `Suggest epics: <project>`, and nothing is linked, since there is no task to link it to. It shows on the same
  conditions as a task's T3 launch (`canStartProjectT3Thread`).
- **Copy prompt to suggest epics** works in any harness.

The prompt (`suggestEpicsPrompt` in `packages/contracts/src/handoff.ts`) has the agent:

1. read the project's open tasks and its existing epics;
2. propose groups, each with a title, a one-line description and its tasks, including tasks that belong in an
   existing epic, and leave stand-alone tasks out;
3. wait for the user to agree;
4. call `create_epic(tasks: [...])` for new epics and `update_task(epic)` for existing ones.

It doesn't plan, start or move anything. Starting an epic's tasks is the epic's own hand-off.

On the server, a launch is for a task or a project (`launchContext` in `integrations/t3.ts`). A project
launch has no suggested model and returns the thread instead of a link.

## Decisions

- **An integration epic isn't delivered until its branch is.** Without this, an epic whose tasks all merged into its
  branch read Done while nothing had reached the default branch, and Auto-archive could take it away with its PR still
  open. Review is the nearest honest column (the work is finished and waits on the user's merge), so no new status
  exists. The merge is read from the epic's PR rather than from git, so a board that can't run git still works, and
  the manual mark covers the cases where no PR is watched.
- **Derived and stored status.** Deriving keeps an epic honest without anyone moving it, and storing it
  means every list, filter and count works unchanged. The cost is that every change to a task's status,
  epic, project or archive state must call `syncEpic`.
- **Furthest-back open task sets the column.** An epic in Review whose last task hasn't started would claim
  more than it has done; the furthest-back task is where attention is needed.
- **Bands span only their tasks' columns.** From the user's sketch: the band reads as "this feature is
  between Planned and Review" at a glance, and short bands don't push the loose cards far down.
- **Subagents report back at a review round.** The alternative, letting each subagent run its own loop, fails
  in harnesses where a subagent can't start subagents; it would review its own work. The orchestrator has a
  subagent tool, so it runs the loop for all of them.
- **One orchestrating prompt for every harness.** The prompt describes routes in order of preference and names
  harnesses only as examples, rather than the board guessing which harness will receive a copied prompt.
- **Delivery is chosen, not inferred.** Integration delivery lets Autopilot merge into a branch and changes where
  every task's PR goes, so the board only ever asks (through the agent) and never switches by itself.
- **The board makes the branch, on origin.** Agents and T3 threads start from origin's copy, and Autopilot merges
  on GitHub, so a branch only in the user's checkout would help nobody; making it at the switch means a git
  problem shows up then, not when the first task starts.
- **A frame, not a colour.** An epic's band and Done card are told apart from task cards by shape (a 2px border at
  `foreground/14`, a larger radius, a faint fill on the header like a folder tab: `epicStyle.logic.ts`), not by a
  colour, since a coloured border would be read as the selection state (blue). A selected card inside a band keeps its
  blue border and fill against the neutral frame. A thin left accent bar in a colour hashed from the epic's title
  (`epicAccentHue`, skipping 195–285°) is built behind `EPIC_ACCENT_BAR`, off until the user has judged it; it has no
  per-epic override yet, which would need storing.
- **No dragging across a band's edge (yet).** A drop at a band's edge is easy to make by accident and would
  silently change the task's epic; the panel's Epic menu makes that change on purpose.

## Alternatives considered

| Option                                       | Why not chosen                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A separate `epics` table                     | Duplicates numbering, links, notes, labels and activity, which an epic needs as much as a task does  |
| Epics as a label                             | No roll-up, no description or links of its own, and nothing stops a task carrying two                |
| An epic as an ordinary card in its column    | Its tasks would be scattered around it; the band shows them together (a finished epic is the exception: it is a card in Done, with its tasks folded inside) |
| Nested epics                                 | Not needed for a feature-sized grouping, and every rule above would need a recursive version         |

## Code map

| File                                                   | What it does                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| `apps/server/src/db/migrations/009_epics.sql`          | `kind` and `parent_id` on `tasks`                                     |
| `apps/server/src/services/tasks.ts`                    | `epicFor`, `syncEpic`, joining and leaving, the epic rules            |
| `apps/server/src/services/summaries.ts`                | `parent` and `rollup` on summaries                                    |
| `packages/contracts/src/derive.ts`                     | `deriveEpicRollup`, `deriveEpicStatus`, `describeEpicRollup`          |
| `apps/web/src/components/board/board.logic.ts`         | Bands, rows, the `?epic=` filter (tested)                             |
| `apps/web/src/components/board/EpicBand.tsx`           | The band and its Autopilot button                                     |
| `apps/web/src/components/board/EpicActions.tsx`, `epicStyle.logic.ts` | The band header's and Done card's sessions and start button; the frame, header fill and accent bar (tested) |
| `apps/web/src/components/board/EpicRollupBar.tsx`      | The roll-up bar, shared by the band, the card and the panel           |
| `apps/web/src/components/board/EpicCard.tsx`           | The finished epic's card in Done, with its folded tasks               |
| `apps/web/src/components/task/EpicChildren.tsx`, `epic.logic.ts` | The epic's Tasks card; the Epic menu's options (tested)     |
| `apps/server/src/mcp/tools/tasks.ts`, `tools/read.ts`  | `create_epic`, `epic` arguments, `epic_overview`, `get_handoff_prompt` |
| `packages/contracts/src/handoff.ts`                     | The orchestrating prompt and the subagent work prompt                 |
| `apps/web/src/components/handoff/HandoffActions.tsx`, `T3LaunchDialog.tsx` | Suggest epics in the lane header; the dialog launching for a task or a project |
| `apps/server/src/mcp/tools/threads.ts`                  | `start_task_thread`, `message_task_thread`                            |
| `apps/server/src/integrations/t3Launch.ts`              | `autoLaunchSettings`: a launch without the dialog                      |
| `apps/server/src/mcp/format.ts`                        | `renderEpicChildren`, epic lines and events, `deliveryLine`, `deliveryHint` |
| `packages/contracts/src/delivery.ts`                   | `epicBranchName`, `startedEpicTasks`, `deliveryHintApplies`, `epicBranchMerge`, `awaitingBranchMerge` |
| `apps/server/src/autopilot/epicBranch.ts`              | Making the integration branch on origin                               |
| `apps/web/src/components/task/EpicDelivery.tsx`        | The Delivery control and the panel's branch button                    |
