import { type ComponentProps, isValidElement, type ReactElement, type ReactNode, useEffect, useState } from "react";
import type { ExtraProps } from "react-markdown";
import { codeLanguageOf, segmentCode, type CodeLanguage, type CodeRange } from "./codeBlock.logic";

/** Highlights already worked out, so a block shown again (the panel reopened, the window docked) paints at once. */
const cache = new Map<string, CodeRange[]>();
const CACHE_LIMIT = 200;
const cacheKey = (language: CodeLanguage, code: string) => `${language}\n${code}`;

/** The highlighted ranges of a block, once the highlighter has loaded; null until then and for no language. */
function useHighlight(code: string, language: CodeLanguage | null): CodeRange[] | null {
  const key = language ? cacheKey(language, code) : null;
  const [result, setResult] = useState<{ key: string; ranges: CodeRange[] } | null>(null);
  useEffect(() => {
    if (!language || !key || cache.has(key)) return;
    let live = true;
    const run = async () => {
      const { highlightCode } = await import("./codeHighlight");
      const ranges = await highlightCode(code, language);
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      cache.set(key, ranges);
      if (live) setResult({ key, ranges });
    };
    // A highlighter that fails to load leaves the block plain.
    run().catch(() => {});
    return () => {
      live = false;
    };
  }, [code, language, key]);
  if (!key) return null;
  return cache.get(key) ?? (result?.key === key ? result.ranges : null);
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

/**
 * A fenced code block, syntax-highlighted when its fence names a language we know (`codeBlock.logic.ts`). It shows as
 * a plain block until the highlighter has loaded, and stays one for any other language.
 */
export function CodeBlock({ node: _node, children, ...props }: ComponentProps<"pre"> & ExtraProps) {
  const code = isValidElement(children) ? (children as ReactElement<ComponentProps<"code">>) : null;
  const className = code?.props.className;
  const text = textOf(code?.props.children).replace(/\n$/, "");
  const language = codeLanguageOf(className);
  const ranges = useHighlight(text, language);
  if (!code || !ranges) return <pre {...props}>{children}</pre>;
  return (
    <pre {...props}>
      <code className={className}>
        {segmentCode(text, ranges).map((segment, i) =>
          segment.className ? (
            // oxlint-disable-next-line react/no-array-index-key -- segments have no identity beyond their place
            <span key={i} className={segment.className}>
              {segment.text}
            </span>
          ) : (
            segment.text
          ),
        )}
      </code>
    </pre>
  );
}
