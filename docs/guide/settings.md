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
| **Board**        | [Appearance](#appearance) (colors & themes, contrast, glass, sidebar banner, priority lane and its pinned height, scroll to a task, panel animations, fonts), Notifications, Data (backup to git, archived projects) |
| **Keybindings**  | [Shortcuts](using-the-board.md#keyboard) by group (General, Navigation), with a search box |
| **Tasks**        | New tasks ([templates](templates.md), [issue import](importing-issues.md)), [Planning](using-the-board.md#planning-several-tasks-at-once) (planning skill), [Review](local-review.md), [Suggestions](#suggested-changes) |
| **Model tiers**  | What Light, Standard and Deep mean: a description for prompts, and the model each provider starts on (T3 Code, Claude Code, Copilot CLI). **Custom models** add named models picked by a task label |
| **Autopilot**    | [Autopilot](autopilot.md) (pause, limits, quiet hours, then each automation), [Custom automations](custom-automations.md) |
| **Integrations** | [T3 Code](t3-code.md), Claude Code, GitHub Copilot, Codex ([connecting agents](connect-agents.md)), GitHub, Ticket systems, Terminal |
| **Project**      | General (name, icon, folder), Planning skill, Review skill, Autopilot overrides, [Recurring tasks](recurring-tasks.md), Danger zone |

- Each integration has a dot by its name: green when it is working, amber when something needs fixing, grey
  when it isn't set up or the board can't tell (Codex is set up on its side, so its dot stays grey).
- Claude Code and GitHub Copilot are green only when their CLI runs (`--version`) and the board's MCP server is
  registered with them. The board finds the server by its address (`localhost` and `127.0.0.1` count as the same,
  the port must match), so it doesn't matter what you named it. Hover the dot for the reason when it's amber.
  The rows beside it show the CLI's version and path and where the MCP server was found; **Re-check** runs it all
  again (the board remembers an answer for a minute).
- The Claude Code CLI the board runs for the board reviewer, issue import and Claude Code sessions is set under
  **Integrations → Claude Code**. **Integrations → GitHub Copilot** has the Copilot CLI Copilot sessions start.
  The model a new session starts on for each suggested tier is set on the **Model tiers** page (empty leaves the
  CLI's default); each of T3 Code, Claude Code and GitHub Copilot has a **Models per tier** row that opens it.
  A provider's field shows there once it is set up: T3 Code connected, or the CLI found (a value already saved
  stays visible).
- T3 Code, Claude Code and GitHub Copilot each have a **Show in hand-off menus** switch. Turn it off to stop the
  board offering a new thread or session in that tool on tasks and lanes, even though it is installed. Sessions and
  threads already linked to a task still open.
- The issue import and the board reviewer can run on a tier too: their **Model** rows take a tier (Light, Standard
  or Deep) or a model you type. A tier runs its Claude Code model from the Model tiers page; if it has none, the
  CLI's default runs, and the row says so with a link to the tier. The board reviewer's default is the CLI's own
  model.
- A session whose CLI isn't available here has no **Open in terminal** or **Fork in terminal** in its menus, only
  the copy commands.
- On the Autopilot page each automation is folded: its On / Off switch is in the header, and opening it
  shows what it does and its settings. Only a project's or epic's switch has Inherit.
- The Project page has a picker at the top. It starts on the project the board was showing, else the first one.

Editing a template, a custom automation or a recurring rule opens it as a page of its own; the top bar shows where
you are (**Settings / Tasks / Template: Bug**), and **Esc** or **Cancel** goes back to the list.

## Appearance

The look matches T3 Code's Appearance page, so the board and T3 Code can look the same side by side. All of it is
kept in this browser, not on the server: another browser (or the desktop app) has its own.

- **Colors & themes.** Pick **System** (follow your computer), **Light** or **Dark**, then a theme: **T3 Code** (the
  default), **T3 Chat**, **Grove**, **Ocean**, **Ember** or **Iris**, the same palettes as T3 Code. Click a card to
  use the theme for both light and dark; click one of its two circles to use it for that appearance only (a sun or
  moon badge marks which circle is in use), so you can have, say, Grove in light and Iris in dark. Label, epic and PR
  colours stay the same in every theme.
- **Create theme** opens a small editor in the corner that you can drag, resize and minimise; the whole board shows
  your colours while you edit, so you can open the board and look. Name the theme, pick Light or Dark, and choose a
  **Background** and an **Accent**: everything else is worked out from those two and kept readable. Turn on
  **Advanced** to set each colour yourself (text, borders, surfaces, the sidebar, error and warning…). **Inspect**
  lets you click anything on the board to jump to the colour that paints it, and clicking a colour's name lights up
  everywhere it's used. Cancel puts your theme back. Saving a theme under the name of one you already have adds it as
  that theme's other appearance, so a light and a dark theme become one.
- Every theme card has **Duplicate** (start a new theme from it). Your own themes also have **Edit**, **Export**
  (a `.json` file) and **Remove**.
- **Add theme** finds open-source themes on Open VSX (the VS Code extension registry) and installs them, all of an
  extension's variants on one card. You can also drop or choose theme files (several at once), or paste a theme's
  JSON. Files exported from T3 Code or the board import as they are, and VS Code colour themes are converted. If a
  theme is already installed you choose **Update existing** or **Keep both**.
- **Contrast** (50–200 %) fades text and borders below 100 % and strengthens them above it.
- **Glass opacity** (40–100 %) sets how see-through menus, dialogs and popovers are; 100 % makes them solid.
- **Panel animations** (0–400 ms) sets how fast the sidebar and the task panel slide open; the preview beside it
  replays when clicked. The default is 150 ms; 0 ms turns them off, and they stay off when your system asks for reduced
  motion.
- **Interface font** and its size (12–20 px) change the text everywhere; the size scales the whole board. **Monospace
  font** is for code, ids and shortcuts and only takes monospaced fonts. Type a font installed on your computer and
  press Enter; a name the browser can't find is marked and not used. Leave it empty for the system font.
- A setting you've changed has a reset button beside its name.

## Suggested changes

Agents can suggest changes to the prompts and skills the board runs them with: the review and planning skills you
chose (on the board or a project), your custom automations' prompts, and the skills those automations name. Each
suggestion waits under **Settings → Tasks → Suggestions**, with a count beside the section in the list and a
notification when a new one arrives. Nothing changes until you decide. The
[Improve prompts and skills](custom-automations.md#improve-prompts-and-skills) automation makes them every week.

Each one shows why the agent suggests it, the evidence (tasks open on the board, links open in a new tab), and the
change as a diff; **Show the whole proposed text** shows all of it. Read it before you accept: it is an agent's
text, and it will steer later agents.

- **Accept** writes the change: the skill's `SKILL.md`, or the automation's prompt. A skill in a project's folder is
  a file in that repository, so commit the change there.
- A **built-in** skill can't be edited. **Save as my own skill** saves the changed text as a skill of your own
  (in a `-custom` folder under `~/.claude/skills`) and switches Settings to it.
- **Reject** drops it.
- If the text changed after the agent read it (you edited the file, say), the suggestion can't be applied: it says
  so, and accepting marks it out of date. An agent can suggest it again on the new text.
- A new suggestion for the same prompt or skill replaces the open one.

Decided suggestions stay listed below the open ones.
