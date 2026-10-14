import { defaultHandoffMode, taskHandoffPrompt, type HandoffMode, type TaskSummary } from "@repo/contracts";
import { ClipboardCopyIcon, LightbulbIcon, MessageSquarePlusIcon, TerminalIcon } from "lucide-react";
import type { SyntheticEvent } from "react";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { copyToClipboard } from "~/components/task/InlineInput";
import { cn } from "~/lib/utils";
import { useDialogs } from "~/state/ui";

type Variant = "card" | "panel";

const chipClassName =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1 text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-accent";

/** Controls inside a card must not open the panel or start a drag; portalled popups bubble through React too. */
const stop = (event: SyntheticEvent) => event.stopPropagation();
const cardHandlers = { onClick: stop, onPointerDown: stop, onKeyDown: stop };

export function copyHandoffPrompt(task: Pick<TaskSummary, "id" | "number" | "title">, mode: HandoffMode) {
  const prompt = taskHandoffPrompt({ task, boardUrl: window.location.origin, mode });
  copyToClipboard(prompt, mode === "plan" ? "planning prompt" : "prompt");
}

/** Copies a ready-to-paste prompt for any agent harness (Claude Code, Copilot, …). */
export function CopyPromptMenu({ task, variant }: { task: TaskSummary; variant: Variant }) {
  const suggested = defaultHandoffMode(task);
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                variant === "card" ? (
                  <button type="button" aria-label="Copy agent prompt" className={chipClassName} {...cardHandlers} />
                ) : (
                  <Button variant="ghost" size="icon-xs" aria-label="Copy agent prompt" />
                )
              }
            />
          }
        >
          <TerminalIcon aria-hidden className={cn(variant === "card" && "size-3.5")} />
        </TooltipTrigger>
        <TooltipPopup>Copy a prompt to hand this task to an agent</TooltipPopup>
      </Tooltip>
      <MenuPopup align={variant === "card" ? "start" : "end"} {...cardHandlers}>
        <MenuItem onClick={() => copyHandoffPrompt(task, "work")}>
          <ClipboardCopyIcon />
          Copy prompt
          {suggested === "work" ? <span className="ms-auto ps-3 text-xs text-muted-foreground">Suggested</span> : null}
        </MenuItem>
        <MenuItem onClick={() => copyHandoffPrompt(task, "plan")}>
          <LightbulbIcon />
          Copy planning prompt
          {suggested === "plan" ? <span className="ms-auto ps-3 text-xs text-muted-foreground">Suggested</span> : null}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Opens the "Start in T3 Code" dialog. Callers decide visibility with canStartT3Thread. */
export function StartT3Button({ taskId, variant }: { taskId: string; variant: Variant }) {
  const open = () => useDialogs.getState().openT3Launch(taskId);
  if (variant === "panel") {
    return (
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Start in T3 Code" onClick={open} />}>
          <MessageSquarePlusIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Start in T3 Code</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Start in T3 Code"
            className={chipClassName}
            {...cardHandlers}
            onClick={(event) => {
              event.stopPropagation();
              open();
            }}
          />
        }
      >
        <MessageSquarePlusIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup>Start in T3 Code</TooltipPopup>
    </Tooltip>
  );
}
