// Adapted from T3 Code's composer-rich-text-doc.ts (MIT) — see NOTICE.
import { Fragment, type Mark, type Node as ProseMirrorNode, type Schema, Slice } from "@tiptap/pm/model";

import { type InlineMark, markKey, parseInlineMarkdown } from "./inlineMarkdown.logic";

/*
 * Markdown is what the board stores; the editor's document is built from it and written back to it. The
 * model is line based, as in T3 Code's composer: each line is one block (a blank line is an empty
 * paragraph), and blocks keep their exact delimiters as attributes. So text written back unchanged is the
 * same text, and `canRoundTrip` checks that before the editor is used for it.
 */

type Json = Record<string, unknown>;

const ATTACHMENT = /!\[([^[\]\n]*)\]\(attachment:([0-9a-f-]{36})\)/g;

/** The attachment a token (`![alt](attachment:id)`) is, or null. */
export function parseAttachmentToken(token: string): { id: string; alt: string } | null {
  const match = new RegExp(`^${ATTACHMENT.source}$`).exec(token);
  return match ? { id: match[2]!, alt: match[1]! } : null;
}

const attachmentSource = (node: ProseMirrorNode): string =>
  `![${node.attrs.alt as string}](attachment:${node.attrs.id as string})`;

// ── Line grammar ─────────────────────────────────────────────────────────

interface TaskPrefix {
  kind: "task";
  indent: string;
  checked: boolean;
  markerSpace: string;
  contentSpace: string;
}
type ListPrefix = TaskPrefix | { kind: "bullet" | "ordered"; indent: string; marker: string; space: string };

function parseListPrefix(line: string): { prefix: ListPrefix; length: number } | null {
  const task = /^([ \t]*)-([ \t]+)\[([ xX])\]([ \t]*)/.exec(line);
  if (task && (task[0].length === line.length || task[4])) {
    return {
      prefix: {
        kind: "task",
        indent: task[1]!,
        checked: task[3] !== " ",
        markerSpace: task[2]!,
        contentSpace: task[4]!,
      },
      length: task[0].length,
    };
  }
  const ordered = /^([ \t]*)(\d{1,9}[.)])([ \t]+|$)/.exec(line);
  if (ordered) {
    return {
      prefix: { kind: "ordered", indent: ordered[1]!, marker: ordered[2]!, space: ordered[3]! },
      length: ordered[0].length,
    };
  }
  const bullet = /^([ \t]*)([-*+])([ \t]+|$)/.exec(line);
  if (bullet) {
    return {
      prefix: { kind: "bullet", indent: bullet[1]!, marker: bullet[2]!, space: bullet[3]! },
      length: bullet[0].length,
    };
  }
  return null;
}

const listKey = (prefix: ListPrefix): string =>
  prefix.kind === "task" ? "task" : prefix.kind === "ordered" ? `ordered${prefix.marker.slice(-1)}` : prefix.marker;

export function parseOpeningFence(line: string): { fence: string; language: string } | null {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const fence = match[1]!;
  const language = match[2]!;
  if (fence.startsWith("`") && language.includes("`")) return null;
  return { fence, language };
}

export function isClosingFence(line: string, fence: string): boolean {
  const match = /^(`{3,}|~{3,})[ \t]*$/.exec(line);
  return match !== null && match[1]![0] === fence[0] && match[1]!.length >= fence.length;
}

const RULE = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^(#{1,6})([ \t]+)(.*)$/;
const QUOTE = /^(>[ \t]*)(.*)$/;

// ── Markdown → document ──────────────────────────────────────────────────

interface PendingItem {
  prefix: ListPrefix;
  content: Json[];
  children: PendingList[];
}
interface PendingList {
  key: string;
  items: PendingItem[];
}

function listJson(list: PendingList): Json {
  const first = list.items[0]!.prefix;
  const items = list.items.map((item) => {
    const content = [{ type: "paragraph", content: item.content }, ...item.children.map(listJson)];
    const { prefix } = item;
    if (prefix.kind === "task") {
      const { checked, indent, markerSpace, contentSpace } = prefix;
      return { type: "taskItem", attrs: { checked, indent, markerSpace, contentSpace }, content };
    }
    return { type: "listItem", attrs: { indent: prefix.indent, marker: prefix.marker, space: prefix.space }, content };
  });
  if (first.kind === "task") return { type: "taskList", content: items };
  if (first.kind === "ordered") {
    return { type: "orderedList", attrs: { start: Number.parseInt(first.marker, 10) }, content: items };
  }
  return { type: "bulletList", content: items };
}

const markJson = (mark: InlineMark): Json => {
  switch (mark.type) {
    case "link":
      return { type: "link", attrs: { href: mark.href } };
    case "bold":
    case "italic":
      return { type: mark.type, attrs: { delimiter: mark.delimiter } };
    default:
      return { type: mark.type };
  }
};

/** The editor document (as JSON) for `markdown`, which must use "\n" line endings. */
export function markdownToDocJson(markdown: string): Json {
  // Attachments become one character, so the inline parser can't take their alt text for emphasis.
  let sentinel = "￼";
  for (let codePoint = 0xe000; markdown.includes(sentinel); codePoint += 1) sentinel = String.fromCodePoint(codePoint);
  const atoms: { id: string; alt: string; source: string }[] = [];
  const text = markdown.replace(ATTACHMENT, (source: string, alt: string, id: string) => {
    atoms.push({ id, alt, source });
    return sentinel;
  });
  let atomIndex = 0;
  const inline = (content: string): Json[] => {
    const nodes: Json[] = [];
    for (const span of parseInlineMarkdown(content)) {
      const marks = span.marks.map(markJson);
      span.text.split(sentinel).forEach((piece, index) => {
        if (index > 0) {
          const atom = atoms[atomIndex++]!;
          nodes.push({ type: "attachment", attrs: { id: atom.id, alt: atom.alt }, ...(marks.length ? { marks } : {}) });
        }
        if (piece) nodes.push({ type: "text", text: piece, ...(marks.length ? { marks } : {}) });
      });
    }
    return nodes;
  };
  // Code is literal: the attachments in it go back to their source.
  const literal = (line: string): string =>
    line.split(sentinel).reduce((joined, piece) => joined + atoms[atomIndex++]!.source + piece);

  const blocks: Json[] = [];
  let rootLists: PendingList[] = [];
  let stack: { indent: string; list: PendingList; container: PendingList[] }[] = [];
  const flushLists = () => {
    for (const list of rootLists) blocks.push(listJson(list));
    rootLists = [];
    stack = [];
  };
  let quote: { prefix: string; lines: Json[][] } | null = null;
  const flushQuote = () => {
    if (!quote) return;
    blocks.push({
      type: "blockquote",
      attrs: { prefix: quote.prefix },
      content: quote.lines.map((content) => ({ type: "paragraph", content })),
    });
    quote = null;
  };
  const openList = (container: PendingList[], key: string): PendingList => {
    const list: PendingList = { key, items: [] };
    container.push(list);
    return list;
  };

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const quoted = QUOTE.exec(line);
    if (quoted) {
      flushLists();
      if (quote && quote.prefix !== quoted[1]) flushQuote();
      quote ??= { prefix: quoted[1]!, lines: [] };
      quote.lines.push(inline(quoted[2]!));
      continue;
    }
    flushQuote();
    const opening = parseOpeningFence(line);
    if (opening) {
      flushLists();
      const language = literal(opening.language);
      const body: string[] = [];
      let close = "";
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        if (isClosingFence(lines[cursor]!, opening.fence)) {
          close = `\n${lines[cursor]!}`;
          break;
        }
        body.push(literal(lines[cursor]!));
      }
      const code = body.join("\n");
      blocks.push({
        type: "codeBlock",
        attrs: { language, fence: opening.fence, close },
        ...(code ? { content: [{ type: "text", text: code }] } : {}),
      });
      index = cursor;
      continue;
    }
    if (RULE.test(line)) {
      flushLists();
      blocks.push({ type: "horizontalRule", attrs: { source: line } });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushLists();
      blocks.push({
        type: "heading",
        attrs: { level: heading[1]!.length, space: heading[2]! },
        content: inline(heading[3]!),
      });
      continue;
    }
    const parsed = parseListPrefix(line);
    if (!parsed) {
      flushLists();
      blocks.push({ type: "paragraph", content: inline(line) });
      continue;
    }
    const item: PendingItem = { prefix: parsed.prefix, content: inline(line.slice(parsed.length)), children: [] };
    const key = listKey(parsed.prefix);
    const { indent } = parsed.prefix;
    for (;;) {
      const top = stack.at(-1);
      if (!top) {
        stack.push({ indent, list: openList(rootLists, key), container: rootLists });
        continue;
      }
      if (top.indent === indent) {
        if (top.list.key !== key) top.list = openList(top.container, key);
        top.list.items.push(item);
        break;
      }
      if (!indent.startsWith(top.indent)) {
        if (stack.length > 1) {
          stack.pop();
          continue;
        }
        top.indent = indent;
        if (top.list.key !== key) top.list = openList(top.container, key);
        top.list.items.push(item);
        break;
      }
      const parent = top.list.items.at(-1)!;
      const list = openList(parent.children, key);
      stack.push({ indent, list, container: parent.children });
      list.items.push(item);
      break;
    }
  }
  flushQuote();
  flushLists();
  if (blocks.at(-1)?.type === "horizontalRule") blocks.push({ type: "paragraph" });
  return { type: "doc", content: blocks };
}

export const markdownToDoc = (schema: Schema, markdown: string): ProseMirrorNode =>
  schema.nodeFromJSON(markdownToDocJson(normalizeLineEndings(markdown)));

export const normalizeLineEndings = (markdown: string): string => markdown.replace(/\r\n?/g, "\n");

// ── Document → Markdown ──────────────────────────────────────────────────

interface MarkSource {
  key: string;
  open: string;
  close: string;
  rank: number;
}

/** Outermost first; code is always innermost, since nothing inside it is Markdown. */
const MARK_RANK: Record<string, number> = { link: 0, strike: 1, bold: 2, italic: 3, code: 4 };

function markSource(mark: Mark): MarkSource | null {
  const name = mark.type.name;
  const rank = MARK_RANK[name];
  if (rank === undefined) return null;
  if (name === "link") {
    const href = typeof mark.attrs.href === "string" ? mark.attrs.href : "";
    return { key: markKey({ type: "link", href }), open: "[", close: `](${href})`, rank };
  }
  if (name === "bold" || name === "italic") {
    const fallback = name === "bold" ? "**" : "*";
    const delimiter = typeof mark.attrs.delimiter === "string" ? mark.attrs.delimiter : fallback;
    return { key: markKey({ type: name, delimiter }), open: delimiter, close: delimiter, rank };
  }
  const delimiter = name === "code" ? "`" : "~~";
  return { key: name, open: delimiter, close: delimiter, rank };
}

const EMPHASIS = new Set(["bold", "italic", "strike"]);

function serializeInline(container: ProseMirrorNode): string {
  // Whitespace at the edge of emphasis can't be written inside its delimiters, so it moves out of the mark.
  const children: ProseMirrorNode[] = [];
  container.forEach((child) => {
    if (!child.isText || child.marks.some((mark) => mark.type.name === "code")) {
      children.push(child);
      return;
    }
    const text = child.text!;
    const start = text.length - text.trimStart().length;
    const end = Math.max(start, text.trimEnd().length);
    let offset = 0;
    for (const boundary of [start, end, text.length]) {
      if (boundary > offset) children.push(child.cut(offset, boundary));
      offset = boundary;
    }
  });
  for (const name of EMPHASIS) {
    for (const direction of [1, -1]) {
      let hasContent = false;
      for (
        let index = direction === 1 ? 0 : children.length - 1;
        index >= 0 && index < children.length;
        index += direction
      ) {
        const child = children[index]!;
        if (!child.marks.some((mark) => mark.type.name === name)) hasContent = false;
        else if (child.isText && /^\s+$/.test(child.text!)) {
          if (!hasContent) children[index] = child.mark(child.marks.filter((mark) => mark.type.name !== name));
        } else hasContent = true;
      }
    }
  }
  // Marks that run on further open first, so each delimiter is written once around its whole run.
  const sources = children.map((child) =>
    child.marks.map(markSource).filter((source): source is MarkSource => source !== null),
  );
  const markEnds = new Map<string, number>();
  const ordered: MarkSource[][] = [];
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const marks = sources[index]!;
    for (const key of markEnds.keys()) {
      if (!marks.some((mark) => mark.key === key)) markEnds.delete(key);
    }
    for (const mark of marks) if (!markEnds.has(mark.key)) markEnds.set(mark.key, index);
    ordered[index] = [...marks].sort(
      (a, b) =>
        Number(a.rank === MARK_RANK.code) - Number(b.rank === MARK_RANK.code) ||
        markEnds.get(b.key)! - markEnds.get(a.key)! ||
        a.rank - b.rank,
    );
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const marks = ordered[index]!;
    const retained: MarkSource[] = [];
    for (const mark of ordered[index - 1]!) {
      if (mark.rank === MARK_RANK.code || !marks.some((other) => other.key === mark.key)) break;
      retained.push(mark);
    }
    ordered[index] = [...retained, ...marks.filter((mark) => !retained.some((kept) => kept.key === mark.key))];
  }
  const common = (left: MarkSource[], right: MarkSource[]): number => {
    let index = 0;
    while (index < left.length && left[index]!.key === right[index]?.key) index += 1;
    return index;
  };
  let out = "";
  children.forEach((child, index) => {
    const marks = ordered[index]!;
    const open = marks.slice(common(marks, ordered[index - 1] ?? [])).map((mark) => mark.open);
    const close = marks
      .slice(common(marks, ordered[index + 1] ?? []))
      .toReversed()
      .map((mark) => mark.close);
    const content = child.isText ? child.text! : child.type.name === "attachment" ? attachmentSource(child) : "";
    out += open.join("") + content + close.join("");
  });
  return out;
}

function codeBlockSource(node: ProseMirrorNode, followed: boolean): string {
  let fence = typeof node.attrs.fence === "string" && node.attrs.fence ? node.attrs.fence : "```";
  const language = typeof node.attrs.language === "string" ? node.attrs.language : "";
  let close = typeof node.attrs.close === "string" ? node.attrs.close : "";
  const content = node.textContent;
  // Code holding a line that would close the fence (a pasted fence, say) is written inside a longer one.
  const longest = Math.max(
    0,
    ...content
      .split("\n")
      .filter((line) => isClosingFence(line, fence))
      .map((line) => /^[`~]+/.exec(line)![0].length),
  );
  if (longest > 0) {
    fence = fence[0]!.repeat(longest + 1);
    if (close) close = `\n${fence}`;
  }
  // An unclosed fence runs to the end of the text, so with a block after it the fence is closed.
  if (!close && followed) close = `\n${fence}`;
  return `${fence}${language}${content ? `\n${content}` : ""}${close}`;
}

const LIST_NAMES = new Set(["bulletList", "orderedList", "taskList"]);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * The numbers an ordered list's items are written with. Items keep theirs when they still make sense; one
 * that Enter just made (no marker yet) continues the count, or the list's style when every number is the
 * same ("1." each time).
 */
function orderedMarkers(list: ProseMirrorNode): string[] {
  const stored = list.content.content.map((item) => {
    const match = /^(\d+)([.)])$/.exec(str(item.attrs.marker) ?? "");
    return match ? { n: Number(match[1]), delimiter: match[2]! } : null;
  });
  const known = stored.filter((marker) => marker !== null);
  const delimiter = known[0]?.delimiter ?? ".";
  const start = typeof list.attrs.start === "number" ? list.attrs.start : 1;
  if (known.length > 1 && known.every((marker) => marker.n === known[0]!.n)) {
    return stored.map(() => `${known[0]!.n}${delimiter}`);
  }
  if (known.every((marker, index) => index === 0 || marker.n > known[index - 1]!.n)) {
    return stored.map((_, index) => `${start + index}${delimiter}`);
  }
  let previous = start - 1;
  return stored.map((marker) => {
    previous = marker ? marker.n : previous + 1;
    return `${previous}${delimiter}`;
  });
}

/**
 * The lines of a list. Every item in it takes one indent (else it would read back as nesting), nested
 * lists sit deeper than their parent item, and a bullet list uses one marker throughout.
 */
function serializeList(list: ProseMirrorNode, parent: { indent: string; width: number } | null): string[] {
  const items = list.content.content;
  const storedIndent = items.map((item) => str(item.attrs.indent)).find((indent) => indent !== null) ?? null;
  const indent = parent
    ? storedIndent !== null && storedIndent.startsWith(parent.indent) && storedIndent.length > parent.indent.length
      ? storedIndent
      : parent.indent + " ".repeat(parent.width)
    : (storedIndent ?? "");
  const bullet =
    items.map((item) => str(item.attrs.marker)).find((marker) => marker !== null && /^[-*+]$/.test(marker)) ?? "-";
  const numbers = list.type.name === "orderedList" ? orderedMarkers(list) : [];
  const lines: string[] = [];
  items.forEach((item, index) => {
    const paragraph = item.firstChild!;
    const text = serializeInline(paragraph);
    const empty = paragraph.content.size === 0;
    let marker: string;
    if (item.type.name === "taskItem") {
      const markerSpace = str(item.attrs.markerSpace) || " ";
      const contentSpace = str(item.attrs.contentSpace) ?? (empty ? "" : " ");
      marker = `-${markerSpace}[${item.attrs.checked === true ? "x" : " "}]${contentSpace || (empty ? "" : " ")}`;
    } else {
      const space = str(item.attrs.space) ?? (empty ? "" : " ");
      marker = `${numbers[index] ?? bullet}${space || (empty ? "" : " ")}`;
    }
    lines.push(indent + marker + text);
    item.forEach((child, _, childIndex) => {
      if (childIndex > 0) lines.push(...serializeList(child, { indent, width: marker.length }));
    });
  });
  return lines;
}

/** Whether a block ends in a line of text the next line could continue (a lazy continuation). */
const endsInText = (block: ProseMirrorNode | undefined): boolean =>
  block !== undefined &&
  (LIST_NAMES.has(block.type.name) ||
    block.type.name === "blockquote" ||
    (block.type.name === "paragraph" && block.content.size > 0));

/** The Markdown for an editor document. */
export function docToMarkdown(doc: ProseMirrorNode): string {
  const lines: string[] = [];
  const blocks = doc.content.content;
  blocks.forEach((block, index) => {
    switch (block.type.name) {
      case "paragraph":
        // The empty line kept after a closing rule (see the rule extension) isn't in the Markdown.
        if (index === blocks.length - 1 && index > 0 && block.content.size === 0) {
          if (blocks[index - 1]!.type.name === "horizontalRule") return;
        }
        // A line straight after a list or quote would read as part of its last item or line (a lazy
        // continuation), so a blank line keeps it apart; text written that way opens in the textarea.
        if (block.content.size > 0 && index > 0) {
          const previous = blocks[index - 1]!.type.name;
          if (previous === "blockquote" || LIST_NAMES.has(previous)) lines.push("");
        }
        const text = serializeInline(block);
        // A line of only "=" or "-" under text would underline it as a heading.
        const prior = blocks[index - 1];
        if (prior?.type.name === "paragraph" && prior.content.size > 0 && /^ {0,3}(=+|-+)[ \t]*$/.test(text)) {
          lines.push("");
        }
        lines.push(text);
        return;
      case "heading": {
        const level = typeof block.attrs.level === "number" ? block.attrs.level : 1;
        lines.push(`${"#".repeat(level)}${str(block.attrs.space) || " "}${serializeInline(block)}`);
        return;
      }
      case "blockquote": {
        const prefix = str(block.attrs.prefix) || "> ";
        block.forEach((child) => lines.push(prefix + serializeInline(child)));
        return;
      }
      case "codeBlock":
        lines.push(codeBlockSource(block, index < blocks.length - 1));
        return;
      case "horizontalRule": {
        const source = str(block.attrs.source) || "---";
        // Under a line of text, dashes alone are a heading underline, not a rule.
        const previous = blocks[index - 1];
        if (previous?.type.name === "paragraph" && previous.content.size > 0 && /^-+[ \t]*$/.test(source)) {
          lines.push("");
        }
        lines.push(source);
        return;
      }
      default:
        if (LIST_NAMES.has(block.type.name)) {
          const list = serializeList(block, null);
          // Straight after a line of text (a list's or a quote's too), only an item with text, marked with a
          // bullet or "1.", starts a list; any other reads as more of that text (or "-" alone as an underline).
          const interrupts = /^[ \t]*([-*+]|1[.)])[ \t]+\S/.test(list[0]!);
          if (endsInText(blocks[index - 1]) && !interrupts) lines.push("");
          lines.push(...list);
        }
    }
  });
  return lines.join("\n");
}

// ── Round trip ───────────────────────────────────────────────────────────

/**
 * Markdown the line model would show as something it isn't: tables, HTML, setext headings, reference
 * links, indented code or continuation lines, and blocks nested in quotes or list items. It round-trips as
 * text, but would look wrong in the editor, so it is edited as plain text instead.
 */
export function hasUnsupportedSyntax(markdown: string): boolean {
  const lines = markdown.split("\n");
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (fence) {
      if (isClosingFence(line, fence)) fence = null;
      continue;
    }
    const opening = parseOpeningFence(line);
    if (opening) {
      fence = opening.fence;
      continue;
    }
    const previous = index > 0 ? lines[index - 1]! : "";
    if (/^\s*\|/.test(line) || /^\s*\|?\s*:?-+:?\s*(\|\s*:?-*:?\s*)+\|?\s*$/.test(line)) return true;
    if (/^ {0,3}(=+|-+)\s*$/.test(line) && previous.trim() !== "" && !RULE.test(previous)) {
      if (!parseListPrefix(previous) && !HEADING.test(previous) && !QUOTE.test(previous)) return true;
    }
    if (/^ {0,3}\[[^\]]+\]:/.test(line)) return true;
    if (/^\s+\S/.test(line) && !parseListPrefix(line)) return true;
    const quoted = QUOTE.exec(line);
    if (quoted && /^(>|#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|`{3}|~{3})/.test(quoted[2]!)) return true;
    const item = parseListPrefix(line);
    if (item && /^(>|#{1,6}\s|`{3}|~{3})/.test(line.slice(item.length))) return true;
    // Tags and comments outside code spans; a lone `<` or `a < b` is fine.
    if (/<\/?[A-Za-z][\w-]*(\s[^<>]*)?\/?>|<!--/.test(line.replace(/`[^`]*`/g, ""))) return true;
  }
  return false;
}

/**
 * Whether `markdown` can be edited in the rich editor: nothing in it is unsupported, and building the
 * document and writing it back gives the same text (with "\n" line endings; a lone "\r" can't be kept).
 */
export function canRoundTrip(schema: Schema, markdown: string): boolean {
  if (/\r(?!\n)/.test(markdown)) return false;
  const text = normalizeLineEndings(markdown);
  if (hasUnsupportedSyntax(text)) return false;
  try {
    const doc = schema.nodeFromJSON(markdownToDocJson(text));
    doc.check();
    return docToMarkdown(doc) === text;
  } catch {
    return false;
  }
}

// ── Clipboard ────────────────────────────────────────────────────────────

/** Pasted text, read as Markdown; a single line goes in inline, more as blocks. */
export function markdownToSlice(schema: Schema, markdown: string): Slice {
  const doc = markdownToDoc(schema, markdown);
  const first = doc.firstChild;
  if (doc.childCount === 1 && first?.type.name === "paragraph") return new Slice(first.content, 0, 0);
  const open = (node: ProseMirrorNode | null) => (node?.type.name === "paragraph" ? 1 : 0);
  return new Slice(doc.content, open(doc.firstChild), open(doc.lastChild));
}

/** The language VS Code reports for copied text (its `vscode-editor-data` JSON), or null when absent or unreadable. */
export function vscodePasteMode(data: string | null | undefined): string | null {
  if (!data) return null;
  try {
    const mode = (JSON.parse(data) as { mode?: unknown } | null)?.mode;
    return typeof mode === "string" ? mode : null;
  } catch {
    return null;
  }
}

/**
 * The Markdown for a copied selection. A slice holds only the content of the blocks its ends share, so
 * items and quote lines arrive without the list or quote that writes their markers: those are put back.
 */
export function selectionToMarkdown(doc: ProseMirrorNode, from: number, to: number): string {
  const slice = doc.slice(from, to);
  const $from = doc.resolve(from);
  let depth = $from.sharedDepth(to);
  let content: Fragment | ProseMirrorNode = slice.content;
  if (slice.content.firstChild?.isInline) {
    content = doc.type.schema.nodes.paragraph!.create(null, slice.content);
  } else {
    while (depth > 0) {
      const shared = $from.node(depth);
      content = shared.copy(Fragment.from(content));
      if (shared.type.name !== "listItem" && shared.type.name !== "taskItem") break;
      depth -= 1;
    }
  }
  try {
    return docToMarkdown(doc.type.create(null, content));
  } catch {
    return doc.textBetween(from, to, "\n");
  }
}
