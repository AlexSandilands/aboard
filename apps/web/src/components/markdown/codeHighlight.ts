import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { StreamLanguage, type Language, type StreamParser } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import type { CodeLanguage, CodeRange } from "./codeBlock.logic";

// The highlighter behind CodeBlock. A separate module so the parsers stay out of the main bundle: it loads the first
// time a fenced block with a known language is shown. Token colours are `.tok-*` in index.css, from theme tokens.

const stream = (load: () => Promise<StreamParser<unknown>>) => async (): Promise<Language> =>
  StreamLanguage.define(await load());

const LANGUAGES: Record<CodeLanguage, () => Promise<Language>> = {
  javascript: async () => javascript().language,
  jsx: async () => javascript({ jsx: true }).language,
  typescript: async () => javascript({ typescript: true }).language,
  tsx: async () => javascript({ typescript: true, jsx: true }).language,
  json: async () => javascript().language,
  python: async () => python().language,
  shell: stream(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell),
  powershell: stream(async () => (await import("@codemirror/legacy-modes/mode/powershell")).powerShell),
  yaml: stream(async () => (await import("@codemirror/legacy-modes/mode/yaml")).yaml),
  toml: stream(async () => (await import("@codemirror/legacy-modes/mode/toml")).toml),
  sql: stream(async () => (await import("@codemirror/legacy-modes/mode/sql")).standardSQL),
  css: stream(async () => (await import("@codemirror/legacy-modes/mode/css")).css),
  go: stream(async () => (await import("@codemirror/legacy-modes/mode/go")).go),
  rust: stream(async () => (await import("@codemirror/legacy-modes/mode/rust")).rust),
  diff: stream(async () => (await import("@codemirror/legacy-modes/mode/diff")).diff),
  c: stream(async () => (await import("@codemirror/legacy-modes/mode/clike")).c),
  cpp: stream(async () => (await import("@codemirror/legacy-modes/mode/clike")).cpp),
  java: stream(async () => (await import("@codemirror/legacy-modes/mode/clike")).java),
  csharp: stream(async () => (await import("@codemirror/legacy-modes/mode/clike")).csharp),
  kotlin: stream(async () => (await import("@codemirror/legacy-modes/mode/clike")).kotlin),
  dockerfile: stream(async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile),
};

const loaded = new Map<CodeLanguage, Promise<Language>>();

const highlighter = tagHighlighter([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword], class: "tok-keyword" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.inserted], class: "tok-string" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: "tok-number" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.meta], class: "tok-comment" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName)],
    class: "tok-function",
  },
  { tag: [tags.className, tags.typeName, tags.standard(tags.variableName), tags.heading], class: "tok-type" },
  { tag: [tags.propertyName, tags.attributeName], class: "tok-property" },
  { tag: [tags.invalid, tags.deleted], class: "tok-invalid" },
]);

/** The highlighted ranges of `code` in `language`, in order. */
export async function highlightCode(code: string, language: CodeLanguage): Promise<CodeRange[]> {
  let parser = loaded.get(language);
  if (!parser) {
    parser = LANGUAGES[language]();
    loaded.set(language, parser);
  }
  const tree = (await parser).parser.parse(code);
  const ranges: CodeRange[] = [];
  highlightTree(tree, highlighter, (from, to, className) => ranges.push({ from, to, className }));
  return ranges;
}
