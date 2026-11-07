import { overrideValue, type ModelChoice, type TaskDetail } from "@repo/contracts";
import { useId, type ReactNode } from "react";

import { TriangleAlertIcon } from "lucide-react";
import { inheritDetail, resolvesTo } from "~/components/models/choicePicker.logic";
import { ModelChoicePicker } from "~/components/models/ModelChoicePicker";
import { Switch } from "~/components/ui/switch";
import { useUpdateTask } from "~/state/mutations";
import { useBoard, useSettings } from "~/state/queries";
import { cn } from "~/lib/utils";
import { automationUpdate, MAY_FLAGS, mayState, type AutomationChange } from "./automation.logic";

/**
 * What Autopilot may do with this task, and the task's other automation settings, as the first part of its Autopilot
 * section: the chips (start it / review it / merge it), the reviewer when it is reviewed, whether it jumps the queue and
 * whether it is for a person. Only tasks have these, so an epic's panel leaves them out. A task for a person shows only
 * Priority and For a person: Autopilot, review and merge don't apply to it.
 */
export function AutopilotFlags({ task }: { task: TaskDetail }) {
  const { mutate: updateTask } = useUpdateTask();
  const settings = useSettings().data;
  const globalReview = settings?.autoReview ?? false;
  const change = (next: AutomationChange) => updateTask({ id: task.id, ...automationUpdate(next, globalReview) });
  const may = mayState(task, globalReview);
  return (
    <div className="flex flex-col gap-1 px-1.5 pb-1">
      {!task.manual && (
        <>
          <Row label="Autopilot may" hint="What Autopilot and agents may do with this task without a person">
            <div role="group" aria-label="Autopilot may" className="flex flex-wrap gap-1.5">
              {MAY_FLAGS.map(({ flag, label, hint }) => (
                <button
                  key={flag}
                  type="button"
                  aria-pressed={may[flag]}
                  title={hint}
                  className={cn(
                    "cursor-pointer rounded-full border px-2.5 py-0.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    may[flag]
                      ? "border-info/40 bg-info/12 text-info-foreground"
                      : "border-border/60 text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                  )}
                  onClick={() => change({ setting: "may", flag, on: !may[flag] })}
                >
                  {label}
                </button>
              ))}
            </div>
          </Row>
          {may.review ? (
            <Row
              label="Reviewer"
              hint="The model that reviews this task: a tier, a custom model or a provider's model. Inherit follows the project, then the board"
            >
              <ReviewModelPicker task={task} onChange={(model) => change({ setting: "reviewModel", model })} />
            </Row>
          ) : null}
        </>
      )}
      <Row label="Priority" hint="Show the task in the priority lane above every project; Autopilot starts it first">
        <Switch
          size="sm"
          checked={task.priority}
          aria-label="Priority"
          // The actions menu doesn't offer priority on an archived task either.
          disabled={task.archivedAt !== null}
          onCheckedChange={(on) => change({ setting: "priority", on })}
        />
      </Row>
      <Row label="For a person" hint="A to-do for a person: it needs no plan, and agents and Autopilot leave it alone">
        <Switch
          size="sm"
          checked={task.manual}
          aria-label="For a person"
          onCheckedChange={(on) => change({ setting: "manual", on })}
        />
      </Row>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  const hintId = useId();
  return (
    // The hint is also the mouse tooltip; describing the group makes it reach keyboard and screen-reader users.
    <div
      role="group"
      aria-label={label}
      aria-describedby={hintId}
      className="flex min-h-6 items-center gap-2"
      title={hint}
    >
      <h4 className="w-24 shrink-0 text-2xs text-muted-foreground/80 select-none">{label}</h4>
      {children}
      <span id={hintId} className="sr-only">
        {hint}
      </span>
    </div>
  );
}

/**
 * The task's reviewer model, for the reviewer subagent and the board reviewer. Inherit follows the project's, then the
 * board's, and says what that comes down to for this task.
 */
function ReviewModelPicker({ task, onChange }: { task: TaskDetail; onChange: (next: ModelChoice | null) => void }) {
  const settings = useSettings().data;
  const project = useBoard().data?.projects.find((p) => p.id === task.projectId);
  if (!settings) return null;
  const ctx = { task, projectOverride: project?.reviewModel ?? null, taskOverride: task.reviewModel };
  // The override drives the board reviewer too, which needs more of its provider than the subagent does.
  const board = resolvesTo("boardReviewer", ctx, settings);
  return (
    <>
      <ModelChoicePicker
        op="reviewer"
        value={task.reviewModel}
        inherit={{ label: "Inherit", detail: inheritDetail("reviewer", { ...ctx, taskOverride: null }, settings) }}
        ariaLabel="Reviewer model for this task"
        size="xs"
        className="min-w-28"
        onChange={(next) => onChange(overrideValue(next))}
      />
      {board.ok ? null : (
        <span title={`Board reviewer: ${board.text}`} className="flex text-warning">
          <TriangleAlertIcon aria-hidden className="size-3.5" />
          <span className="sr-only">Board reviewer: {board.text}</span>
        </span>
      )}
    </>
  );
}
