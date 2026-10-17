// Adapted from T3 Code's composer-rich-text.ts (MIT) — see NOTICE.

/** A mark on a run of inline text, with what its Markdown needs to be written back the same way. */
export type InlineMark =
  | { type: "bold" | "italic"; delimiter: string }
  | { type: "strike" | "code" }
  | { type: "link"; href: string };

export interface InlineSpan {
  text: string;
  marks: InlineMark[];
}

export const markKey = (mark: InlineMark): string =>
  mark.type === "link" ? `link:${mark.href}` : "delimiter" in mark ? `${mark.type}:${mark.delimiter}` : mark.type;

const sameMarks = (a: InlineMark[], b: InlineMark[]): boolean =>
  a.length === b.length && a.every((mark, index) => markKey(mark) === markKey(b[index]!));

function pushSpan(spans: InlineSpan[], text: string, marks: InlineMark[]): void {
  if (!text) return;
  const last = spans.at(-1);
  if (last && sameMarks(last.marks, marks)) last.text += text;
  else spans.push({ text, marks });
}

// Only the simple forms, so writing one back gives the same text: no brackets in the text, no spaces or
// parentheses in the URL, no title.
const LINK = /^\[([^[\]\n]+)\]\(([^()\s]+)\)/;
const IMAGE = /^!\[[^[\]\n]*\]\([^()\s]*\)/;

/**
 * The emphasis, code spans and links in one line of Markdown. Anything else, escapes and images included,
 * stays literal text, so writing the spans back with their delimiters gives the line again.
 */
export function parseInlineMarkdown(text: string): InlineSpan[] {
  const root: InlineSpan[] = [];
  const stack: { delimiter: string; mark: InlineMark; spans: InlineSpan[] }[] = [];
  const current = () => stack.at(-1)?.spans ?? root;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\") {
      pushSpan(current(), text.slice(index, index + 2), []);
      index += 2;
      continue;
    }
    if (char === "!" && text[index + 1] === "[") {
      const image = IMAGE.exec(text.slice(index));
      if (image) {
        pushSpan(current(), image[0], []);
        index += image[0].length;
        continue;
      }
    }
    if (char === "[") {
      const link = LINK.exec(text.slice(index));
      if (link) {
        const mark: InlineMark = { type: "link", href: link[2]! };
        for (const span of parseInlineMarkdown(link[1]!)) pushSpan(current(), span.text, [mark, ...span.marks]);
        index += link[0].length;
        continue;
      }
    }
    if (char === "`") {
      const run = /^`+/.exec(text.slice(index))![0];
      const close = text.indexOf(run, index + run.length);
      if (run.length === 1 && close > index + 1 && text[close + 1] !== "`") {
        pushSpan(current(), text.slice(index + 1, close), [{ type: "code" }]);
        index = close + 1;
      } else {
        pushSpan(current(), run, []);
        index += run.length;
      }
      continue;
    }
    if (char !== "*" && char !== "_" && char !== "~") {
      pushSpan(current(), char, []);
      index += 1;
      continue;
    }
    let end = index;
    while (text[end] === char) end += 1;
    const before = text[index - 1] ?? "";
    const after = text[end] ?? "";
    const canClose = before !== "" && !/\s/.test(before) && (char !== "_" || !/\w/.test(after));
    const canOpen = after !== "" && !/\s/.test(after) && (char !== "_" || !/\w/.test(before));
    while (index < end) {
      const top = stack.at(-1);
      const opensNestedBold =
        top?.mark.type === "italic" &&
        end - index === 2 &&
        canOpen &&
        (char === "*" || char === "_") &&
        !stack.some((frame) => frame.mark.type === "bold");
      if (
        !opensNestedBold &&
        canClose &&
        top &&
        text.startsWith(top.delimiter, index) &&
        index + top.delimiter.length <= end
      ) {
        stack.pop();
        for (const span of top.spans) pushSpan(current(), span.text, [top.mark, ...span.marks]);
        index += top.delimiter.length;
      } else if (canOpen && (char !== "~" || end - index >= 2)) {
        const length = char === "~" || end - index >= 2 ? 2 : 1;
        const delimiter = char.repeat(length);
        const mark: InlineMark =
          char === "~" ? { type: "strike" } : { type: length === 2 ? "bold" : "italic", delimiter };
        // A mark can't nest inside itself, which also bounds the stack for any input.
        if (stack.some((frame) => frame.mark.type === mark.type)) {
          pushSpan(current(), text.slice(index, end), []);
          index = end;
          continue;
        }
        stack.push({ delimiter, mark, spans: [] });
        index += length;
      } else {
        pushSpan(current(), text.slice(index, end), []);
        index = end;
      }
    }
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    pushSpan(current(), frame.delimiter, []);
    for (const span of frame.spans) pushSpan(current(), span.text, span.marks);
  }
  return root;
}
