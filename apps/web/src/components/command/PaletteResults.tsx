// Adapted from T3 Code (apps/web/src/components/CommandPaletteResults.tsx), MIT — see NOTICE.
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { CommandItem, CommandList, CommandListHeading, CommandShortcut } from "~/components/ui/command";

export const ITEM_ICON_CLASS = "size-4 text-icon-muted";

export interface PaletteItem {
  readonly value: string;
  readonly title: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly icon: ReactNode;
  readonly description?: ReactNode;
  /** Rendered inline before the title, e.g. a task number. */
  readonly leading?: ReactNode;
  /** Rendered after the title, e.g. a "Not detected" badge or a check mark. */
  readonly trailing?: ReactNode;
  /** Shows a chevron: the item opens another view. */
  readonly submenu?: boolean;
  /** The key bound to the same action, shown at the end of the row ("Ctrl+,"). */
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly run: () => void;
}

export interface PaletteGroup {
  readonly value: string;
  readonly label?: string;
  readonly items: ReadonlyArray<PaletteItem>;
}

/** Highlightable item values in render order; Base UI navigates these by index. */
export function enabledItemValues(groups: ReadonlyArray<PaletteGroup>): string[] {
  return groups.flatMap((group) => group.items.filter((item) => !item.disabled).map((item) => item.value));
}

export function PaletteEmptyState({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-muted-foreground">{children}</div>;
}

export function PaletteResults(props: { groups: ReadonlyArray<PaletteGroup>; emptyStateMessage?: ReactNode }) {
  if (props.groups.every((group) => group.items.length === 0)) {
    return props.emptyStateMessage === undefined ? null : (
      <PaletteEmptyState>{props.emptyStateMessage}</PaletteEmptyState>
    );
  }
  let index = 0;
  return (
    <CommandList>
      {props.groups.map((group, groupIndex) =>
        group.items.length === 0 ? null : (
          <div key={group.value} role="group" className={groupIndex > 0 ? "pt-1.5" : undefined}>
            {group.label ? <CommandListHeading>{group.label}</CommandListHeading> : null}
            {group.items.map((item) =>
              item.disabled ? (
                <DisabledRow item={item} key={item.value} />
              ) : (
                <ItemRow item={item} key={item.value} index={index++} />
              ),
            )}
          </div>
        ),
      )}
    </CommandList>
  );
}

function RowBody({ item }: { item: PaletteItem }) {
  return (
    <>
      {item.icon}
      {item.description ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            {item.leading}
            <span className="truncate">{item.title}</span>
          </span>
          <span className="min-w-0 truncate text-muted-foreground/70 text-xs">{item.description}</span>
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
          {item.leading}
          <span className="truncate">{item.title}</span>
        </span>
      )}
      {item.trailing}
    </>
  );
}

function DisabledRow({ item }: { item: PaletteItem }) {
  return (
    <div className="flex min-h-8 select-none items-center gap-2 rounded-sm px-2 py-1.5 text-base opacity-64 sm:min-h-7 sm:text-sm">
      <RowBody item={item} />
    </div>
  );
}

function ItemRow({ item, index }: { item: PaletteItem; index: number }) {
  return (
    <CommandItem
      index={index}
      value={item.value}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => item.run()}
    >
      <RowBody item={item} />
      {item.shortcut ? <CommandShortcut>{item.shortcut}</CommandShortcut> : null}
      {item.submenu ? <ChevronRightIcon className="-me-0.5 ms-auto size-4 shrink-0 text-muted-foreground/70" /> : null}
    </CommandItem>
  );
}
