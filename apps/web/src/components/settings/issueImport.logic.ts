/** A comma- or whitespace-separated list of tool permission rules, without blanks or repeats. */
export function parseToolList(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
}
