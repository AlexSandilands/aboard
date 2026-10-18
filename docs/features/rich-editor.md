# Rich Markdown editor

Board task: #142.

A task's description, plan context and step notes, and the description box of the new-task palette, are edited as
rich text: lists, checkboxes, headings, quotes, code and emphasis show as they will read, Markdown typed or pasted
turns into them, and pasted images are pills. The board still stores Markdown, which is what agents read and write;
the editor is a view of it that must never change text the person didn't edit.

## How it works

- **Typing:** `- `, `* ` or `+ ` starts a bullet list, `1. ` a numbered one, `[ ] ` (or `[x] `) a checkbox (also at
  the start of a bullet), `# `…`###### ` a heading, `> ` a quote, three backticks or tildes a code block, `---` a
  rule. `**bold**`, `*italic*`, `~~strike~~`, backticks and `[text](url)` become marks once closed. Enter in an
  empty item leaves the list; Shift+Enter is Enter (a line break inside a block isn't something the Markdown keeps).
  Tab moves the focus, as in a textarea, so the palette's Tab order still works.
- **Keys:** the callers keep their own: Ctrl/⌘+Enter saves (or creates the task), Esc cancels, leaving the box
  saves. The editor passes keys to them through `MarkdownInput`'s `onKey`; while an IME is composing it passes none.
- **Clipboard:** pasted text, from any app, is read as Markdown (inside a code block it stays code). The slice
  is built with the editor's own schema (`view.state.schema`), never `richMarkdownSchema`: the editor adds
  Placeholder, so that is another instance and ProseMirror silently drops a slice from it. Code copied from VS Code
  (it tags the paste with `vscode-editor-data`) becomes a fenced code block; when VS Code reports the language
  `markdown`, `handlePaste` reads it as Markdown instead. Copying writes Markdown, with the list and quote markers
  of the lines copied.
- **Images:** see [attachments.md](attachments.md#how-it-works). An upload is a pill node until it is done.

### The document model

The model is line based, like T3 Code's composer: every line of the Markdown is one block, so a blank line is an
empty paragraph and a paragraph never wraps two lines. Blocks keep their exact source as attributes (a bullet's
marker and the space after it, an item's indent, an ordered item's number, a heading's spaces, a quote's prefix,
a fence and its closing line, a rule's characters, and `**` versus `__`). Writing the document back
(`docToMarkdown`) uses those, so text opened and saved unchanged comes back byte for byte.

Edits make nodes without source (a new item from Enter, a list moved under another). The serializer fills those
in from their neighbours: a list uses one indent and one bullet marker, a nested list sits under its parent's
marker, and numbers continue the count (or repeat it, when every number in the list is the same).

The schema only allows what the serializer can write: a list item is one line and then nested lists, a quote holds
lines, nothing nests in a heading. TipTap's chords that would nest blocks anyway (Mod-Shift-8 and so on) are off.

### When it falls back to a textarea

`MarkdownInput` uses the rich editor only for text that `canRoundTrip` accepts:

- nothing in it the line model would show as something it isn't: tables, HTML or comments, setext headings,
  reference links, indented code or continuation lines, and blocks nested in quotes or list items;
- building the document and writing it back gives the same text. Where Markdown would read the next line as
  more of the last one (a lazy continuation), the serializer puts a blank line between them: a line after a list
  or quote, a list after text that it can't interrupt (one starting at 2, or with an empty first item), and `---`
  under text, which would underline it as a heading. Text written without that blank line falls back too. CRLF counts as LF (an editor left untouched
  never sends a change, so the stored text keeps its CRLF); a lone `\r` falls back.

Other text opens in the textarea, with "Editing as plain Markdown" under it and the image thumbnails below. The
choice is made when the text arrives from outside (opening the editor, a template filling the palette), never
while typing, so the editor doesn't swap under the cursor.

### Loading

TipTap and ProseMirror are about a fifth of the app's code, so `richEditor.module.ts` is its own chunk.
`loadRichEditor` loads it once the browser is idle after start, or when an editor first needs it; until then the
input shows an empty frame. If the load fails (the app was redeployed under an open tab, the network dropped), the
input falls back to the textarea and says the editor couldn't load; the next editor opened tries the load again.

## Decisions

- **Markdown stays the stored format.** Agents read and write it over MCP, and it is what backups, templates and
  the rendered view use. The editor is a view, so its rules are about not changing text.
- **Line based, with the source in attributes.** A CommonMark round trip (remark, prosemirror-markdown) normalizes
  spacing and markers, so opening a description and leaving would rewrite it. Keeping each line as a block makes
  an exact round trip possible; the cost is that a soft-wrapped paragraph shows as two lines.
- **Fall back instead of supporting everything.** Tables and HTML would need their own nodes and exact
  serializers; the textarea already edits them well.
- **Lazy loaded.** The editor is only used once a box is opened, and it is large.

## Alternatives considered

| Option                                   | Why not chosen                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| Keep the textarea, overlay pills         | A textarea can't hold an element; the overlay would drift with wrapping and scroll |
| TipTap with its Markdown extension       | Normalizes the Markdown, so untouched text would change on save                 |
| A Markdown preview beside the textarea   | Doesn't make the typing nicer, which is what was asked                          |

## Code map

| File                                                     | What it does                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/web/src/components/editor/inlineMarkdown.logic.ts` | Emphasis, code and links in a line (adapted from T3 Code)             |
| `apps/web/src/components/editor/richMarkdown.logic.ts`   | Markdown ↔ document, `canRoundTrip`, clipboard (adapted from T3 Code) |
| `apps/web/src/components/editor/richMarkdown.extensions.ts` | The schema: TipTap extensions with source attributes, attachment nodes |
| `apps/web/src/components/editor/RichMarkdownEditor.tsx`  | The TipTap editor: keys, paste, drop, upload pills, syncing the value |
| `apps/web/src/components/editor/MarkdownInput.tsx`       | Rich editor or textarea, image paste for both                         |
| `apps/web/src/components/editor/loadRichEditor.ts`       | Loading the editor's chunk                                            |
| `apps/web/src/components/task/MarkdownEditor.tsx`        | Save on blur or Ctrl/⌘+Enter, cancel on Esc, for the task panel       |
| `apps/web/src/index.css` (`.rich-markdown`)              | The editor's spacing, checkboxes and placeholder                      |
