import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import { richMarkdownSchema as schema } from "./richMarkdown.extensions";
import {
  canRoundTrip,
  docToMarkdown,
  hasUnsupportedSyntax,
  markdownToDoc,
  markdownToSlice,
  parseAttachmentToken,
  selectionToMarkdown,
} from "./richMarkdown.logic";

const ID = "81a89b6b-21e4-4069-8ba9-b6245e069151";
const OTHER = "b5f63c70-85cd-40fd-9070-2bbe30b0716a";

const roundTrip = (markdown: string) => docToMarkdown(markdownToDoc(schema, markdown));
const json = (markdown: string) => markdownToDoc(schema, markdown).toJSON() as { content: Record<string, unknown>[] };

describe("round trip", () => {
  it.each([
    ["empty", ""],
    ["a paragraph", "Just text."],
    ["blank lines and trailing newlines", "one\n\ntwo\n\n\n"],
    ["a leading newline", "\nafter"],
    ["emphasis", "**bold**, __bold__, *it*, _it_, ~~gone~~ and `code`"],
    ["nested emphasis", "***both*** and **bold *and it***"],
    ["bold code", "**`x`** then `a`"],
    ["links", "see [the docs](https://example.com/a_b) and [**bold** link](https://x.y)"],
    ["escapes", String.raw`not \*emphasis\* or \_this\_`],
    ["unclosed delimiters", "a * b and 2*3 and snake_case_name and **open"],
    ["other images stay text", "![logo](https://example.com/logo.png)"],
    ["bullets", "- one\n- two\n* star\n+ plus"],
    ["an empty item", "-\n- \n- x"],
    ["nested lists", "- a\n  - b\n    - c\n  - d\n- e"],
    ["ordered", "1. one\n2. two\n3. three"],
    ["ordered with the same number", "1. one\n1. two\n1. three"],
    ["ordered with a paren", "3) three\n4) four"],
    ["ordered under bullets", "- a\n  1. b\n  2. c"],
    ["tasks", "- [ ] todo\n- [x] done\n  - [ ] nested"],
    ["headings", "# One\n## Two\n###### Six\n#hashtag\n# "],
    ["quotes", "> quoted\n> more\n>tight"],
    ["a closed fence", "```ts\nconst a = 1;\n\n**not bold**\n```\nafter"],
    ["an unclosed fence", "```\ncode to the end"],
    ["a tilde fence", "~~~\n```\n~~~"],
    ["rules", "above\n\n---\n***\n___\n- - -"],
    ["a rule at the end", "text\n\n---"],
    ["an attachment", `see ![screenshot](attachment:${ID}) here`],
    ["attachments without spaces", `![a](attachment:${ID})![](attachment:${OTHER})`],
    ["attachments in lists and quotes", `- ![a](attachment:${ID})\n> ![b](attachment:${OTHER})`],
    ["an attachment in code", `\`![a](attachment:${ID})\`\n\`\`\`\n![b](attachment:${OTHER})\n\`\`\``],
    ["a task reference", "Blocked by #42, see #7."],
    ["trailing spaces", "line with two spaces  \nnext"],
  ])("keeps %s", (_, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
    expect(canRoundTrip(schema, markdown)).toBe(true);
  });

  it("keeps an agent-written description", () => {
    const description = [
      "## Context",
      "",
      "The **New Task** dialog shows the raw `![image](attachment:…)` token instead of a pill.",
      "",
      "Steps:",
      "",
      "1. Open the palette with `Ctrl+K`",
      "2. Paste a screenshot",
      "3. See the token",
      "",
      "- [ ] Fix the editor",
      "- [x] Write the plan",
      "",
      "> Note: the rendered view already shows pills.",
      "",
      "```sh",
      "pnpm --filter @repo/web test",
      "```",
      "",
      `Screenshot: ![image](attachment:${ID})`,
    ].join("\n");
    expect(canRoundTrip(schema, description)).toBe(true);
  });

  it("keeps a description written on the board", () => {
    const description = [
      `Example screenshot: ![image](attachment:${ID})`,
      "",
      `- It also doesn't work in the description text box on task panel, like this ![image](attachment:${OTHER})`,
      "- To be fair, no markdown renders, for example this is not turning into a bullet point",
      "- T3Code handles markdown while typing into boxes quite well, we could potentially follow them, I have the repo cloned locally ../t3code",
    ].join("\n");
    expect(canRoundTrip(schema, description)).toBe(true);
  });

  it("accepts CRLF line endings, which come back as LF", () => {
    expect(canRoundTrip(schema, "- a\r\n- b\r\n")).toBe(true);
    expect(roundTrip("- a\r\n- b\r\n")).toBe("- a\n- b\n");
  });

  it("refuses a lone carriage return", () => {
    expect(canRoundTrip(schema, "a\rb")).toBe(false);
  });
});

describe("unsupported syntax", () => {
  it.each([
    ["a table", "| a | b |\n| - | - |\n| 1 | 2 |"],
    ["a table without outer pipes", "a | b\n--|--\n1 | 2"],
    ["HTML", "<details>\n<summary>More</summary>\n</details>"],
    ["an HTML comment", "<!-- hidden -->"],
    ["a setext heading", "Title\n====="],
    ["a setext heading with a dash", "Title\n---"],
    ["a reference link", "[a][1]\n\n[1]: https://example.com"],
    ["indented code", "text\n\n    code"],
    ["a continuation line", "- item\n  continued"],
    ["a list in a quote", "> - item"],
    ["a nested quote", "> > deep"],
    ["a heading in a list", "- # heading"],
    ["a fence in a list", "- ```"],
  ])("refuses %s", (_, markdown) => {
    expect(hasUnsupportedSyntax(markdown)).toBe(true);
    expect(canRoundTrip(schema, markdown)).toBe(false);
  });

  it.each([
    ["a less-than sign", "a < b and x<y"],
    ["a tag in code", "use `<div>` here"],
    ["HTML in a fence", "```html\n<div></div>\n```"],
    ["a table in a fence", "```\n| a |\n```"],
    ["a rule after a blank line", "text\n\n---"],
  ])("allows %s", (_, markdown) => {
    expect(hasUnsupportedSyntax(markdown)).toBe(false);
  });

  it("refuses text that wouldn't come back the same", () => {
    // Siblings at different indents read as one list, but are written at one indent.
    expect(canRoundTrip(schema, "  - a\n - b")).toBe(false);
    // Out-of-order numbers that aren't one style are kept; increasing ones are renumbered.
    expect(canRoundTrip(schema, "1. a\n3. b\n7. c")).toBe(false);
  });
});

describe("markdownToDoc", () => {
  it("builds blocks with their source", () => {
    expect(json("## Title\n- [x] done\n1) one\n> q")).toMatchObject({
      content: [
        { type: "heading", attrs: { level: 2, space: " " } },
        { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true } }] },
        { type: "orderedList", attrs: { start: 1 }, content: [{ attrs: { marker: "1)" } }] },
        { type: "blockquote", attrs: { prefix: "> " } },
      ],
    });
  });

  it("makes an attachment token an atom", () => {
    expect(json(`a ![shot](attachment:${ID}) b`).content[0]).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "a " },
        { type: "attachment", attrs: { id: ID, alt: "shot" } },
        { type: "text", text: " b" },
      ],
    });
  });

  it("nests lists by indent", () => {
    const doc = json("- a\n  - b\n- c");
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]).toMatchObject({
      type: "bulletList",
      content: [{ content: [{ type: "paragraph" }, { type: "bulletList" }] }, { content: [{ type: "paragraph" }] }],
    });
  });
});

describe("docToMarkdown after edits", () => {
  const item = (text: string, attrs: Record<string, unknown> = {}) =>
    schema.nodes.listItem!.create(attrs, schema.nodes.paragraph!.create(null, text ? schema.text(text) : null));
  const doc = (...blocks: ProseMirrorNode[]) => schema.nodes.doc!.create(null, blocks);

  it("numbers a new ordered item after the one before", () => {
    const list = schema.nodes.orderedList!.create({ start: 1 }, [
      item("a", { marker: "1." }),
      item("new"),
      item("b", { marker: "2." }),
    ]);
    expect(docToMarkdown(doc(list))).toBe("1. a\n2. new\n3. b");
  });

  it("keeps a list numbered with one number that way", () => {
    const list = schema.nodes.orderedList!.create({ start: 1 }, [
      item("a", { marker: "1." }),
      item("b", { marker: "1." }),
      item("new"),
    ]);
    expect(docToMarkdown(doc(list))).toBe("1. a\n1. b\n1. new");
  });

  it("indents a nested list under its parent's marker when its indent is stale", () => {
    const nested = schema.nodes.bulletList!.create(null, [item("b", { indent: "", marker: "*" })]);
    const parent = schema.nodes.listItem!.create({ marker: "-" }, [
      schema.nodes.paragraph!.create(null, schema.text("a")),
      nested,
    ]);
    expect(docToMarkdown(doc(schema.nodes.bulletList!.create(null, [parent])))).toBe("- a\n  * b");
  });

  it("moves whitespace at the edge of bold outside it", () => {
    const bold = schema.marks.bold!.create();
    const paragraph = schema.nodes.paragraph!.create(null, [schema.text("a ", [bold]), schema.text("b")]);
    expect(docToMarkdown(doc(paragraph))).toBe("**a** b");
  });

  it("writes an upload still in progress as nothing", () => {
    const paragraph = schema.nodes.paragraph!.create(null, [
      schema.text("a"),
      schema.nodes.attachmentUpload!.create({ key: "1" }),
    ]);
    expect(docToMarkdown(doc(paragraph))).toBe("a");
  });

  it("closes an unclosed fence followed by a block", () => {
    const code = schema.nodes.codeBlock!.create({ fence: "```", close: "" }, schema.text("x"));
    expect(docToMarkdown(doc(code, schema.nodes.paragraph!.create(null, schema.text("after"))))).toBe(
      "```\nx\n```\nafter",
    );
  });

  it("lengthens a fence around code that holds one", () => {
    const code = schema.nodes.codeBlock!.create({ fence: "```", close: "\n```" }, schema.text("```\ninner"));
    expect(docToMarkdown(doc(code))).toBe("````\n```\ninner\n````");
  });
});

describe("clipboard", () => {
  it("reads one pasted line inline and more as blocks", () => {
    const inline = markdownToSlice(schema, "**b** text");
    expect(inline.openStart).toBe(0);
    expect(inline.content.firstChild?.marks[0]?.type.name).toBe("bold");
    const blocks = markdownToSlice(schema, "- a\n- b");
    expect(blocks.content.firstChild?.type.name).toBe("bulletList");
  });

  it("copies list items with their markers", () => {
    const doc = markdownToDoc(schema, "- one\n- two");
    expect(selectionToMarkdown(doc, 0, doc.content.size)).toBe("- one\n- two");
    // Inside the second item's text only.
    expect(selectionToMarkdown(doc, 10, 13)).toBe("two");
  });
});

describe("parseAttachmentToken", () => {
  it("reads a token and nothing else", () => {
    expect(parseAttachmentToken(`![shot](attachment:${ID})`)).toEqual({ id: ID, alt: "shot" });
    expect(parseAttachmentToken(`x ![shot](attachment:${ID})`)).toBeNull();
    expect(parseAttachmentToken("")).toBeNull();
  });
});
