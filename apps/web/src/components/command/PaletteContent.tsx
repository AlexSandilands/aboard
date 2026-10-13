// Adapted from T3 Code (apps/web/src/components/CommandPaletteContent.tsx), MIT — see NOTICE.
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useLayoutEffect, useRef } from "react";
import { Command, CommandFooter, CommandInput, CommandPanel } from "~/components/ui/command";
import { Kbd, KbdGroup } from "~/components/ui/kbd";

type PaletteContentProps = Omit<ComponentProps<typeof Command>, "children"> & {
  readonly children: ReactNode;
  readonly footerActionLabel?: ReactNode;
  readonly footerTrailing?: ReactNode;
  readonly inputAccessory?: ReactNode;
  readonly inputProps: ComponentProps<typeof CommandInput>;
  readonly showBackHint?: boolean;
};

/**
 * Shared palette chrome: one input, the results panel and the keyboard-hint footer.
 * Views supply their results, an optional input accessory and the Enter label.
 */
export function PaletteContent({
  children,
  footerActionLabel,
  footerTrailing,
  inputAccessory,
  inputProps,
  showBackHint,
  ...commandProps
}: PaletteContentProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Views remount this component; reclaim focus when the new input mounts.
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <Command {...commandProps}>
      <div className="relative">
        <CommandInput {...inputProps} ref={inputRef} />
        {inputAccessory}
      </div>
      <CommandPanel className="max-h-[min(28rem,70vh)]">{children}</CommandPanel>
      <CommandFooter className="max-sm:flex-col max-sm:items-start">
        <div className="flex items-center gap-3">
          <KbdGroup>
            <Kbd>
              <ArrowUpIcon />
            </Kbd>
            <Kbd>
              <ArrowDownIcon />
            </Kbd>
            <span>Navigate</span>
          </KbdGroup>
          {footerActionLabel !== undefined ? (
            <KbdGroup>
              <Kbd>Enter</Kbd>
              <span>{footerActionLabel}</span>
            </KbdGroup>
          ) : null}
          {showBackHint ? (
            <KbdGroup>
              <Kbd>Backspace</Kbd>
              <span>Back</span>
            </KbdGroup>
          ) : null}
          <KbdGroup>
            <Kbd>Esc</Kbd>
            <span>Close</span>
          </KbdGroup>
        </div>
        {footerTrailing}
      </CommandFooter>
    </Command>
  );
}
