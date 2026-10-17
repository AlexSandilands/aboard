import type { AskSettingsResult } from "@repo/contracts";
import { SparklesIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { settingsLocation, type SettingsIndexEntry } from "./settingsIndex.logic";

/** The Ask's state, from the mutation: nothing asked yet, waiting for the model, or its reply. */
export type AskState = { kind: "idle" } | { kind: "pending" } | { kind: "done"; result: AskSettingsResult };

/**
 * The first option of the search results: asks the question in the box (answered by Claude Code on a small model).
 * It holds the whole exchange: the question, a thinking state, then the answer with a Go there button, or why there
 * is none. It is disabled, with the reason and a way to the CLI setting, when Claude Code can't be run.
 */
export function SettingsAskRow({
  id,
  question,
  active,
  unavailable,
  state,
  target,
  onActivate,
  onHover,
  onSetUp,
}: {
  id: string;
  question: string;
  active: boolean;
  /** Why the Ask can't run, or null when it can. */
  unavailable: string | null;
  state: AskState;
  /** The setting the answer points at, when it names one. */
  target: SettingsIndexEntry | null;
  /** Click or Enter: asks, tries again after a failure, or goes to the setting. */
  onActivate: () => void;
  onHover: () => void;
  /** Opens the Claude Code CLI setting. */
  onSetUp: () => void;
}) {
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the focused combobox input takes the keys
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      aria-disabled={unavailable !== null || state.kind === "pending"}
      className={cn(
        "rounded-md px-2 py-1.5",
        unavailable === null && state.kind !== "pending" && "cursor-pointer",
        active ? "bg-sidebar-row-active text-sidebar-foreground" : "hover:bg-sidebar-row-hover",
      )}
      onMouseMove={onHover}
      // The input keeps focus, so a click must not blur it before the pick lands.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onActivate}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium text-sidebar-foreground">
        {state.kind === "pending" ? (
          <Spinner aria-hidden size="sm" />
        ) : (
          <SparklesIcon aria-hidden className="size-3.5 shrink-0 text-(--sidebar-icon-color)" />
        )}
        <span className="min-w-0 truncate">{state.kind === "pending" ? "Thinking…" : `Ask: ${question}`}</span>
      </div>
      {unavailable !== null ? (
        <div className="mt-1 space-y-1.5 text-xs text-sidebar-muted-foreground">
          <p>{unavailable}</p>
          <Button
            type="button"
            size="compact"
            variant="outline"
            onClick={(event) => {
              event.stopPropagation();
              onSetUp();
            }}
          >
            Set up Claude Code
          </Button>
        </div>
      ) : state.kind === "idle" ? (
        <div className="text-xs text-sidebar-muted-foreground">Answered by Claude Code</div>
      ) : state.kind === "pending" ? (
        <div role="status" className="text-xs text-sidebar-muted-foreground">
          Asking Claude Code…
        </div>
      ) : state.result.ok ? (
        <div className="mt-1 space-y-1.5 text-xs">
          <p role="status" className="whitespace-normal text-sidebar-foreground">
            {state.result.answer}
          </p>
          {target ? (
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sidebar-muted-foreground">
                {target.title} · {settingsLocation(target)}
              </span>
              <Button
                type="button"
                size="compact"
                className="shrink-0"
                onClick={(event) => {
                  event.stopPropagation();
                  onActivate();
                }}
              >
                Go there
              </Button>
            </div>
          ) : (
            <p className="text-sidebar-muted-foreground">No single setting matches.</p>
          )}
        </div>
      ) : (
        <div role="alert" className="mt-1 text-xs whitespace-normal text-destructive-foreground">
          {state.result.error} <span className="text-sidebar-muted-foreground">Click to try again.</span>
        </div>
      )}
    </div>
  );
}
