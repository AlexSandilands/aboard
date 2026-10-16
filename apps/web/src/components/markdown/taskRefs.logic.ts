/*
 * Turns "#42" in Markdown text into links that open that task. Done on the Markdown tree rather than the string, so
 * code, existing links and headings' own "#" are left alone.
 */

/** Just the part of an mdast node this plugin reads and writes. */
export interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/** The href a task reference gets; the renderer swaps links with it for buttons that open the task. */
const TASK_REF_PREFIX = "#task-";

/** A "#" that isn't part of a word, an entity or another "#", then digits that end the word. */
const TASK_REF = /(?<![\w#&/])#(\d+)(?!\w)/g;

/** Subtrees whose text stays as written: a link inside a link is invalid, and code is literal. */
const LITERAL = new Set(["link", "linkReference", "code", "inlineCode", "definition"]);

/** The task number a link's href stands for, or null for any other link. */
export function taskRefNumber(href: string | undefined): number | null {
  const match = href?.startsWith(TASK_REF_PREFIX) ? /^\d+$/.exec(href.slice(TASK_REF_PREFIX.length)) : null;
  return match ? Number(match[0]) : null;
}

/** Splits text around the task numbers `isKnown` accepts. Returns null when there is nothing to link. */
function linkRefs(text: string, isKnown: (number: number) => boolean): MdNode[] | null {
  const nodes: MdNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TASK_REF)) {
    const number = Number(match[1]);
    if (!isKnown(number)) continue;
    if (match.index > last) nodes.push({ type: "text", value: text.slice(last, match.index) });
    nodes.push({
      type: "link",
      url: `${TASK_REF_PREFIX}${number}`,
      children: [{ type: "text", value: match[0] }],
    });
    last = match.index + match[0].length;
  }
  if (nodes.length === 0) return null;
  if (last < text.length) nodes.push({ type: "text", value: text.slice(last) });
  return nodes;
}

function visit(node: MdNode, isKnown: (number: number) => boolean): void {
  if (!node.children || LITERAL.has(node.type)) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && child.value) return linkRefs(child.value, isKnown) ?? [child];
    visit(child, isKnown);
    return [child];
  });
}

/** A remark plugin: links "#N" when `isKnown(N)`, so a number that isn't a task on the board stays text. */
export function remarkTaskRefs(isKnown: (number: number) => boolean) {
  return (tree: MdNode) => visit(tree, isKnown);
}
