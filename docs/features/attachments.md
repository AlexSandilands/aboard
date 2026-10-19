# Pasted images

Board task: #117.

A screenshot of a bug is often the best description of it. Paste or drop an image into a task's text and it is
stored on the board and written into the text as a pill; agents get its file path from `get_task`.

## How it works

- **Where:** every Markdown editor on a task (description, plan context, step notes) and the description box of
  the new-task palette. Paste (Ctrl/⌘+V) or drop image files onto the text box.
- **In the text:** a token, `![name](attachment:<id>)`. The editor ([rich-editor.md](rich-editor.md)) shows it as
  the same small pill with the name as rendered text does. Thumbnails of the images the text refers to sit under
  rendered text, and under the editor only when it falls back to a plain textarea (which shows the token). A click
  on either opens the image in a preview dialog.
- **While it uploads:** the rich editor shows an "Uploading image…" pill (a node that writes no Markdown), swapped
  for the attachment pill when the upload is done. The swap stays out of the undo history, so one undo takes the
  image out. The textarea shows an `[uploading image N…]` placeholder instead. A failed upload removes either.
- **Shrinking in the browser** (`apps/web/src/lib/attachments.ts`, rules in `attachments.logic.ts`): an image
  over 2560px on its long side is scaled down to that, and one over 1 MB (or of a type the board doesn't store,
  such as BMP) is re-encoded as WebP at quality 0.85, with a canvas. GIFs, which may be animated, and small
  images go up as they are. Whatever is still over 5 MB is refused with a message under the editor.
- **Storing:** `POST /api/attachments?taskId=&filename=` with the image as the body. The server accepts PNG,
  JPEG, GIF and WebP up to 5 MB, checks the leading bytes match the type, writes
  `<data dir>/attachments/<task id>/<id>.<ext>` and a `task_attachments` row. `GET /api/attachments/:id` serves
  it with `nosniff` and a sandbox CSP; behind the guard like the rest of `/api`, so with a token set `<img>` tags
  use the `?token=` query, as SSE does.
- **A task that doesn't exist yet:** the palette uploads without a `taskId` (the row's `task_id` is null, the
  file waits in `attachments/_pending/`). Creating the task claims the images its description refers to and
  moves them into its folder. The server removes unclaimed images older than a day when it starts.
- **Deleting a task** deletes its folder. Deleting a project leaves its folders until the next start, when
  folders of tasks that no longer exist are swept.
- **Agents:** `get_task` lists the task's images under **Images** with absolute paths, so Claude Code can open
  a screenshot as a file. Nothing else shows them to agents.

## In the launch dialogs

The hand-off dialogs (a new T3 Code thread, a new Claude Code or Copilot CLI session, and their Plan tasks, Suggest
epics and Fix in → forms) take images too: paste or drop them into the first message, or pick them with the image
button. They are not written into the prompt as tokens: the dialog keeps them as thumbnails under it (a click
previews, × removes), and Send waits for uploads to finish.

- **Uploading:** each image is shrunk and uploaded at once with no `taskId`, so one pasted into a dialog that is
  then closed is swept after a day like any unclaimed image. The launch request carries `attachmentIds` (up to 10,
  in order); the server refuses an id that is gone or belongs to another task, before anything starts.
- **T3 Code:** the server uploads each image to T3 and sends it with the first message
  ([agent-handoff.md](agent-handoff.md#how-the-launch-works)).
- **CLI sessions:** the prompt gets a `[Attached image "<name>" is saved at: <path>]` line per image (T3's wording),
  and so does the short prompt when the full one can't go on the command line.
- **Whose they are:** a task's launch gives the images to the task once it starts (for a CLI, before the prompt is
  built, so the path is where the file stays): they are backed up, deleted with it, and listed by `get_task`. A
  Suggest epics or Plan tasks launch has no one task, so its images stay unclaimed and are swept after a day; T3
  keeps its own copy, and a CLI session has read the file by then.

## Backup

The rows go in the task's JSON (`task_attachments`); the files are copied next to the JSON as
`attachments/<task id>/<id>.<ext>`, and removed from the folder when the task or image goes. Images are never
rewritten once copied (the id is the name). Restoring a board (`restoreBoard`) or one task copies the files back
from the backup folder; a single-file dump has no images, and the restore reports how many files were missing.
A row whose ids aren't ids is never turned into a path. See [backup.md](backup.md).

## Decisions

- **Files on disk, not in SQLite.** The database stays small and fast to dump, and agents need a path to open.
- **Shrink in the browser, not on the server.** No image library or ffmpeg to install; the server only checks
  type, size and signature.
- **A token in the text, not a column.** The text stays the one source of what is shown where, and it travels
  through copy, templates and backups unchanged.
- **Launch images beside the prompt, not in it.** The prompt goes to an agent as written, and a token there would
  mean nothing to it; T3 and the path lines are how agents get them.
- **Project launches leave images unclaimed.** Giving them to each planned task would copy one screenshot onto many
  tasks; the day before the sweep is long enough for the agent to read it.

## Code map

| File                                                 | What it does                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `packages/contracts/src/attachments.ts`              | Token helpers, accepted types, limits                         |
| `apps/server/src/services/attachments.ts`            | Upload, read, claim, resolve and claim a launch's images, delete files, sweep |
| `apps/server/src/http/routes/attachments.ts`         | `POST /api/attachments`, `GET /api/attachments/:id`           |
| `apps/server/src/db/migrations/024_task_attachments.sql` | The table                                                 |
| `apps/server/src/services/backup/files.ts`           | Copying images into and out of a backup folder                |
| `apps/web/src/lib/attachments.ts`, `.logic.ts`       | Shrinking before upload                                       |
| `apps/web/src/components/attachments/`               | Paste hook, pill, thumbnails, preview dialog                  |
| `apps/web/src/components/handoff/LaunchImages.tsx`   | The launch dialogs' images (`launchImages.logic.ts`)          |
| `apps/web/src/components/editor/`                    | The editor's attachment and upload nodes                      |
