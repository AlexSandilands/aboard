// Syntax highlighting for fenced code blocks in Markdown. The parsers are CodeMirror's (already used by the script
// editor) and load lazily (codeHighlight.ts); this file is the pure part: which language a block names, and how the
// highlighted ranges cut its text.

/** The languages fenced blocks are highlighted in, by the names a fence may give them. */
const ALIASES: Record<string, CodeLanguage> = {
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  typescript: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  json: "json",
  jsonc: "json",
  json5: "json",
  py: "python",
  python: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  shell: "shell",
  console: "shell",
  ps1: "powershell",
  powershell: "powershell",
  pwsh: "powershell",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  css: "css",
  scss: "css",
  go: "go",
  golang: "go",
  rs: "rust",
  rust: "rust",
  diff: "diff",
  patch: "diff",
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  java: "java",
  cs: "csharp",
  csharp: "csharp",
  kotlin: "kotlin",
  kt: "kotlin",
  dockerfile: "dockerfile",
  docker: "dockerfile",
};

export type CodeLanguage =
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "json"
  | "python"
  | "shell"
  | "powershell"
  | "yaml"
  | "toml"
  | "sql"
  | "css"
  | "go"
  | "rust"
  | "diff"
  | "c"
  | "cpp"
  | "java"
  | "csharp"
  | "kotlin"
  | "dockerfile";

/**
 * The language a fenced block's `language-…` class names, or null for none or one we don't highlight (it stays a
 * plain block).
 */
export function codeLanguageOf(className: string | undefined): CodeLanguage | null {
  const name = /(?:^|\s)language-(\S+)/.exec(className ?? "")?.[1]?.toLowerCase();
  return name ? (ALIASES[name] ?? null) : null;
}

/** A highlighted stretch of a block's text: `[from, to)` and its token class. */
export interface CodeRange {
  from: number;
  to: number;
  className: string;
}

export interface CodeSegment {
  text: string;
  className: string | null;
}

/**
 * The block's text cut into plain and highlighted segments, in order. Ranges are expected sorted and apart, as the
 * highlighter reports them; overlapping or out-of-bounds ones are clipped, so the text always comes back whole.
 */
export function segmentCode(code: string, ranges: ReadonlyArray<CodeRange>): CodeSegment[] {
  const segments: CodeSegment[] = [];
  let at = 0;
  for (const range of ranges) {
    const from = Math.max(range.from, at);
    const to = Math.min(range.to, code.length);
    if (to <= from) continue;
    if (from > at) segments.push({ text: code.slice(at, from), className: null });
    segments.push({ text: code.slice(from, to), className: range.className });
    at = to;
  }
  if (at < code.length) segments.push({ text: code.slice(at), className: null });
  return segments;
}
