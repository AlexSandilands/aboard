---
name: aboard-plan
description: Plan tasks from the user's task board with them before any code is written. Use when asked to plan one or several tasks, when the board hands you a planning prompt, or when Backlog tasks need plans. Researches each task, prints a draft plan, asks the open questions, then saves it with set_plan, a suggested model tier and labels. Never implements.
---

# Planning tasks

You are planning tasks from the user's task board with them, before any code is written. Each task leaves
with a plan the user agreed to: phases of concrete steps, the key decisions, a suggested model tier and
labels. Don't implement anything.

## For each task

1. **Read it.** `get_task` for the description, links, images and any notes. Open pasted images.
2. **Research.** Explore the code the task touches: where the change goes, what already exists that it can
   reuse, the project's conventions (AGENTS.md, CLAUDE.md, docs) and what could make it harder than it looks.
3. **Find the questions.** List what you can't settle from the code: scope, behaviour the user has to choose,
   trade-offs between approaches. Recommend an answer for each. Skip questions with an obvious default; say
   which default you took instead.
4. **Draft the plan.** Phases of 3-8 concrete, verifiable steps each ("Add links table migration", not
   "Backend"), testing as its own steps. Put the approach, key decisions and the files involved in the plan
   context. Pick the suggested model tier (light, standard or deep) with a one-line reason, and 1-3 labels,
   preferring ones the board already uses (`board_overview` lists them). Note any task it depends on.

## Simple and complex tasks

Sort the tasks first. A task is **simple** when its approach is obvious and it has no open questions (a copy
change, a one-file fix, a mechanical edit). Everything else is **complex**.

- Simple tasks go together: draft all of them, show them as one set, and let the user approve the set at once
  or pick out the ones to change.
- Complex tasks go one at a time: research, draft, ask, agree, save, then the next.

Tell the user the order before you start: the simple set first or last, then each complex task.

## Print, then ask

Some apps collapse everything but the last message of a turn once it ends, and question dialogs vanish once
answered. So the plan must never live only in a dialog or in the middle of a turn:

1. **Print the plan first**, in full, as its own message: what you found, then the draft plan (phases and
   steps, context, tier and labels). For a set of simple tasks, a table: task, the plan in a line, tier,
   labels.
2. **Only then ask**, with your harness's question dialog if it has one (AskUserQuestion in Claude Code), or as
   plain questions otherwise. Never open a dialog before the plan text is printed, and never put the plan
   only inside a dialog or its option previews.
3. **After saving, restate what was saved** as the last message of the turn: the final plan, or a compact
   table of it for a set, plus anything still open. Make every tool call before that message, and don't end
   on a short acknowledgement that pushes the plan out of view.

## Saving

Once the user agrees to a task's plan:

1. `set_plan(task, phases, context, suggestedModel: {tier, reason})`.
2. If the task has no labels, apply the agreed ones with `update_task(task, labels)`.
3. Record dependencies on other tasks with `update_task(task, addBlockedBy)`.
4. If it is in Backlog, `move_task(task, "planned")`. A task already in progress without a plan stays where it is.
5. If the result says the Autopilot flag isn't set, ask the user whether to flag the task (one question can
   cover a whole set), and set it with `update_task(task, autopilot: "on" | "off")` only once they answer.
   Never set it on your own.

Tasks the user wants to drop or merge into another: `close_task` with `wont_do` or `duplicate`, once they
say so. A task that turns out too large: suggest splitting it, and with the user's agreement add the parts
with `add_to_backlog` (or make an epic with `create_epic`).

## Finishing

End with a table of every task: its plan in a line, tier, labels, Autopilot flag and status, and anything
left undecided. Add an `add_note` to any task you couldn't finish planning, saying where it got to.
