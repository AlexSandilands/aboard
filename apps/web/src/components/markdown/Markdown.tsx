import { type ComponentProps, createContext, memo, useContext, useMemo } from "react";
import { attachmentIdOf } from "@repo/contracts";
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";

import { AttachmentPill } from "~/components/attachments/AttachmentPill";
import { InlineAttachment } from "~/components/attachments/InlineAttachment";
import { cn } from "~/lib/utils";
import { CodeBlock } from "./CodeBlock";
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

// Whether pasted images show in place (the document size) or as pills with thumbnails below the text.
const InlineImagesContext = createContext(false);

/**
 * A pasted image (`![name](attachment:id)`): a pill in the text, its thumbnail shown below the text (AttachmentThumbs).
 * At the document size it shows in place at the column's width instead.
 */
function MarkdownImage({ node: _node, src, alt, ...props }: ComponentProps<"img"> & ExtraProps) {
  const inline = useContext(InlineImagesContext);
  const id = attachmentIdOf(typeof src === "string" ? src : undefined);
  if (!id) return <img src={src} alt={alt} {...props} />;
  return inline ? <InlineAttachment id={id} name={alt || "image"} /> : <AttachmentPill id={id} name={alt || "image"} />;
}

/** react-markdown drops URLs with a scheme it doesn't know, and `attachment:` is how a pasted image is written. */
const urlTransform = (url: string): string => (attachmentIdOf(url) ? url : defaultUrlTransform(url));

const components: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  pre: CodeBlock,
  table: ({ node: _node, ...props }) => (
    <div className="markdown-table-container">
      <table {...props} />
    </div>
  ),
};

/**
 * GitHub-flavoured markdown in the `.markdown` prose style. Links open in a new tab; fenced code blocks are
 * syntax-highlighted (CodeBlock).
 */
export const Markdown = memo(function Markdown({
  children,
  size = "sm",
  className,
  taskLinks,
  images = true,
}: {
  children: string;
  /**
   * "sm" for panel body text, "xs" for notes and quotes, "md" for a document in the task window: larger type at a
   * reading measure, a real heading scale, and pasted images in place at the column's width.
   */
  size?: "md" | "sm" | "xs";
  /** Layout only. */
  className?: string;
  taskLinks?: TaskLinks;
  /** False drops images: text an agent wrote from imported content must not make the browser fetch a URL. */
  images?: boolean;
}) {
  const plugins = useMemo<Plugins>(
    () => (taskLinks ? [remarkGfm, [remarkTaskRefs, taskLinks.isKnown]] : remarkPlugins),
    [taskLinks],
  );
  return (
    <div
      className={cn(
        "markdown min-w-0 wrap-anywhere text-foreground/85",
        size === "md"
          ? "markdown-md max-w-[72ch] text-[15px] leading-[1.65]"
          : size === "sm"
            ? "text-[13px] leading-relaxed"
            : "text-xs leading-relaxed",
        className,
      )}
    >
      <InlineImagesContext value={size === "md"}>
        <TaskLinksContext value={taskLinks ?? null}>
          <ReactMarkdown
            remarkPlugins={plugins}
            components={components}
            urlTransform={urlTransform}
            {...(images ? {} : { disallowedElements: ["img"], unwrapDisallowed: true })}
          >
            {children}
          </ReactMarkdown>
        </TaskLinksContext>
      </InlineImagesContext>
    </div>
  );
});
