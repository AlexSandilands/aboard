# Suggested changes

Board task: #177.

Agents run with prompts and skills the user chose: the review and planning skills in Settings, custom automations'
prompts and the skills those name. An agent that sees one of them mislead agents or waste their time can suggest a
rewrite, with its reasons and evidence. The user sees a diff in Settings and accepts or rejects it. Nothing is
written without the user. It is built for the improvement automation (#134), but any agent can use it.

User-facing: [guide/settings.md](../guide/settings.md#suggested-changes).

## How it works

### What can be changed

`targets()` in `apps/server/src/services/suggestions.ts` builds the list fresh on every call, from what the board
uses right now. Each target has a key agents pass around (`editableTargetKey` in
`packages/contracts/src/suggestions.ts`):

| Target                                                     | Key                         | Accepting writes                       |
| ---------------------------------------------------------- | --------------------------- | -------------------------------------- |
| A review or planning skill on disk, on the board or a project | `skill:<path to SKILL.md>`  | The file                               |
| The built-in review or planning skill, where it is used     | `builtin:review`, `builtin:plan` | A new global skill (see below)    |
| A custom automation's agent prompt                          | `automation:<id>`           | The automation's prompt                |
| A skill a custom automation names                           | `skill:<path to SKILL.md>`  | The file                               |

A custom automation names its skill, not a path, so the board looks for it the way the agent would
(`discoverSkills`): in the user's global skill folders and in the folders of the projects the automation covers. A
skill found in a project's folder is `inRepo`: accepting changes a file in that repository, which the user commits.

Orchestrate's extra instructions (#138) don't exist yet, so they aren't a target.

### Suggesting

Agents use three MCP tools (`apps/server/src/mcp/tools/suggestions.ts`):

- `list_editable_prompts`: every target with its key, title, where it is used, and whether it is built-in or in a
  repository.
- `get_editable_prompt(target)`: the current text and its hash (the first 16 hex digits of its SHA-256), and the
  target's five latest suggestions (`forTarget`) with their status, date and the rationale's first line, so an agent
  can tell what the user accepted or rejected and doesn't propose a rejected change again.
- `suggest_change(target, baseHash, proposed, rationale, evidence[])`: `proposed` is the whole new text. The board
  refuses a key it doesn't list (NOT_FOUND), a hash that isn't the current text's (CONFLICT, with a hint to read it
  again), a text that is the same as the current one, and an automation prompt the automation couldn't save (an
  unknown `{{placeholder}}`, too long).

A suggestion stores the text the agent read (`base_text`) as well as its hash, so the diff still shows after the
target changes. One suggestion per target is open at a time: a new one marks the open one `superseded`. Each new
suggestion sends a `suggestion` notification (switchable in Settings like the others); clicking it in the inbox
opens the Suggestions section.

### Deciding

Only the user decides, over REST (`apps/server/src/http/routes/suggestions.ts`); there is no MCP tool for it.

| Route                                 | Does                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `GET /api/suggestions`                | Open ones (oldest first), then the newest 30 decided, and the open count     |
| `POST /api/suggestions/:id/accept`    | Applies it, or marks it stale; returns the suggestion either way             |
| `POST /api/suggestions/:id/reject`    | Marks it rejected                                                           |

Accepting re-resolves the target and compares the current text's hash with the base hash. A target that is no
longer in use or can't be read, or a text that changed since the agent read it, marks the suggestion `stale` and
writes nothing. Otherwise:

- **A skill file** is overwritten with the proposed text. A file with CRLF line endings keeps them.
- **An automation prompt** is saved through `customAutomations.update`, with the same checks as the editor.
- **A built-in skill** can't be edited, so the change is saved as the user's own global skill:
  `~/.claude/skills/<built-in name>-custom/SKILL.md` (then `-custom-2`, `-3`… if taken), with frontmatter naming it.
  The board's setting and every project that explicitly used the built-in switch to it.

Statuses: `open`, `accepted`, `rejected`, `stale`, `superseded`. A decided suggestion records who decided, when,
and an `outcome` line (what was written, or why it went stale). Every change publishes `suggestions.changed` with the
open count, and the web app refetches the list.

### The Settings section

**Settings → Tasks → Suggestions** (`apps/web/src/components/settings/SuggestionsSection.tsx`) lists the open
suggestions, with the open count beside the section in the settings list. Each shows the agent's rationale (Markdown,
without images), the evidence (`#N` opens the task, http(s) URLs open in a new tab, anything else is text), notes on
what accepting does (a built-in skill is saved as the user's own, a project skill is a file to commit), and a line diff
of the text the agent read against its proposal (`suggestions.logic.ts`), with unchanged stretches folded. **Show the
whole proposed text** shows it all. Accept is disabled when the target has changed or gone. Decided suggestions are
listed below as history.

Suggestions are backed up (`suggestions.json`), so a restore keeps the ones the user hasn't decided.

## Decisions

- **The agent's text is untrusted.** Nothing is applied without the user's click, the whole change is shown first,
  the rationale renders without images (so it can't make the browser fetch a URL), and only `http(s)` evidence
  becomes a link.
- **Only listed targets.** A key names a target, never a free path: `skill:<path>` is accepted only while that path is
  a skill the board uses, and it must be a `SKILL.md`, so a suggestion can't aim a write at any other file. This
  limits what the board will write; it isn't a sandbox (an agent on this machine can write files itself).
- **Stale, not merged.** If the text changed after the agent read it, the suggestion goes stale instead of being
  merged in: a merge the user didn't see is exactly what a suggestion is meant to avoid. The agent can suggest again
  on the new text.
- **Whole text, not a patch.** Agents send the whole new text and the board diffs it. Agents write whole texts
  reliably; patches that don't apply would be a new way to fail.
- **Superseded keeps history.** A newer suggestion for the same target replaces the open one but leaves it in the
  history, so the user can see the agent changed its mind.

## Alternatives considered

| Option                                              | Why not chosen                                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Let agents edit skill files directly                | Changes nobody reviewed, to text that steers every later agent                                 |
| An MCP tool to accept                               | Deciding is the user's; an agent accepting its own suggestion defeats the point                |
| Edit the built-in skills in place (a stored override) | The built-ins ship with the board and change with it; a separate global skill is the user's own and works in any harness |

## Code map

| File                                                     | What it does                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/contracts/src/suggestions.ts`                  | `EditableTarget` and its keys, `Suggestion`, `SuggestionView`, `SuggestChangeInput` |
| `apps/server/src/db/migrations/030_suggestions.sql`      | The `suggestions` table; a partial unique index keeps one open per target |
| `apps/server/src/db/repos/suggestions.ts`                | Typed SQL                                                                 |
| `apps/server/src/services/suggestions.ts`                | Targets, hashing, suggest, accept (with the built-in fork), reject       |
| `apps/server/src/mcp/tools/suggestions.ts`               | `list_editable_prompts`, `get_editable_prompt`, `suggest_change`          |
| `apps/server/src/http/routes/suggestions.ts`             | List, accept, reject                                                      |
| `apps/web/src/components/settings/SuggestionsSection.tsx` | The Settings section                                                     |
| `apps/web/src/components/settings/suggestions.logic.ts`  | Line diff, folding, evidence parsing                                      |
| `apps/web/src/state/suggestions.ts`                      | Query and mutations                                                       |
