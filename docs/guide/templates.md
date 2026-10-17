# Templates

A template is a starting point for new tasks: a title, a description, labels and, if you want, a plan.
The board comes with three: **Bug**, **Spike** and **Feature**, each with a few plan steps to start from.

## Starting a task from one

Press **N** (or use **New task** in the palette), pick a project, then choose a template above the
description. The title and description fill in; edit them as you like and create the task. It lands in
Backlog with the template's labels and plan. With **New task with plan**, a template that has a plan puts the
task straight into Planned.

The template is copied, so changing or deleting it later doesn't touch tasks already made from it.

Agents can use templates too: they see them with `list_templates` and start from one by passing `template`
when they add a task. They can't create or change templates.

## Managing templates

**Settings → Tasks → New tasks** lists them. **New template** opens the editor; each row has Edit, Duplicate and
Delete.

- **Available in:** every project, or just one.
- **Title:** used when a task is made without a title (for example by an agent). `{{date}}` becomes
  today's date and `{{project}}` the project's name, so `Weekly review {{date}}` works.
- **Description:** Markdown, with the same placeholders.
- **Labels:** separated by commas.
- **Suggested model:** applied together with the plan.
- **Plan:** phases and steps, with notes on a step if useful.

To turn a task you've already set up into a template, open its **More actions** menu and choose
**Save as template…**. Its title, description, labels and the plan's steps are copied; progress isn't.

Templates are part of the board's [backup](../features/backup.md).
