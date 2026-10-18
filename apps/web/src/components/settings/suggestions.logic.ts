// Pure helpers for the Suggestions section: a line diff of the current and proposed text, and evidence as links.

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/**
 * Past this many cells in the table of the changed middle, the diff gives up on alignment and shows that part old
 * then new, whole. The text is an agent's, so its size is the agent's to choose.
 */
const MAX_DIFF_CELLS = 1_000_000;

const linesOf = (text: string): string[] => text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");

/**
 * The lines of `before` and `after` as removed, added or unchanged, by longest common subsequence. Line endings are
 * ignored, so a CRLF file and an LF proposal differ only where their text does.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const all = { a: linesOf(before), b: linesOf(after) };
  // Most suggestions change a few lines: the common start and end need no table.
  let start = 0;
  while (start < all.a.length && start < all.b.length && all.a[start] === all.b[start]) start++;
  let end = 0;
  while (
    end < all.a.length - start &&
    end < all.b.length - start &&
    all.a[all.a.length - 1 - end] === all.b[all.b.length - 1 - end]
  ) {
    end++;
  }
  const same = (lines: string[]): DiffLine[] => lines.map((text) => ({ kind: "same", text }));
  const head = same(all.a.slice(0, start));
  const tail = same(all.a.slice(all.a.length - end));
  return [
    ...head,
    ...middleDiff(all.a.slice(start, all.a.length - end), all.b.slice(start, all.b.length - end)),
    ...tail,
  ];
}

function middleDiff(a: string[], b: string[]): DiffLine[] {
  if ((a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS) {
    return [
      ...a.map((text) => ({ kind: "removed" as const, text })),
      ...b.map((text) => ({ kind: "added" as const, text })),
    ];
  }
  // lcs[i][j]: the length of the longest common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "removed", text: a[i++]! });
    } else {
      out.push({ kind: "added", text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++]! });
  while (j < b.length) out.push({ kind: "added", text: b[j++]! });
  return out;
}

export type DiffHunkLine = DiffLine | { kind: "skipped"; count: number };

/** The diff with long runs of unchanged lines folded down to `context` lines either side of a change. */
export function foldDiff(lines: readonly DiffLine[], context = 3): DiffHunkLine[] {
  const changed = lines.map((l) => l.kind !== "same");
  const near = (index: number) => {
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) {
      if (changed[k]) return true;
    }
    return false;
  };
  const out: DiffHunkLine[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (line.kind !== "same" || near(index)) {
      if (skipped > 0) out.push({ kind: "skipped", count: skipped });
      skipped = 0;
      out.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ kind: "skipped", count: skipped });
  return out;
}

export type Evidence =
  | { kind: "task"; number: number; text: string }
  | { kind: "url"; url: string }
  | { kind: "text"; text: string };

/** A piece of evidence: a task ref ("#42", "#42 slow review"), an http(s) URL, or a note. */
export function parseEvidence(item: string): Evidence {
  const trimmed = item.trim();
  const task = /^#(\d+)\b/.exec(trimmed);
  if (task) return { kind: "task", number: Number(task[1]), text: trimmed };
  if (/^https?:\/\/\S+$/i.test(trimmed)) return { kind: "url", url: trimmed };
  return { kind: "text", text: trimmed };
}
