/*
 * GitHub alerts: a quote whose first line is just "[!NOTE]" (or TIP, IMPORTANT, WARNING, CAUTION) renders as a
 * callout. Written as quote lines, so the text stays plain Markdown that GitHub and the rich editor read too.
 */

export const ALERT_TYPES = ["note", "tip", "important", "warning", "caution"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** Just the part of an mdast node this plugin reads and writes. */
export interface AlertNode {
  type: string;
  value?: string;
  children?: AlertNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** The marker alone on the quote's first line, as GitHub requires: text on the same line keeps it a plain quote. */
const MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n|$)/i;

/** The alert type a rendered element stands for, from the `data-alert` attribute the plugin sets. */
export function alertTypeOf(value: unknown): AlertType | null {
  return typeof value === "string" && (ALERT_TYPES as readonly string[]).includes(value) ? (value as AlertType) : null;
}

/** Strips the marker from the quote's first paragraph; returns the type, or null when the quote isn't an alert. */
function takeMarker(quote: AlertNode): AlertType | null {
  const paragraph = quote.children?.[0];
  const first = paragraph?.type === "paragraph" ? paragraph.children?.[0] : undefined;
  if (!paragraph?.children || first?.type !== "text" || !first.value) return null;
  const match = MARKER.exec(first.value);
  if (!match) return null;
  // A marker followed by a hard break ("[!NOTE]  ") keeps the marker's text node empty and the break after it.
  if (!match[0].endsWith("\n") && paragraph.children[1] && paragraph.children[1].type !== "break") return null;
  const rest = first.value.slice(match[0].length);
  paragraph.children.splice(0, 1, ...(rest ? [{ ...first, value: rest }] : []));
  if (paragraph.children[0]?.type === "break") paragraph.children.shift();
  if (paragraph.children.length === 0) quote.children!.shift();
  return match[1]!.toLowerCase() as AlertType;
}

function visit(node: AlertNode): void {
  for (const child of node.children ?? []) {
    if (child.type === "blockquote") {
      const type = takeMarker(child);
      if (type) child.data = { ...child.data, hName: "aside", hProperties: { dataAlert: type } };
    }
    visit(child);
  }
}

/** A remark plugin: turns GitHub alert quotes into `<aside data-alert="note">`, the marker line removed. */
export function remarkAlerts() {
  return (tree: AlertNode) => visit(tree);
}
