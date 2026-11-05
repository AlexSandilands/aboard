import type { IssueRef, PrRef } from "@repo/contracts";
import { AppError } from "../errors.ts";

// What headless runs read from a git host, behind one interface so another host can plug in without touching prompts,
// drivers or the run tools (docs/decisions/0013-board-served-run-tools.md). GitHub is the first implementation
// (githubHost.ts). Only reads live here: the board posts what an agent returns, with its own GitHub code.

export interface HostPr {
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string | null;
  baseRef: string;
  headRef: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface HostPrFile {
  path: string;
  /** The path before a rename or copy. */
  previousPath: string | null;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  /** The file's unified diff hunks, or null when the host serves none (a binary file, or one too large). */
  patch: string | null;
}

/** A conversation comment, a review's own body, or an inline comment on the diff. */
export interface HostComment {
  id: number;
  kind: "conversation" | "review" | "inline";
  author: string | null;
  body: string;
  createdAt: string;
  url: string | null;
  /** A review's state (COMMENTED, APPROVED, CHANGES_REQUESTED, …). */
  state?: string | null;
  /** An inline comment's place in the diff. */
  path?: string | null;
  line?: number | null;
  inReplyTo?: number | null;
  /** The review an inline comment belongs to. */
  reviewId?: number | null;
}

export interface HostIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  author: string | null;
}

/** One page of text: its number from 1, how many there are, and the text itself. */
export interface TextPage {
  page: number;
  pages: number;
  text: string;
}

export interface DiffPage extends TextPage {
  /** The file the pages walk, or null for the whole pull request. */
  path: string | null;
}

/** Reads from a git host. Every method throws on failure with a message safe to show an agent (never a credential). */
export interface GitHost {
  getPr(ref: PrRef): Promise<HostPr>;
  /** Every changed file of the PR, with its patch. */
  listFiles(ref: PrRef): Promise<HostPrFile[]>;
  /** One page of the PR's diff: of one file when `path` is given, else of every file in order. Pages count from 1. */
  getDiff(ref: PrRef, path: string | null, page: number): Promise<DiffPage>;
  /** The PR's conversation comments, review bodies and inline comments, oldest first. */
  getComments(ref: PrRef): Promise<HostComment[]>;
  getIssue(ref: IssueRef): Promise<HostIssue>;
}

// ── Paging ───────────────────────────────────────────────────────────────

/**
 * How much text one page holds: whichever limit is hit first. Small enough that every CLI shows a tool result whole
 * (Codex cuts long tool output short), so a large diff takes more pages, never a cut-off one.
 */
export interface PageLimits {
  lines: number;
  chars: number;
}

export const PAGE_LIMITS: PageLimits = { lines: 400, chars: 20_000 };

/** A line longer than a whole page (minified code, a lockfile) is cut here, with a marker saying so. */
const cutLine = (line: string, chars: number): string => {
  const max = Math.max(200, Math.floor(chars / 2));
  return line.length > max ? `${line.slice(0, max)} … [line cut at ${max} of ${line.length} characters]` : line;
};

/**
 * Packs blocks of lines into pages. A block that doesn't fit what is left of a page starts a new one; a block longer
 * than a page is split across pages, each continuation opening with the block's `continued` line so a page read alone
 * still says what it shows.
 */
export function packPages(
  blocks: ReadonlyArray<{ lines: readonly string[]; continued?: string }>,
  limits: PageLimits = PAGE_LIMITS,
): string[] {
  const pages: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  const close = () => {
    if (current.length > 0) pages.push(current);
    current = [];
    chars = 0;
  };
  const fits = (line: string) => current.length < limits.lines && chars + line.length + 1 <= limits.chars;
  for (const block of blocks) {
    const lines = block.lines.map((l) => cutLine(l, limits.chars));
    const size = lines.reduce((n, l) => n + l.length + 1, 0);
    // A block that would fit a page of its own isn't split across two.
    if (current.length > 0 && (current.length + lines.length > limits.lines || chars + size > limits.chars)) {
      if (lines.length <= limits.lines && size <= limits.chars) close();
    }
    lines.forEach((line, i) => {
      if (!fits(line)) {
        close();
        if (i > 0 && block.continued) {
          const head = cutLine(block.continued, limits.chars);
          current.push(head);
          chars += head.length + 1;
        }
      }
      current.push(line);
      chars += line.length + 1;
    });
  }
  close();
  return pages.map((p) => p.join("\n"));
}

/** Picks one page, refusing one out of range with how many there are. */
export function pickPage(pages: readonly string[], page: number, what: string): TextPage {
  const count = Math.max(1, pages.length);
  if (!Number.isInteger(page) || page < 1 || page > count) {
    throw new AppError("VALIDATION", `${what} has ${count} page${count === 1 ? "" : "s"}; page ${page} doesn't exist`);
  }
  return { page, pages: count, text: pages[page - 1] ?? "" };
}

const fileHeader = (f: HostPrFile) =>
  `diff --git a/${f.previousPath ?? f.path} b/${f.path} (${f.status}, +${f.additions} -${f.deletions})`;

/** The lines one file contributes to the diff: its header, then its patch, or why there is none. */
function fileBlock(f: HostPrFile): { lines: string[]; continued: string } {
  const header = fileHeader(f);
  const body =
    f.patch === null
      ? ["(No diff served for this file: it is binary or too large. Read it in your checkout if you need it.)"]
      : f.patch.split(/\r?\n/);
  return { lines: [header, ...body, ""], continued: `${header} (continued)` };
}

/** The pages of a PR's diff, or of one of its files. Throws when `path` isn't a changed file. */
export function diffPages(
  files: readonly HostPrFile[],
  path: string | null,
  limits: PageLimits = PAGE_LIMITS,
): string[] {
  if (path === null) return packPages(files.map(fileBlock), limits);
  const file = files.find((f) => f.path === path) ?? files.find((f) => f.previousPath === path);
  if (!file) throw new AppError("NOT_FOUND", `${path} isn't changed in this pull request`);
  return packPages([fileBlock(file)], limits);
}

/** One page of a PR's diff, as GitHost.getDiff returns it. */
export function pageDiff(
  files: readonly HostPrFile[],
  path: string | null,
  page: number,
  limits: PageLimits = PAGE_LIMITS,
): DiffPage {
  const picked = pickPage(diffPages(files, path, limits), page, path === null ? "The diff" : `The diff of ${path}`);
  return { ...picked, path };
}
