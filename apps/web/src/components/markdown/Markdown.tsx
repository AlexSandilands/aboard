import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "~/lib/utils";

const remarkPlugins = [remarkGfm];

const components: Components = {
  a: ({ node: _node, children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  table: ({ node: _node, ...props }) => (
    <div className="markdown-table-container">
      <table {...props} />
    </div>
  ),
};

/** GitHub-flavoured markdown in the `.markdown` prose style. Links open in a new tab. */
export const Markdown = memo(function Markdown({
  children,
  size = "sm",
  className,
}: {
  children: string;
  /** "sm" for panel body text, "xs" for notes and quotes. */
  size?: "sm" | "xs";
  /** Layout only. */
  className?: string;
}) {
  return (
    <div
      className={cn(
        "markdown min-w-0 wrap-anywhere text-foreground/85",
        size === "sm" ? "text-[13px] leading-relaxed" : "text-xs leading-relaxed",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
