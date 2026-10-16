import { type ComponentProps, createContext, memo, useContext, useMemo } from "react";
import ReactMarkdown, { type Components, type ExtraProps, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "~/lib/utils";
import { remarkTaskRefs, taskRefNumber } from "./taskRefs.logic";

type Plugins = NonNullable<Options["remarkPlugins"]>;

const remarkPlugins: Plugins = [remarkGfm];

/** Makes "#N" in the text a link to that task; keep the object stable, or the Markdown is rebuilt each render. */
export interface TaskLinks {
  /** Only numbers this accepts become links, so a "#5" that isn't a task stays text. */
  isKnown: (number: number) => boolean;
  onOpen: (number: number) => void;
}

// A context rather than a per-render `a` component, which would remount its links on every render.
const TaskLinksContext = createContext<TaskLinks | null>(null);

function MarkdownLink({ node: _node, children, href, ...props }: ComponentProps<"a"> & ExtraProps) {
  const taskLinks = useContext(TaskLinksContext);
  const number = taskLinks ? taskRefNumber(href) : null;
  if (taskLinks && number !== null) {
    return (
      <button
        type="button"
        className="cursor-pointer rounded-sm text-info-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => taskLinks.onOpen(number)}
      >
        {children}
      </button>
    );
  }
  return (
    <a href={href} {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

const components: Components = {
  a: MarkdownLink,
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
  taskLinks,
}: {
  children: string;
  /** "sm" for panel body text, "xs" for notes and quotes. */
  size?: "sm" | "xs";
  /** Layout only. */
  className?: string;
  taskLinks?: TaskLinks;
}) {
  const plugins = useMemo<Plugins>(
    () => (taskLinks ? [remarkGfm, [remarkTaskRefs, taskLinks.isKnown]] : remarkPlugins),
    [taskLinks],
  );
  return (
    <div
      className={cn(
        "markdown min-w-0 wrap-anywhere text-foreground/85",
        size === "sm" ? "text-[13px] leading-relaxed" : "text-xs leading-relaxed",
        className,
      )}
    >
      <TaskLinksContext value={taskLinks ?? null}>
        <ReactMarkdown remarkPlugins={plugins} components={components}>
          {children}
        </ReactMarkdown>
      </TaskLinksContext>
    </div>
  );
});
