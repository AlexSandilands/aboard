import { CheckIcon, CopyIcon } from "lucide-react";
import { type ComponentProps, isValidElement, type ReactElement, type ReactNode, useEffect, useState } from "react";
import type { ExtraProps } from "react-markdown";
import { Button } from "~/components/ui/button";
import { useCopy } from "~/hooks/useCopy";
import { cn } from "~/lib/utils";
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
 * Copies a block's code. It sits over the block's top right corner, outside the `pre`, so it stays put while long
 * lines scroll under it; the backing keeps it readable over them. Shown on hover or keyboard focus, always on touch.
 */
function CopyCode({ text }: { text: string }) {
  const { copied, copy } = useCopy("code");
  return (
    <span
      className={cn(
        "absolute top-2 right-2 flex rounded-[var(--control-radius)] bg-popover opacity-0 group-hover/code:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100",
        copied && "opacity-100",
      )}
    >
      <Button
        size="icon-xs"
        variant="outline"
        aria-label={copied ? "Copied" : "Copy code"}
        title="Copy code"
        onClick={() => void copy(text)}
      >
        {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      </Button>
    </span>
  );
}

/**
 * A fenced code block with a copy button, syntax-highlighted when its fence names a language we know
 * (`codeBlock.logic.ts`). It shows as a plain block until the highlighter has loaded, and stays one for any other
 * language. The container carries the block's margin (`.markdown-code-container` in index.css).
 */
export function CodeBlock({ node: _node, children, ...props }: ComponentProps<"pre"> & ExtraProps) {
  const code = isValidElement(children) ? (children as ReactElement<ComponentProps<"code">>) : null;
  const className = code?.props.className;
  const text = textOf(code?.props.children).replace(/\n$/, "");
  const language = codeLanguageOf(className);
  const ranges = useHighlight(text, language);
  return (
    <div className="markdown-code-container group/code relative">
      <pre {...props}>
        {code && ranges ? (
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
        ) : (
          children
        )}
      </pre>
      {code ? <CopyCode text={text} /> : null}
    </div>
  );
}
