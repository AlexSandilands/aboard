import {
  AGENT_HARNESSES,
  BRAND,
  defaultHandoffMode,
  suggestEpicsPrompt,
  taskHandoffPrompt,
  taskReferenceLine,
  type HandoffMode,
  type ModelTiers,
  type Project,
  type TaskSummary,
} from "@repo/contracts";
import { ClipboardCopyIcon, LightbulbIcon, SparklesIcon, TerminalIcon } from "lucide-react";
import type { SyntheticEvent } from "react";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { HarnessIcon, T3Icon } from "~/components/sessions/SessionParts";
import { copyToClipboard } from "~/components/task/InlineInput";
import { cn } from "~/lib/utils";
import { useAgentClis, useSettings } from "~/state/queries";
import { useDialogs } from "~/state/ui";

type Variant = "card" | "panel";

const chipClassName =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1 text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-accent";

/** Controls inside a card must not open the panel or start a drag; portalled popups bubble through React too. */
const stop = (event: SyntheticEvent) => event.stopPropagation();
const cardHandlers = { onClick: stop, onPointerDown: stop, onKeyDown: stop };

/** `modelTiers` names the task's suggested model in a work prompt; without it the line shows the bare tier. */
export function copyHandoffPrompt(
  task: Pick<TaskSummary, "id" | "number" | "title" | "suggestedModel"> &
    Partial<Pick<TaskSummary, "kind" | "blocked" | "integrationBranch" | "delivery" | "parent">>,
  mode: HandoffMode,
  modelTiers: ModelTiers | undefined,
) {
  const prompt = taskHandoffPrompt({
    task,
    boardUrl: window.location.origin,
    mode,
    ...(modelTiers ? { modelTiers } : {}),
  });
  copyToClipboard(
    prompt,
    mode === "plan" ? "planning prompt" : mode === "orchestrate" ? "orchestrating prompt" : "prompt",
  );
}

/** Copies the project's "Suggest epics" prompt (see suggestEpicsPrompt). */
export function copySuggestEpicsPrompt(project: Pick<Project, "id" | "title">) {
  copyToClipboard(suggestEpicsPrompt({ project, boardUrl: window.location.origin }), "prompt");
}

/**
 * The lane header's "Suggest epics": hands the project's open tasks to an agent that proposes epics to group them,
 * in a new T3 Code thread (when `canStartT3`, see canStartProjectT3Thread) or as a prompt to paste.
 */
export function SuggestEpicsMenu({ project, canStartT3 }: { project: Project; canStartT3: boolean }) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<Button variant="ghost-muted" size="icon-xs" aria-label={`Suggest epics for ${project.title}`} />}
            />
          }
        >
          <SparklesIcon />
        </TooltipTrigger>
        <TooltipPopup>Suggest epics</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start">
        {canStartT3 ? (
          <MenuItem onClick={() => useDialogs.getState().openProjectT3Launch(project.id)}>
            <T3Icon className="size-4.5 sm:size-4" />
            Suggest epics in a new T3 Code thread…
          </MenuItem>
        ) : null}
        <MenuItem onClick={() => copySuggestEpicsPrompt(project)}>
          <ClipboardCopyIcon />
          Copy prompt to suggest epics
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Copies a short pointer to the task (see taskReferenceLine), for a new session on any task status. */
export function copyTaskReference(task: Pick<TaskSummary, "id" | "number" | "title">) {
  copyToClipboard(taskReferenceLine({ task, boardUrl: window.location.origin }), `${BRAND.id} link`);
}

/**
 * Hands a task to an agent: starts a T3 Code thread (when `canStartT3`, see canStartT3Thread), a Claude Code or
 * Copilot CLI session in a terminal (when the CLI is installed; not for epics, whose tasks get the sessions), or
 * copies a ready-to-paste prompt for any harness.
 */
export function HandoffMenu({
  task,
  variant,
  canStartT3,
}: {
  task: TaskSummary;
  variant: Variant;
  canStartT3: boolean;
}) {
  const suggested = defaultHandoffMode(task);
  const modelTiers = useSettings().data?.modelTiers;
  const clis = useAgentClis().data ?? [];
  const sessionClis = task.kind === "epic" ? [] : clis.filter((c) => c.available);
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                variant === "card" ? (
                  <button type="button" aria-label="Hand off to an agent" className={chipClassName} {...cardHandlers} />
                ) : (
                  <Button variant="ghost" size="icon" aria-label="Hand off to an agent" />
                )
              }
            />
          }
        >
          <TerminalIcon aria-hidden className={cn(variant === "card" && "size-3.5")} />
        </TooltipTrigger>
        <TooltipPopup>Hand off to an agent</TooltipPopup>
      </Tooltip>
      <MenuPopup align={variant === "card" ? "start" : "end"} {...cardHandlers}>
        {canStartT3 ? (
          <MenuItem onClick={() => useDialogs.getState().openT3Launch(task.id)}>
            <T3Icon className="size-4.5 sm:size-4" />
            New T3 Code thread…
          </MenuItem>
        ) : null}
        {sessionClis.map(({ harness }) => (
          <MenuItem key={harness} onClick={() => useDialogs.getState().openSessionLaunch(task.id, harness)}>
            <HarnessIcon harness={harness} />
            New {AGENT_HARNESSES[harness].label} session…
          </MenuItem>
        ))}
        {canStartT3 || sessionClis.length ? <MenuSeparator /> : null}
        {suggested === "orchestrate" ? (
          // An epic has one prompt: the one that starts its tasks.
          <MenuItem onClick={() => copyHandoffPrompt(task, "orchestrate", modelTiers)}>
            <ClipboardCopyIcon />
            Copy prompt to start its tasks
          </MenuItem>
        ) : (
          <>
            <MenuItem onClick={() => copyHandoffPrompt(task, "work", modelTiers)}>
              <ClipboardCopyIcon />
              Copy prompt
              {suggested === "work" ? (
                <span className="ms-auto ps-3 text-xs text-muted-foreground">Suggested</span>
              ) : null}
            </MenuItem>
            <MenuItem onClick={() => copyHandoffPrompt(task, "plan", modelTiers)}>
              <LightbulbIcon />
              Copy planning prompt
              {suggested === "plan" ? (
                <span className="ms-auto ps-3 text-xs text-muted-foreground">Suggested</span>
              ) : null}
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}
