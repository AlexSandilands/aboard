# Settings

Settings is a page, not a dialog. Open it with the gear at the bottom of the sidebar, **Ctrl/Cmd ,**, or
**Settings: …** in the command palette (type a section's name, such as "Settings: Review", to go straight to it).
A project's gear in the sidebar, or right-clicking the project, opens that project's settings.

While it is open, the sidebar lists every page with its sections beneath. Click a page to open it and a section
to scroll to it; the section you are reading is highlighted. **Back** at the bottom, or **Esc**, returns to the
board as you left it. On a narrow window the list is behind the menu button in the top bar.

## Finding a setting

The box above the list searches every setting. Press **/** or **Ctrl/Cmd F** to jump to it while the list is showing
(on a narrow window, open the list first), then type: the results take the list's place, each with the page and section it is in beneath its name.
It matches names first, then other names people know a setting by ("dark mode", "Copilot", "budget") and its
description, and every word you type has to match. **↑ ↓** move through the results, **Enter** opens one, and
**Esc** clears the box. Opening a result goes to its page, opens the folded section it is in (one automation under
Autopilot, say), scrolls to it and marks it for a moment. A setting that only shows in some states (the issue import's model while
import is off) lands on the part of the page that does.

### Asking in plain words

If you don't know what a setting is called, ask. The first row of the results is **Ask: your question**; it starts
selected when what you typed reads as a question ("How do I stop agents running at night?"), so Enter asks it. Claude
Code answers in a sentence or two and names the setting, and **Go there** (or Enter) opens it and marks it, like a
result. If no one setting fits, you get the answer without a button. It uses the Claude Code CLI under
Integrations › Claude Code, on a small model (Haiku) with no tools and a few cents of budget per question, so
nothing but the question and the list of settings is sent. When the CLI can't be found the row says so and **Set up
Claude Code** takes you to its setting; if it can't answer (not signed in, over budget, too slow) the row shows why,
and a click tries again.

## The pages

| Page             | Sections                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| **Board**        | Appearance (theme, sidebar banner), Notifications, [Keybindings](using-the-board.md#keyboard), Data (backup to git, archived projects) |
| **Tasks**        | New tasks ([templates](templates.md), [issue import](importing-issues.md)), [Review](local-review.md), Models (model tiers) |
| **Autopilot**    | [Autopilot](autopilot.md) (pause, limits, quiet hours, then each automation), [Custom automations](custom-automations.md) |
| **Integrations** | [T3 Code](t3-code.md), Claude Code, GitHub Copilot, Codex ([connecting agents](connect-agents.md)), GitHub, Jira, Terminal |
| **Project**      | General (name, icon, folder), Review skill, Autopilot overrides, [Recurring tasks](recurring-tasks.md), Danger zone |

- Each integration has a dot by its name: green when it is working, amber when something needs fixing, grey
  when it isn't set up or the board can't tell (Copilot and Codex are set up on their side).
- The Claude Code CLI the board runs for the board reviewer and issue import is set under
  **Integrations → Claude Code**, with **Test** to check it.
- On the Autopilot page each automation is folded: its Inherit / On / Off switch is in the header, and opening it
  shows what it does and its settings.
- The Project page has a picker at the top. It starts on the project the board was showing, else the first one.

Editing a template, a custom automation or a recurring rule opens it as a page of its own; the top bar shows where
you are (**Settings / Tasks / Template: Bug**), and **Esc** or **Cancel** goes back to the list.
