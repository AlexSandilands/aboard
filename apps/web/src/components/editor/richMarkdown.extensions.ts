// Adapted from T3 Code's composer-rich-text-doc.ts (MIT) — see NOTICE.
import { type AnyExtension, type Editor, Extension, getSchema, InputRule, Node } from "@tiptap/core";
import { Blockquote } from "@tiptap/extension-blockquote";
import { Bold } from "@tiptap/extension-bold";
import { Code } from "@tiptap/extension-code";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Heading } from "@tiptap/extension-heading";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { Italic } from "@tiptap/extension-italic";
import { Link } from "@tiptap/extension-link";
import { BulletList, ListItem, OrderedList, TaskItem, TaskList } from "@tiptap/extension-list";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, TextSelection, type Transaction } from "@tiptap/pm/state";
import { StarterKit } from "@tiptap/starter-kit";

/*
 * The schema holds only what the serializer in richMarkdown.logic.ts can write back as Markdown, and the
 * attributes keep the exact source (delimiters, indents, markers), so text that is opened and saved
 * unchanged stays byte for byte the same.
 */

/** Source attributes are for the serializer only, never the DOM; a new node (an Enter split) takes the default. */
const source = (fallback: unknown) => ({ default: fallback, rendered: false, keepOnSplit: false });

/**
 * Tiptap's block extensions bind chords that turn the current block into theirs (Mod-Shift-8 for a list,
 * Mod-Alt-c for a fence). Inside a quote or a list item they would nest a block the Markdown can't hold.
 * Tab and Shift-Tab sink and lift list items; here Tab moves the focus, as it does in a textarea.
 */
function without<Shortcuts extends Record<string, unknown>>(
  shortcuts: Shortcuts | undefined,
  drop: readonly string[],
): Shortcuts {
  return Object.fromEntries(Object.entries(shortcuts ?? {}).filter(([key]) => !drop.includes(key))) as Shortcuts;
}

/** A list item is its own line, then nested lists: all its Markdown can write. */
const LIST_ITEM_CONTENT = "paragraph list*";
const LIST_NESTING_KEYS = ["Tab", "Shift-Tab"];

const RichBold = Bold.extend({
  addAttributes: () => ({ delimiter: source(null) }),
});

const RichItalic = Italic.extend({
  addAttributes: () => ({ delimiter: source(null) }),
});

/** Tiptap's code mark excludes every other mark, which would drop the `**`x`**` Markdown allows. */
const RichCode = Code.extend({ excludes: "code" });

/** `[text](url)` typed out becomes a link; `![..](..)` is an image, which stays text. */
const RichLink = Link.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /\[([^[\]\n]+)\]\(([^()\s]+)\)$/,
        handler: ({ state, range, match }) => {
          if (range.from > 0 && state.doc.textBetween(range.from - 1, range.from) === "!") return null;
          state.tr.replaceWith(
            range.from,
            range.to,
            state.schema.text(match[1]!, [this.type.create({ href: match[2]! })]),
          );
        },
      }),
    ];
  },
}).configure({ openOnClick: false, autolink: false, linkOnPaste: false, enableClickSelection: false });

const RichListItem = ListItem.extend({
  content: LIST_ITEM_CONTENT,
  addAttributes() {
    return { ...this.parent?.(), indent: source(null), marker: source(null), space: source(null) };
  },
  addKeyboardShortcuts() {
    return without(this.parent?.(), LIST_NESTING_KEYS);
  },
});

const RichTaskItem = TaskItem.extend({
  content: LIST_ITEM_CONTENT,
  addAttributes() {
    return { ...this.parent?.(), indent: source(null), markerSpace: source(null), contentSpace: source(null) };
  },
  addKeyboardShortcuts() {
    return without(this.parent?.(), LIST_NESTING_KEYS);
  },
  addInputRules() {
    return [
      // `[ ] ` at the start of a bullet item makes it a task; the stock rule can only wrap a paragraph.
      new InputRule({
        find: /^\[([ xX])\]\s$/,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.depth < 3 || $from.node(-1).type.name !== "listItem" || $from.index(-1) !== 0) return null;
          if ($from.node(-2).type.name !== "bulletList") return null;
          convertBulletItemToTask(state.tr, range.from, range.to, match[1] !== " ");
        },
      }),
      ...(this.parent?.() ?? []),
    ];
  },
}).configure({ nested: true });

/** Replaces the bullet item at `from` with a task item, splitting its list around it. */
function convertBulletItemToTask(tr: Transaction, from: number, to: number, checked: boolean): void {
  tr.delete(from, to);
  const $pos = tr.doc.resolve(from);
  const item = $pos.node(-1);
  const list = $pos.node(-2);
  const index = $pos.index(-2);
  const { schema } = tr.doc.type;
  const before: ProseMirrorNode[] = [];
  const after: ProseMirrorNode[] = [];
  list.forEach((child, _, childIndex) => {
    if (childIndex < index) before.push(child);
    else if (childIndex > index) after.push(child);
  });
  const task = schema.nodes.taskItem!.create(
    { checked, indent: item.attrs.indent, markerSpace: item.attrs.space },
    item.content,
  );
  const lists = [
    ...(before.length > 0 ? [list.copy(Fragment.from(before))] : []),
    schema.nodes.taskList!.create(null, task),
    ...(after.length > 0 ? [list.copy(Fragment.from(after))] : []),
  ];
  const listStart = $pos.before(-2);
  tr.replaceWith(listStart, listStart + list.nodeSize, lists);
  const caret = listStart + (before.length > 0 ? lists[0]!.nodeSize : 0) + 3;
  tr.setSelection(TextSelection.create(tr.doc, caret));
}

const RichBulletList = BulletList.extend({
  addKeyboardShortcuts() {
    return without(this.parent?.(), ["Mod-Shift-8"]);
  },
});

const RichOrderedList = OrderedList.extend({
  addKeyboardShortcuts() {
    return without(this.parent?.(), ["Mod-Shift-7"]);
  },
});

const RichTaskList = TaskList.extend({
  addKeyboardShortcuts() {
    return without(this.parent?.(), ["Mod-Shift-9"]);
  },
});

const RichCodeBlock = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      language: { default: "" },
      fence: source("```"),
      close: source("\n```"),
    };
  },
  addKeyboardShortcuts() {
    return {
      ...without(this.parent?.(), ["Mod-Alt-c"]),
      Backspace: () => unwrapCodeBlockAtStart(this.editor),
    };
  },
});

/** Joining the code onto the line above instead would drop its fence and leave the code as stray lines. */
function unwrapCodeBlockAtStart(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.name !== "codeBlock" || $from.parentOffset !== 0) return false;
  const { schema } = editor.state;
  const paragraphs = $from.parent.textContent
    .split("\n")
    .map((line) => schema.nodes.paragraph!.create(null, line ? schema.text(line) : null));
  const start = $from.before();
  const tr = editor.state.tr.replaceWith(start, $from.after(), paragraphs);
  editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 1)));
  return true;
}

const RichBlockquote = Blockquote.extend({
  content: "paragraph+",
  addAttributes() {
    return { ...this.parent?.(), prefix: source("> ") };
  },
  addKeyboardShortcuts() {
    return without(this.parent?.(), ["Mod-Shift-b"]);
  },
});

const RichHeading = Heading.extend({
  addAttributes() {
    return { ...this.parent?.(), space: source(" ") };
  },
  addKeyboardShortcuts: () => ({}),
});

const RichHorizontalRule = HorizontalRule.extend({
  addAttributes() {
    return { ...this.parent?.(), source: source("---") };
  },
  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      // A rule at the very end leaves nowhere to type below it.
      new Plugin({
        appendTransaction: (transactions, _, state) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          if (state.doc.lastChild?.type.name !== "horizontalRule") return null;
          return state.tr.insert(state.doc.content.size, state.schema.nodes.paragraph!.create());
        },
      }),
    ];
  },
});

/** A pasted image, `![alt](attachment:id)`; the editor draws it as the same pill the rendered text shows. */
export const AttachmentNode = Node.create({
  name: "attachment",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    id: { default: "", parseHTML: (el) => el.getAttribute("data-attachment-id") ?? "" },
    alt: { default: "image", parseHTML: (el) => el.getAttribute("data-alt") ?? "image" },
  }),
  // Copy and paste inside the editor goes through this HTML.
  parseHTML: () => [{ tag: "span[data-attachment-id]" }],
  renderHTML: ({ node }) => [
    "span",
    { "data-attachment-id": node.attrs.id as string, "data-alt": node.attrs.alt as string },
    node.attrs.alt as string,
  ],
});

/** An image still uploading; it becomes an attachment node when the upload is done, and writes no Markdown. */
export const AttachmentUploadNode = Node.create({
  name: "attachmentUpload",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => ({ key: { default: "", rendered: false } }),
  // Never recreated from a paste: the upload that would replace it belongs to the original.
  parseHTML: () => [],
  renderHTML: () => ["span", { "data-attachment-upload": "" }, "Uploading image…"],
});

/** Shift+Enter starts a new line like Enter: a line break inside a block isn't something the Markdown keeps. */
const ShiftEnter = Extension.create({
  name: "shiftEnter",
  addKeyboardShortcuts() {
    return { "Shift-Enter": () => this.editor.commands.keyboardShortcut("Enter") };
  },
});

export const richMarkdownExtensions: AnyExtension[] = [
  StarterKit.configure({
    blockquote: false,
    bold: false,
    bulletList: false,
    code: false,
    codeBlock: false,
    hardBreak: false,
    heading: false,
    horizontalRule: false,
    italic: false,
    link: false,
    listItem: false,
    orderedList: false,
    trailingNode: false,
    underline: false,
  }),
  RichBold,
  RichItalic,
  RichCode,
  RichLink,
  RichBulletList,
  RichOrderedList,
  RichListItem,
  RichTaskList,
  RichTaskItem,
  RichCodeBlock,
  RichBlockquote,
  RichHeading,
  RichHorizontalRule,
  AttachmentNode,
  AttachmentUploadNode,
  ShiftEnter,
];

export const richMarkdownSchema = getSchema(richMarkdownExtensions);
