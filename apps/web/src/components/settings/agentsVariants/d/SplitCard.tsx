// Design D's one layout: a card with a list down the left and the selected item's settings on the right (stacked on a
// narrow page). Providers and Models are both this card, so the page reads as one system however many providers or
// models there are: each is a row in a list, never a column.
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { SETTINGS_TEXT_WIDTH, SettingsGroup } from "../../settingsLayout";

/**
 * The look of a model picker as a settings control: the field border and width every other control in a row has, so
 * the pickers share the card's right edge with the inputs and selects around them.
 */
export const CONTROL_PICKER = cn(
  "w-full max-w-none justify-between rounded-lg border-input bg-background font-normal text-foreground shadow-xs/5 dark:bg-input/32",
  SETTINGS_TEXT_WIDTH,
);

export function SplitCard({ list, children }: { list: ReactNode; children: ReactNode }) {
  return (
    <div className="@container/split">
      <SettingsGroup className="overflow-hidden @min-[48rem]/split:grid @min-[48rem]/split:grid-cols-[16rem_minmax(0,1fr)] [&>*+*]:border-t-0">
        <div className="border-b border-border/60 bg-muted/10 @min-[48rem]/split:border-r @min-[48rem]/split:border-b-0">
          {list}
        </div>
        <div className="min-w-0">{children}</div>
      </SettingsGroup>
    </div>
  );
}

/** The list: groups of items with a rule between every row. */
export function SplitList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="listbox" aria-label={label} className="[&>*+*]:border-t [&>*+*]:border-border/50">
      {children}
    </div>
  );
}

/** A run of items, with an optional muted heading; a settings target of its own when it has an id. */
export function SplitListGroup({ id, label, children }: { id?: string; label?: string; children: ReactNode }) {
  return (
    <div id={id} className="scroll-mt-4 [&>*+*]:border-t [&>*+*]:border-border/50">
      {label ? (
        <div className="px-3 pt-3 pb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase sm:px-4">
          {label}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** One row of the list: a mark, a name with an optional badge, a line under it, and room for a control at the end. */
export function SplitListItem({
  id,
  icon,
  title,
  badge,
  subtitle,
  selected,
  onSelect,
  trailing,
}: {
  id?: string;
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  subtitle?: string | null;
  selected: boolean;
  onSelect: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div
      id={id}
      className={cn(
        "flex scroll-mt-4 items-center gap-2 pe-3 transition-colors sm:pe-4",
        selected ? "bg-accent/60" : "hover:bg-muted/25",
      )}
    >
      <button
        type="button"
        role="option"
        aria-selected={selected}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-3 ps-3 text-left outline-none focus-visible:bg-muted/25 sm:ps-4"
        onClick={onSelect}
      >
        {icon}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm text-foreground">
            <span className="truncate">{title}</span>
            {badge}
          </span>
          {subtitle ? <span className="block truncate text-xs text-muted-foreground">{subtitle}</span> : null}
        </span>
      </button>
      {trailing}
    </div>
  );
}

/** The list's last row: an action such as "Add provider". */
export function SplitListAction({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-muted/25 hover:text-foreground focus-visible:bg-muted/25 focus-visible:text-foreground disabled:cursor-default disabled:opacity-64 disabled:hover:bg-transparent disabled:hover:text-muted-foreground sm:px-4"
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

/** The detail pane's content: a header, then sections, spaced as the provider editor's are. */
export function DetailBody({ children }: { children: ReactNode }) {
  return <div className="space-y-5 py-4">{children}</div>;
}

/** The selected item's name, one line under it, and its actions, above its sections. */
export function DetailHeader({
  icon,
  title,
  subtitle,
  actions,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-3">
        {icon}
        <div className="min-w-0">
          <h2 className="text-base font-medium text-foreground">{title}</h2>
          {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
    </div>
  );
}

/** One titled part of the detail: a muted heading over a card of rows, inset like the list beside it. */
export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 px-3 sm:px-4">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      <SettingsGroup>{children}</SettingsGroup>
    </section>
  );
}
