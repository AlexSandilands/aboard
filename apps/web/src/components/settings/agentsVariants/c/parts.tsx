import type { ReactNode } from "react";
import { InfoHover } from "../../settingsLayout";

/**
 * Every model picker on the page as a settings field (the bordered look of a Select), not the composer's ghost button,
 * at one width so the pickers of a card line up in a column.
 */
export const PICKER_FIELD =
  "h-7 w-full max-w-none justify-between rounded-lg border-input bg-background px-2.5 text-sm font-normal text-foreground shadow-xs/5 hover:bg-accent/50 data-popup-open:bg-accent/50 dark:bg-input/32 dark:hover:bg-input/64 dark:data-popup-open:bg-input/64";

/** A one-line field that reads as text until hovered or focused: a card's name or description. */
export const INLINE_FIELD =
  "min-w-0 rounded-md transition-colors hover:bg-accent/50 has-focus-visible:bg-background has-focus-visible:ring-2 has-focus-visible:ring-ring/40 dark:has-focus-visible:bg-input/32";

/** The muted heading above a card or a run of cards, as SettingsSectionHeader, with the section's detail behind ⓘ. */
export function SectionHeading({ title, info, action }: { title: string; info?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-4 px-3 sm:px-4">
      <h2 className="flex min-h-7 items-center gap-1.5 text-sm font-normal text-foreground/70">
        {title}
        {info ? <InfoHover label={`More about ${title}`}>{info}</InfoHover> : null}
      </h2>
      <div className="flex min-h-7 min-w-7 items-center justify-end">{action}</div>
    </div>
  );
}
