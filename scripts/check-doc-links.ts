/**
 * Fails when docs point at files that don't exist: relative links in Markdown files, and `docs/….md`
 * paths mentioned anywhere in the repo (source comments, skills, AGENTS.md). Run with `pnpm docs:check`.
 * External URLs and heading anchors aren't checked.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Templates hold placeholder links such as `NNNN-title.md`.
const skipped = (file: string) => file.startsWith("docs/templates/");
const textFile = /\.(md|ts|tsx|js|mjs|css|html|json|ya?ml|sql)$/;
// A `docs/` path that isn't the tail of a URL or of a longer path.
const docsPath = /(?<![\w./-])docs\/[\w./-]+\.md\b/g;
const mdLink = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const refLink = /^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .filter((file) => textFile.test(file) && !skipped(file) && existsSync(join(root, file)));

/** Blanks out fenced blocks and code spans, keeping line breaks so line numbers still match. */
function withoutCode(markdown: string): string {
  return (
    markdown
      // A fence may be indented (inside a list item); it closes on a fence of the same kind at least as long,
      // or at the end of the file.
      .replace(/^ *(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ *\1[`~]*[ \t]*$|(?![\s\S]))/gm, (block) =>
        block.replace(/[^\n]/g, " "),
      )
      .replace(/(`+)[^`\n]*?\1/g, (span) => " ".repeat(span.length))
  );
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

const broken: string[] = [];

for (const file of files) {
  const text = readFileSync(join(root, file), "utf8");

  for (const match of text.matchAll(docsPath)) {
    if (!existsSync(join(root, match[0]))) broken.push(`${file}:${lineOf(text, match.index)}  ${match[0]}`);
  }

  if (!file.endsWith(".md")) continue;
  const prose = withoutCode(text);
  for (const match of [...prose.matchAll(mdLink), ...prose.matchAll(refLink)]) {
    const target = match[1]!;
    // Skip URLs with a scheme (https:, mailto:, t3code:) and same-page anchors.
    if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith("#")) continue;
    let path: string;
    try {
      path = decodeURIComponent(target.replace(/[?#].*$/, ""));
    } catch {
      broken.push(`${file}:${lineOf(prose, match.index)}  ${target} (bad %-escape)`);
      continue;
    }
    const resolved = path.startsWith("/") ? join(root, path) : join(root, dirname(file), path);
    if (!existsSync(resolved)) {
      broken.push(`${file}:${lineOf(prose, match.index)}  ${posix.normalize(target)}`);
    }
  }
}

if (broken.length > 0) {
  console.error(`Broken doc links (${broken.length}):\n${broken.map((line) => `  ${line}`).join("\n")}`);
  process.exit(1);
}
console.log(`Doc links OK (${files.length} files checked).`);
