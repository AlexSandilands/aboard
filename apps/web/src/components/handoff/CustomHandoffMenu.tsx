import {
  customHandoffsFor,
  handoffTargetHarness,
  type AgentHarness,
  type CustomHandoff,
  type TaskSummary,
} from "@repo/contracts";
import { ChevronDownIcon, SettingsIcon, StarIcon, ZapIcon } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { HarnessIcon, T3Icon } from "~/components/sessions/SessionParts";
import { useOpenSettings } from "~/components/settings/settingsNavigation";
import { MenuItem, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger } from "~/components/ui/menu";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { useBoard, useSettingsSelect } from "~/state/queries";
import { runCustomHandoff } from "./customHandoffLaunch";

/** Where a flyout has no room, or no hover to open it: a phone-width window, or a touch screen. */
const INLINE_SUBMENU = "(max-width: 639px), (pointer: coarse)";

/** The settings target of the Custom hand-offs section. */
export const CUSTOM_HANDOFFS_TARGET = "agents.handoffs";

/** The mark of what a hand-off starts: T3 Code's, or its CLI's. */
export function HandoffTargetIcon({ target, className }: { target: CustomHandoff["target"]; className?: string }) {
  const harness = handoffTargetHarness(target);
  return harness ? (
    <HarnessIcon harness={harness} className={cn("size-4.5 sm:size-4", className)} />
  ) : (
    <T3Icon className={cn("size-4.5 sm:size-4", className)} />
  );
}

/**
 * The user's custom hand-offs in a task's hand-off menu: one "Custom hand-offs" entry that opens the list, so the menu
 * stays the same height however many there are. An entry marked "starts now" starts at once; one ending in "…" opens
 * its launch dialog filled in. The list opens in place where a flyout wouldn't fit or can't be hovered. Nothing is
 * rendered when no hand-off is shown on the task's project with a target that can start here.
 */
export function CustomHandoffItems({
  task,
  canStartT3,
  clis,
  popupProps,
}: {
  task: TaskSummary;
  canStartT3: boolean;
  clis: readonly AgentHarness[];
  /** Spread on the flyout, which is portalled like the menu: on a card it must not open the panel or start a drag. */
  popupProps?: Pick<ComponentProps<"div">, "onClick" | "onPointerDown" | "onKeyDown">;
}) {
  const settings = useSettingsSelect(selectHandoffSettings);
  const t3 = useBoard().data?.integrations.t3;
  const inline = useMediaQuery(INLINE_SUBMENU);
  const [open, setOpen] = useState(false);
  const openSettings = useOpenSettings();
  const handoffs = customHandoffsFor(task, settings?.customHandoffs, { t3: canStartT3, clis });
  if (handoffs.length === 0) return null;

  const items = (
    <>
      {handoffs.map((handoff) => (
        <MenuItem key={handoff.id} onClick={() => runCustomHandoff(task, handoff, { t3, settings })}>
          <HandoffTargetIcon target={handoff.target} />
          <span className="min-w-0 truncate">
            {handoff.name}
            {handoff.skipDialog ? "" : "…"}
          </span>
          {handoff.skipDialog ? (
            <span className="ms-auto flex shrink-0 items-center gap-1 ps-3 text-xs whitespace-nowrap text-primary">
              <ZapIcon aria-hidden className="size-3" />
              starts now
            </span>
          ) : null}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem onClick={() => openSettings(CUSTOM_HANDOFFS_TARGET)}>
        <SettingsIcon />
        Edit hand-offs…
      </MenuItem>
    </>
  );
  const count = <span className="ps-3 text-xs text-muted-foreground tabular-nums">{handoffs.length}</span>;

  if (inline) {
    return (
      <>
        <MenuItem closeOnClick={false} aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          <StarIcon />
          <span className="flex-1">Custom hand-offs</span>
          {count}
          <ChevronDownIcon aria-hidden className={cn("-me-0.5 transition-transform", open && "rotate-180")} />
        </MenuItem>
        {open ? (
          <div role="group" aria-label="Custom hand-offs" className="ms-3.5 border-s border-border/70 ps-1">
            {items}
          </div>
        ) : null}
      </>
    );
  }
  return (
    <MenuSub>
      <MenuSubTrigger>
        <StarIcon />
        <span className="flex-1">Custom hand-offs</span>
        {count}
      </MenuSubTrigger>
      <MenuSubPopup {...popupProps}>{items}</MenuSubPopup>
    </MenuSub>
  );
}

/** What the items read, so the menu doesn't re-render on every other setting. */
const selectHandoffSettings = ({
  customHandoffs,
  t3LinkTarget,
}: {
  customHandoffs: CustomHandoff[];
  t3LinkTarget: "desktop" | "browser";
}) => ({
  customHandoffs,
  t3LinkTarget,
});
