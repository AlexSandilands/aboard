# Notifications

Board task: #81.

The board used to have only **Needs attention**, which you see if you are looking at the board. Notifications
tell you when something changes that needs you: an inbox behind a bell in the header, OS pop-ups from the
desktop app (or the browser), and an unread count on the taskbar, the tray and the browser tab. The server
decides what is worth telling you and says it once per state change; the web app only shows it.

User-facing: [guide/notifications.md](../guide/notifications.md).

## How it works

### What produces a notification

Each producer calls `notifications.notify()` (`apps/server/src/services/notifications.ts`) from inside the
write that made the change, so the change and its notification commit together.

| Kind                   | Produced when                                                                  | Dedupe key                              |
| ---------------------- | ------------------------------------------------------------------------------ | --------------------------------------- |
| `thread_waiting`       | A linked T3 thread moves into `input` or `approval` (or from one to the other). A thread several tasks share (a bulk planning session) notifies once: the body is the thread's title, then the first three open tasks linked to it (and "+N more"), and `taskId` is the first of them. If that task finishes while another linked one is still open, the notice moves to that one instead of being read | `thread:<environmentId>:<threadId>:<status>:<lastActivityAt>` |
| `pr_checks_failing`    | An open or draft PR's checks become `failing`, or fail again on a new head      | `checks:<linkId>:<headOid>`             |
| `pr_changes_requested` | An open or draft PR's review decision becomes `changes_requested`               | `changes:<linkId>:<updatedAt>`          |
| `review_finished` ("Review needs you") | A local review loop ends without a clean result: a round is submitted with blocking or major findings open at the round limit (Stuck), or a round is set `failed` or `stalled` (`reviews.notifyIfUnresolved`). Not for every submitted round. Opening a round, or a new outcome for one, reads the task's earlier ones | `review:<roundId>:<state>` |
| `autopilot_failed`     | A real Autopilot run fails, or ends flagged `needsAttention` (it gave up or needs you); also runs a restart stranded, except a Review PRs or Fix PRs run it retries | `autopilot:<runId>`     |
| `agent_request`        | An agent calls `request_attention` on a task (`services/attention.ts`)         | `request:<taskId>:<requestedAt>`        |
| `autopilot_notice`     | Anything else an automation sends through `notify()`: Unblock dependents, and a new digest (task-less, with the counts) | the caller's (`digest:<id>`) |
| `suggestion`           | An agent suggests a change to a prompt or skill ([suggestions](suggestions.md)); task-less, opens Settings › Suggestions from the inbox | `suggestion:<id>` |
| `automation_draft`     | An agent drafts a custom automation (`draft_automation`, [autopilot](autopilot.md#drafts)); task-less, opens Needs you in Settings › Autopilot, which lists the drafts | `automation_draft:<id>` |
| `pr_ready`             | Review PRs found another person's PR clean, but the approval gate (or its Approve switch being off) leaves the approval to the user ([autopilot](autopilot.md#other-peoples-prs)); task-less, opens Settings › Autopilot › Needs you | `pr-ready:<host>/<repo>#<n>:<head>`, marked read once the PR leaves Needs you |
| `backup_notice`        | The git backup moved a flat backup repo into this machine's folder, or set unpushed backups that clashed with another machine's folder aside on a branch ([backup](backup.md#machine-folders)); task-less, opens Settings › Data. Also: a task moved to another machine that had changed here since the backup it was taken from, or had work going on it ([backup](backup.md#moving-tasks-between-machines)); on that task | `backup_notice:migrated:<instanceId>`, `backup_notice:set-aside:<sha>`, `backup_notice:moved:<transferId>` |

The thread and PR producers sit in `links.setSnapshot`, the call both pollers make, and compare the new
snapshot with the stored one. **A link seen for the first time never notifies**: whatever state it was linked
in, you already know. Dry runs never notify.

### Clearing what is resolved

A notification is marked read (and `notifications.changed` sent) when its cause is over. The inbox is a list of
things to act on, so an answered one shouldn't wait for a click. `notifications.resolve()` does it, from the
producer's own write:

| Kind                   | Read when                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `thread_waiting`       | The thread's next snapshot is not `input` or `approval`, or it is archived             |
| `pr_checks_failing`    | The next snapshot's checks are not failing (a later head passes), or the PR is merged or closed |
| `pr_changes_requested` | The decision is no longer `changes_requested`, or the PR is merged or closed           |
| `agent_request`        | The request is cleared or dismissed                                                    |
| Any of a task's        | The task is Done or archived: `core.write` does it once for every task a write moved, closed or archived (the `status_changed`, `closed` and `archived` log entries), whichever route got it there. A task notified in that same write is skipped, and a later touch of a Done task reads nothing |

Matching uses the dedupe key's prefix (`thread:<environmentId>:<threadId>:`, `checks:<linkId>:`, `changes:<linkId>:`) or task and
kind. A resolved row (read or not) keeps a key of its own, so the same state arising again (a CI re-run failing again, a reopened
round failing again) notifies again. A new failing head reads the older head's notification before its own is made. A notification that was already read is untouched.

`notify()` returns null, and nothing is stored, when the kind's switch is off or the dedupe key already has a
row (`dedupe_key` is unique). A key is free again once its row is pruned.

### The inbox

`notifications` (`014_notifications.sql`): kind, optional task (cascade delete), title (the headline), body
(the task as `#42 Title`, then detail), dedupe key, `created_at`, `read_at`. Rows older than 30 days are
pruned on the next `notify()`, and reads ignore them meanwhile. The list also leaves out rows **read** more than
7 days ago (`READ_VISIBLE_DAYS`): they show dimmed until then; unread ones stay until pruned. The table is history only: **not in backups**
and not over MCP, so agents can't read or clear it.

REST (`http/routes/notifications.ts`):

| Route                                  | Does                                                         |
| -------------------------------------- | ------------------------------------------------------------ |
| `GET /api/notifications?kind=&limit=`  | Newest first (default 100, max 200) and `unread`, counted over all of them |
| `POST /api/notifications/:id/read`     | Marks one read                                               |
| `POST /api/notifications/read-all`     | Marks every one read; returns the list                       |
| `POST /api/notifications/read`         | Body `{ taskId }`: marks that task's unread ones read; returns the list |

### Events and delivery

`notification.created` carries the notification, the new `unread` count and `popup`. `popup` is false during
quiet hours when **Mute during quiet hours** is on (the window is Autopilot's, `engine.quietHours`): the
notification is in the inbox but nothing pops up. `notifications.changed` carries `unread` after notifications
are read, or removed with their task. See [live sync](live-sync.md).

Opening a task's panel, by any route, marks that task's unread notifications read (`AppLayout`, via
`POST /api/notifications/read`), so the bell, badge and favicon clear without a visit to the inbox. Board-wide
notifications (no task) stay until read in the bell. Only opening clears: one that arrives while the task's panel is already open stays unread until it is read in the bell or the panel is opened again.

The web app's `useBoardEvents` puts a created notification into the inbox query and calls
`deliverNotification` (`apps/web/src/components/notifications/delivery.ts`), which asks `deliveryTarget`
where a pop-up belongs:

- Never when `popup` is false, or while this window has focus (the bell shows it).
- **Desktop app:** `window.desktopBridge.notify`. The shell validates it, shows an Electron `Notification`,
  and on click brings the window forward and sends it back, and the page opens the task and marks it read.
- **Browser:** the Notification API, once the user allowed it in Settings, and only from one tab. Tabs elect
  it over a `BroadcastChannel`: the tab focused last delivers; with none focused yet, the tab holding a Web
  Lock does. Inside the desktop app the browser API isn't used.

### Badges

`useNotificationDelivery` reports the unread count whenever it changes (`badge.ts`, `showUnreadCount`):

- **Windows taskbar:** the page draws a red circle with the count (`9+` past nine) on a canvas and sends it as
  a PNG data URL with a description for screen readers ("3 unread notifications");
  `BrowserWindow.setOverlayIcon` applies it. Windows has no numeric badge API, hence the drawing. The shell
  accepts only a small PNG data URL (`parseDesktopBadge`).
- **macOS and Linux:** `app.setBadgeCount`.
- **Tray:** a second set of tray icons with a red dot (`tray[-white|-black]-unread*.png`, one per tray icon
  style, rasterised by `scripts/build.ts`) replaces the tray image while anything is unread, and the tooltip
  carries the description. The dot is ringed in the opposite colour to the glyph so it reads on any panel.
- **Browser:** the same circle drawn on the tab's favicon; the original returns at zero. Not used in the
  desktop app.

### Settings

`AppSettings.notifications` (stored under the `notifications` settings key, exported in backups): a switch
per kind and `muteInQuietHours`. Every switch defaults on except `autopilot_notice` (`DEFAULT_NOTIFICATION_KINDS`).
Only switches the user set are stored, so a kind they never touched follows the default, including a changed one.
Settings saved before this change hold the whole record, so those keep what they had. **Settings → Board → Notifications** shows them, the browser
permission state, and what the quiet-hours window is.

### The bell's filter

The popover filters by **group**, not kind, so the row stays one line however many kinds exist.
`NOTIFICATION_KIND_GROUP` (contracts) maps every kind to Agents, PRs, Reviews, Autopilot, Suggestions or Backup; it is an
exhaustive `Record`, so a new kind has to pick one. The chips show only the groups present in the inbox.

### Agent requests

Any agent can flag any task for the user with `request_attention(task, message)`: when it is blocked, unsure, or has
something to look at, such as plans ready for approval. The board decides nothing about when; users tell their agents
(in a prompt or custom instructions). The request is stored on the task (`attention_message`, `attention_actor`,
`attention_requested_at`, `029_task_attention_request.sql`, in backups) because attention is otherwise derived from
board state. It becomes an `agent_request` attention reason (the agent's message), so the card, the **Needs
attention** list and the `attentionOnly` filters show it, and the same write sends the `agent_request` notification.

- A new request replaces the standing one, and notifies again (a new `requestedAt` is a new dedupe key).
- It stands until the user dismisses it (**Dismiss** in the task panel, `DELETE /api/tasks/:id/attention-request`) or
  an agent calls `request_attention(task, clear: true)`. Opening the panel marks the notification read but leaves the
  flag, so a glance doesn't lose it.
- With the kind's switch off the flag still shows; only the notification is skipped.
- A task that is finished (moved to Done or closed) loses its request, and one can't be made on a Done task.
- The task's activity log has `attention_requested` and `attention_cleared`.

## Decisions

- **A switch off means not recorded.** The inbox is a list of things to act on, so a kind you don't want
  doesn't sit in it. Turning it back on doesn't bring back what was skipped.
- **The first sight of a link says nothing.** Otherwise linking a PR that already fails, or restarting after
  a poll gap, would announce old news.
- **The server decides, the window delivers.** Dedupe, switches and quiet hours are server rules, so every
  window agrees and the shell stays free of board logic. The cost: delivery needs a window to exist, which
  holds because the desktop app only hides it to the tray.
- **No pop-up while the window has focus.** The bell already shows it; a toast on top is noise.
- **The page draws the Windows overlay.** The main process has no canvas or text rendering, and a bundled
  image per count can't cover `9+` and screen scaling cleanly. Costs a data URL over IPC, validated.
- **A browser and the desktop app open at once both pop up.** They can't see each other; turn the browser
  permission off if that bothers you.

## Alternatives considered

| Option | Why not chosen |
| ------ | -------------- |
| The shell listens to SSE itself and notifies | Duplicates the board's event handling in the main process, against `apps/desktop/AGENTS.md` |
| Quiet hours keep the notification out of the inbox too | The inbox is the catch-up after quiet hours; losing it defeats that |
| A Web Lock alone picks the delivering tab | The lock holder is arbitrary, and could pop up while another tab of the same browser is in front |

## Code map

| File | What it does |
| ---- | ------------ |
| `apps/server/src/services/attention.ts`, `mcp/tools/tasks.ts` | `request_attention`: the request, its notification, clearing it |
| `apps/web/src/components/task/AttentionRequestCallout.tsx` | The panel's callout with Dismiss |
| `packages/contracts/src/notifications.ts` | Kinds, `InboxNotification`, settings, `badgeText` |
| `apps/server/src/db/migrations/014_notifications.sql` | The table |
| `apps/server/src/db/repos/notifications.ts` | SQL |
| `apps/server/src/services/notifications.ts` | `notify`, list, read, pruning, quiet hours |
| `apps/server/src/services/links.ts`, `reviews.ts`, `autopilot.ts` | The producers, and for links the auto-read |
| `apps/server/src/services/core.ts` | `fx.notified` and the two events |
| `apps/server/src/http/routes/notifications.ts` | REST |
| `apps/web/src/components/notifications/` | Bell and inbox, settings section, delivery, badges, `notifications.logic.ts` |
| `apps/desktop/src/main.ts`, `preload.ts`, `shell.logic.ts` | Pop-ups, taskbar overlay, tray image, IPC validation |
