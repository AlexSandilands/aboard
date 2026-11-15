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

/**
 * A "#" that isn't part of a word, an entity or another "#", then digits that end the word, after the prefix of a
 * task a machine numbered ("#E7") when there is one.
 */
const TASK_REF = /(?<![\w#&/])#([A-Za-z][A-Za-z0-9]{0,2})?(\d+)(?!\w)/g;

/** A task's number as these links carry it: the number, or the text ("E7") for one a machine numbered. */
export type TaskRefKey = number | string;

/** Subtrees whose text stays as written: a link inside a link is invalid, and code is literal. */
const LITERAL = new Set(["link", "linkReference", "code", "inlineCode", "definition"]);

/** The task number a link's href stands for, or null for any other link. */
export function taskRefNumber(href: string | undefined): TaskRefKey | null {
  if (!href?.startsWith(TASK_REF_PREFIX)) return null;
  const key = href.slice(TASK_REF_PREFIX.length);
  if (/^\d+$/.test(key)) return Number(key);
  return /^[A-Z][A-Z0-9]{0,2}\d+$/.test(key) ? key : null;
}

/** Splits text around the task numbers `isKnown` accepts. Returns null when there is nothing to link. */
function linkRefs(text: string, isKnown: (number: TaskRefKey) => boolean): MdNode[] | null {
  const nodes: MdNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TASK_REF)) {
    const number: TaskRefKey = match[1] ? `${match[1].toUpperCase()}${match[2]}` : Number(match[2]);
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

function visit(node: MdNode, isKnown: (number: TaskRefKey) => boolean): void {
  if (!node.children || LITERAL.has(node.type)) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && child.value) return linkRefs(child.value, isKnown) ?? [child];
    visit(child, isKnown);
    return [child];
  });
}

/** A remark plugin: links "#N" when `isKnown(N)`, so a number that isn't a task on the board stays text. */
export function remarkTaskRefs(isKnown: (number: TaskRefKey) => boolean) {
  return (tree: MdNode) => visit(tree, isKnown);
}
