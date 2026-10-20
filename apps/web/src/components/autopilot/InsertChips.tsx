import { ChevronDownIcon } from "lucide-react";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { applyInsert, type InsertChip } from "./insertChips.logic";
import { TONE } from "./sdkStyle";

/** Puts text where the cursor is, over any selection. */
export interface Inserter {
  insert: (text: string) => void;
}

/** Inserts into a text area at its cursor, then puts the cursor after what went in. */
export function insertIntoTextarea(el: HTMLTextAreaElement | null, text: string, onChange: (value: string) => void) {
  if (!el) return;
  const next = applyInsert(el.value, el.selectionStart, el.selectionEnd, text);
  onChange(next.value);
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(next.cursor, next.cursor);
  });
}

const CHIP =
  "inline-flex h-5 items-center gap-0.5 rounded-md px-1.5 font-mono text-2xs ring-1 ring-inset outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring";

const chipClass = (chip: InsertChip) => cn(CHIP, TONE[chip.tone].text, TONE[chip.tone].surface, TONE[chip.tone].ring);

/**
 * The row of chips over an editor: each puts a value's read (or placeholder) at the cursor. A chip with one value says
 * what it inserts in a tooltip; one with several opens a menu of them.
 */
export function InsertChips({
  chips,
  onInsert,
  className,
}: {
  chips: readonly InsertChip[];
  onInsert: (text: string) => void;
  className?: string;
}) {
  return (
    <div role="toolbar" aria-label="Insert a value" className={cn("flex flex-wrap items-center gap-1", className)}>
      <span className="me-0.5 text-2xs text-muted-foreground">Insert</span>
      {chips.map((chip) => {
        const only = chip.options.length === 1 ? chip.options[0] : undefined;
        if (only) {
          return (
            <Tooltip key={chip.label}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Insert ${only.label}`}
                    className={chipClass(chip)}
                    onClick={() => onInsert(only.text)}
                  />
                }
              >
                {chip.label}
              </TooltipTrigger>
              <TooltipPopup>
                <span className="block font-mono">{only.text}</span>
                {only.also ? <span className="block font-mono text-muted-foreground">{only.also}</span> : null}
              </TooltipPopup>
            </Tooltip>
          );
        }
        return (
          <Menu key={chip.label}>
            <MenuTrigger
              render={<button type="button" aria-label={`Insert a ${chip.label} value`} className={chipClass(chip)} />}
            >
              {chip.label}
              <ChevronDownIcon aria-hidden className="size-3 opacity-70" />
            </MenuTrigger>
            {/* The editor takes the focus back, so the menu mustn't return it to the chip. */}
            <MenuPopup align="start" finalFocus={false}>
              {chip.options.length === 0 ? (
                <p className="max-w-64 px-2 py-1 text-xs text-muted-foreground">{chip.empty}</p>
              ) : (
                chip.options.map((option) => (
                  <MenuItem key={option.text} onClick={() => onInsert(option.text)}>
                    <span className="flex min-w-0 flex-col py-0.5">
                      <span className="text-xs">{option.label}</span>
                      <span className="truncate font-mono text-2xs text-muted-foreground">{option.text}</span>
                    </span>
                  </MenuItem>
                ))
              )}
            </MenuPopup>
          </Menu>
        );
      })}
    </div>
  );
}
