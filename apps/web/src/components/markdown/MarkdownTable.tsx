import { type ComponentProps, useEffect, useRef, useState } from "react";
import type { ExtraProps } from "react-markdown";

import { type MoreSide, moreSide } from "./tableScroll.logic";

/**
 * A Markdown table in a box that scrolls sideways when the table can't fit even with its cells wrapped, so the panel
 * or window never does. `data-more` fades out the edges that have more to scroll to.
 */
export function MarkdownTable({ node: _node, ...props }: ComponentProps<"table"> & ExtraProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState<MoreSide | undefined>();
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const update = () => setMore(moreSide(box));
    update();
    box.addEventListener("scroll", update, { passive: true });
    // The box narrows with the panel and the table grows with its content (fonts, images loading).
    const observer = new ResizeObserver(update);
    observer.observe(box);
    if (box.firstElementChild) observer.observe(box.firstElementChild);
    return () => {
      box.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);
  return (
    <div ref={ref} className="markdown-table-container" data-more={more}>
      <table {...props} />
    </div>
  );
}
