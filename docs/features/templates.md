# Templates

Board task: #82.

A template is a starting point for new tasks: a title pattern, a description, labels and, optionally, a
plan (phases and steps) with a plan context and a suggested model tier. Creating a task from a template
copies those fields onto it. People pick a template in **New task** and manage them in Settings; agents
pass `template` to `add_to_backlog` or `create_task` and read them with `list_templates`.

## How it works

### The template

| Field            | Meaning                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `name`           | Unique per scope, ignoring case                                                                      |
| `projectId`      | The project it belongs to, or null for a board-wide template                                         |
| `titlePattern`   | The title when none is given. May hold `{{date}}` and `{{project}}`                                  |
| `description`    | Markdown; placeholders work here too                                                                 |
| `labels`         | Normalised like any task's labels ([labels](labels.md))                                              |
| `phases`         | The starting plan: phases of steps, each step with optional notes. Empty means no plan               |
| `planContext`    | The plan's approach text                                                                             |
| `suggestedTier`  | A model tier copied as the task's suggested model (without a reason)                                 |

`renderTemplateText` (`packages/contracts/src/templates.ts`) fills `{{date}}` (the local date as
`YYYY-MM-DD`) and `{{project}}` (the project's title) when a task is created; any other `{{…}}` is left as
written. A phase without steps is dropped on save.

Three starters are seeded by migration `012_task_templates.sql`, so they exist on every board and are
edited or deleted like any other:

| Name    | Labels    | Plan                                                  |
| ------- | --------- | ----------------------------------------------------- |
| Bug     | `bug`     | Reproduce, Fix, Regression test                       |
| Spike   | `spike`   | Questions, Investigate, Write up findings             |
| Feature | `feature` | Design, Implement, Tests, Docs                        |

### Creating a task from one

`CreateTaskInput.template` is a template's id or name (any case). A project's own template beats a
board-wide one of the same name, and another project's templates are not found. The service
(`apps/server/src/services/tasks.ts`, `create`) then fills whatever the input leaves out:

- **Title:** the input's, else the issue's placeholder when importing, else the rendered title pattern. A
  template with no pattern and no title is a `VALIDATION` error.
- **Description:** the input's, else the template's, rendered. An imported task skips it, since the import
  fills the description in.
- **Labels:** the input's list replaces the template's; it is not merged.
- **Plan, plan context and suggested model:** an explicit `plan` replaces the template's whole plan. A
  template with a plan and a task imported from an issue is refused, as a plan and an import are.
- **Status:** `status` is `backlog` or `planned`. It defaults to `planned` when the input has a plan of its
  own and to `backlog` otherwise, so a template's plan lands in a Backlog task unless Planned is asked for.
  `planned` without any steps is a `VALIDATION` error. An epic can't use a template.

The task records `template_id` and its `created` event carries `template: <name>`, shown as "created this in
Backlog from the Bug template". Nothing else reads the template afterwards: editing it changes no task, and
deleting it sets `template_id` to null.

### The UI

- **New task** (the palette, Backlog and "with plan" flows): a Template picker above the description lists
  the board-wide templates and the project's own. Picking one fills the title and description, unless
  those were already typed (a field still holding what the last template put there follows the next pick).
  A template with a plan makes "New task with plan" start in Planned instead of opening the plan editor. The
  picker is hidden for epics and for imports.
- **Settings → Templates:** the list with Edit, Duplicate and Delete, and **New template**. The editor
  replaces the Settings dialog's contents while it is open (so no second modal stacks on it) and has the
  fields above, with the plan as the same outline editor the task panel uses.
- **Save as template…** in a task's More menu opens the same editor in its own dialog, filled from the
  task: title, description, labels, plan context, suggested tier and the plan's step titles and notes
  (progress is left behind). It is scoped to the task's project to start with.

### Agents

`create_task` and `add_to_backlog` take `template` (a name from `list_templates`, or an id) and `title`
becomes optional. `add_to_backlog` keeps the task in Backlog with the plan copied in; `create_task` needs no
plan when the template has one and lands in Planned. `list_templates` prints each template's name, scope,
title pattern, labels and plan. There is no tool to create or edit templates: they are the user's.

### REST

| Route                            | Does                                                          |
| -------------------------------- | ------------------------------------------------------------- |
| `GET /api/templates`             | All templates; `?projectId=` limits to board-wide and that project's |
| `POST /api/templates`            | Create (`CONFLICT` for a taken name in the scope)             |
| `PATCH /api/templates/:id`       | Edit any field, including the scope                           |
| `POST /api/templates/:id/duplicate` | A copy named "<name> copy" (then "copy 2", …)              |
| `DELETE /api/templates/:id`      | Delete                                                        |

Templates are not in the board snapshot or the SSE stream, since only the UI changes them; the web app
refetches the list after each change.

### Backup

Templates are a top-level table in the dump (`task_templates`, written to `templates.json` in the folder
form), restored before tasks so `tasks.template_id` resolves. Dumps taken before templates existed have no
such rows or file; restoring one runs the migrations afterwards, which seed the starters. Restoring a single
task clears its `template_id` when that template is gone.

## Decisions

- **Copy, don't link.** A task keeps what it copied and only remembers where it came from. A live link would
  rewrite plans that agents are already working through.
- **Explicit fields win, labels included.** Merging labels would mean a caller can't leave one off; a
  caller who wants the template's labels leaves `labels` out.
- **Backlog by default.** A template's plan is a draft, so the task is cheap to create and goes to Planned
  only when asked.
- **Seeded by migration.** Starters exist from the first run with no "first run" state to track, and deleting
  one sticks.
- **Agents can't edit templates.** They are the user's definition of how work starts; agents use them.

## Alternatives considered

| Option                                         | Why not chosen                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| Merge the template's labels with the caller's  | A caller couldn't drop a label; overriding is easier to predict            |
| Templates in the SSE stream                    | Only the UI changes them, so a refetch is enough                           |
| Starters as code defaults, not rows            | They couldn't be edited or deleted                                         |

## Code map

| File                                                  | What it does                                              |
| ----------------------------------------------------- | --------------------------------------------------------- |
| `apps/server/src/db/migrations/012_task_templates.sql` | The table, `tasks.template_id`, the starters              |
| `packages/contracts/src/templates.ts`                 | Schemas, inputs, placeholder rendering                    |
| `apps/server/src/services/templates.ts`               | CRUD, name uniqueness, resolving by id or name            |
| `apps/server/src/services/tasks.ts`                   | `create` applies a template                               |
| `apps/server/src/http/routes/templates.ts`            | The REST routes                                           |
| `apps/server/src/mcp/tools/read.ts`, `tasks.ts`       | `list_templates`, and `template` on the create tools      |
| `apps/web/src/components/templates/`                  | The editor, the draft dialog and the pure form logic      |
| `apps/web/src/components/settings/TemplatesSection.tsx` | The Settings list                                       |
| `apps/web/src/components/command/CommandPalette.tsx`  | The picker in New task                                    |
