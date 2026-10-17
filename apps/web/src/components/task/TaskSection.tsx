// Adapted from T3 Code (apps/web/src/components/chat/ThreadDetailsSection.tsx), MIT — see NOTICE.
import { ChevronRightIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useSectionFrame } from "./ManagedSections";

/**
 * A titled detail-panel section, separated from the one above by a hairline. Inside ManagedSections
 * the title toggles it open and closed; collapsed, the header shows a one-line summary in place of
 * the content and the actions. `summary` is the rich version of that line (pills, chips, buttons):
 * it sits beside the toggle rather than inside it, so its controls work on their own, and the plain
 * string stays on the toggle for screen readers and as the fallback when `summary` is empty.
 */
export function TaskSection({
  title,
  actions,
  summary,
  separated = true,
  children,
}: {
  title: string;
  actions?: ReactNode;
  summary?: ReactNode;
  separated?: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  const frame = useSectionFrame();
  const expanded = frame?.expanded ?? true;
  const rich = !expanded && frame && summary ? summary : null;
  return (
    <section
      aria-labelledby={headingId}
      className={cn("group/section px-2 pt-2", expanded ? "pb-2.5" : "pb-2", separated && "border-t border-border/65")}
    >
      {frame?.dragHandle}
      <div className={cn("flex min-h-8 min-w-0 items-center justify-between gap-2 px-1.5", expanded && "mb-1")}>
        {frame ? (
          <>
            <h3 className={cn("flex", rich ? "shrink-0" : "min-w-0 flex-1")}>
              <button
                type="button"
                id={headingId}
                aria-expanded={expanded}
                onClick={frame.onToggle}
                className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md text-left text-2xs font-medium text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    "size-3 shrink-0 text-muted-foreground/70 transition-transform",
                    expanded && "rotate-90",
                  )}
                />
                <span className="shrink-0">{title}</span>
                {frame.summary ? (
                  <span className={cn("min-w-0 truncate font-normal text-muted-foreground/80", rich && "sr-only")}>
                    {frame.summary}
                  </span>
                ) : null}
              </button>
            </h3>
            {rich ? (
              <>
                {/* Clicks on the parts that aren't controls toggle too; controls stop theirs (linkHandlers). The padding keeps focus rings inside the clip. */}
                {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a pointer shortcut; the toggle button is the keyboard route */}
                <div
                  className="-mx-0.5 -my-1 flex min-w-0 cursor-pointer items-center gap-1 overflow-hidden px-0.5 py-1"
                  onClick={frame.onToggle}
                >
                  {rich}
                </div>
                {/* The rest of the header still toggles, as it did when the summary was inside the button. */}
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  onClick={frame.onToggle}
                  className="h-7 min-w-1 flex-1 cursor-pointer outline-none"
                />
              </>
            ) : null}
          </>
        ) : (
          <h3 id={headingId} className="min-w-0 truncate text-2xs font-medium text-muted-foreground select-none">
            {title}
          </h3>
        )}
        {actions && expanded ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {expanded ? children : null}
    </section>
  );
}
