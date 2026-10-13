// Adapted from T3 Code (apps/web/src/components/chat/ThreadDetailsSection.tsx), MIT — see NOTICE.
import { useId, type ReactNode } from "react";

/** A titled detail-panel section, separated from the one above by a hairline. */
export function TaskSection({
  title,
  actions,
  separated = true,
  children,
}: {
  title: string;
  actions?: ReactNode;
  separated?: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={separated ? "border-t border-border/65 px-2 pt-2 pb-2.5" : "px-2 pt-2 pb-2.5"}
    >
      <div className="mb-1 flex min-h-8 min-w-0 items-center justify-between gap-2 px-1.5">
        <h3 id={headingId} className="min-w-0 truncate text-2xs font-medium text-muted-foreground select-none">
          {title}
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
