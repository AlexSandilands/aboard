import { customAutomationKey } from "@repo/contracts";
import { useState, type ReactNode } from "react";
import { EditorFooter, EditorHeader, EditorTitle } from "~/components/settings/EditorFrame";
import { Button } from "~/components/ui/button";
import {
  useCreateCustomAutomation,
  useDismissAutomationDraft,
  useUpdateCustomAutomation,
} from "~/state/customAutomations";
import { useSetAutopilotScope } from "~/state/mutations";
import { useBoard, useSettings } from "~/state/queries";
import {
  BUILDER_STEPS,
  firstProblem,
  formSentence,
  REVIEW_STEP,
  stepProblem,
  suggestedName,
  type BuilderStep,
} from "./builder.logic";
import { DetailsStep, DoStep, ReviewStep, Stepper, WhenStep, WhereStep, type StepProps } from "./BuilderSteps";
import { customFormToInput, type CustomForm } from "./customAutomations.logic";

/**
 * The custom automation builder (docs/features/autopilot.md#custom-automations): one form shown in five steps, When →
 * Do → Details → Where → Review & try, so each shows only what the chosen trigger and action need. A new one starts at
 * When and saves in Preview (or on); an existing one opens at Review, where each section has an Edit. Moving between
 * steps keeps everything typed. It is a settings sub-page; `customId` is null for a new automation.
 */
export function CustomAutomationEditorForm({
  customId,
  initial,
  onDone,
  onCancel,
  startStep,
  draftId,
  title,
  notice,
}: {
  customId: string | null;
  initial: CustomForm;
  /** Called with the saved automation's id. */
  onDone: (id: string) => void;
  onCancel: () => void;
  /** Where it opens: Review for an existing automation, When for a new one, unless said otherwise. */
  startStep?: BuilderStep;
  /** The agent's draft this was opened from ("Edit first"), dismissed once it is saved. */
  draftId?: string | undefined;
  title?: string;
  /** Shown above the steps: where what is being edited came from. */
  notice?: ReactNode;
}) {
  const opening = startStep ?? (customId ? REVIEW_STEP : 0);
  const [form, setFormState] = useState(() =>
    opening === REVIEW_STEP && !initial.name.trim() ? { ...initial, name: suggestedName(initial) } : initial,
  );
  const [step, setStep] = useState<BuilderStep>(opening);
  // Every step of an existing automation (or a file being edited) is filled in already, so all of them can be opened.
  const [reached, setReached] = useState<BuilderStep>(customId || opening > 0 ? REVIEW_STEP : opening);
  const [error, setError] = useState<string | null>(null);
  const board = useBoard().data;
  const boardVariables = useSettings().data?.automationVariables ?? [];
  const create = useCreateCustomAutomation();
  const update = useUpdateCustomAutomation();
  const setScope = useSetAutopilotScope(null);
  const dismiss = useDismissAutomationDraft();
  const pending = create.isPending || update.isPending || setScope.isPending;

  const setForm = (next: (current: CustomForm) => CustomForm) => {
    setFormState(next);
    setError(null);
  };
  const patch = (next: Partial<CustomForm>) => setForm((current) => ({ ...current, ...next }));

  const projects = board?.projects.filter((p) => p.archivedAt === null) ?? [];
  const tasks = board?.tasks ?? [];
  const epics = tasks.filter((t) => t.kind === "epic" && t.archivedAt === null);
  const props: StepProps = { form, patch, setForm, projects, epics, tasks, boardVariables };
  const sentence = formSentence(form, projects, epics);

  const goTo = (next: BuilderStep) => {
    // The name is asked for last, so it starts from one said from what was chosen.
    if (next === REVIEW_STEP && !form.name.trim())
      setFormState((current) => ({ ...current, name: suggestedName(current) }));
    setStep(next);
    setReached((r) => (next > r ? next : r));
    setError(null);
    window.scrollTo?.({ top: 0 });
  };

  const next = () => {
    const problem = stepProblem(form, step);
    if (problem) {
      setError(problem);
      return;
    }
    goTo((step + 1) as BuilderStep);
  };

  const finish = (id: string) => {
    if (draftId) dismiss.mutate(draftId);
    onDone(id);
  };

  const save = (turnOn: boolean) => {
    const problem = firstProblem(form);
    if (problem) {
      setStep(problem.step);
      setError(problem.error);
      return;
    }
    const result = customFormToInput(form);
    if (!result.ok) return;
    if (customId) {
      update.mutate({ id: customId, ...result.input }, { onSuccess: () => finish(customId) });
      return;
    }
    create.mutate(result.input, {
      // A new one is saved in Preview by the server; "Save and turn on" then switches it on for the board.
      onSuccess: (custom) => {
        if (turnOn) {
          setScope.mutate(
            { automation: customAutomationKey(custom.id), mode: "on" },
            { onSettled: () => finish(custom.id) },
          );
        } else finish(custom.id);
      },
    });
  };

  const isNew = customId === null;
  return (
    <>
      <EditorHeader>
        <EditorTitle>{title ?? (isNew ? "New automation" : "Edit automation")}</EditorTitle>
        {notice}
        <Stepper step={step} reached={reached} onStep={goTo} />
      </EditorHeader>
      <div className="space-y-4">
        {step < REVIEW_STEP ? (
          <p aria-live="polite" className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground sm:px-4">
            {sentence}
          </p>
        ) : null}
        {step === 0 ? <WhenStep {...props} /> : null}
        {step === 1 ? <DoStep {...props} /> : null}
        {step === 2 ? <DetailsStep {...props} /> : null}
        {step === 3 ? <WhereStep {...props} /> : null}
        {step === REVIEW_STEP ? (
          <ReviewStep {...props} sentence={sentence} customId={customId} isNew={isNew} onStep={goTo} />
        ) : null}
        {error ? (
          <p role="alert" className="px-1 text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
      </div>
      <EditorFooter className="sm:items-center">
        <Button variant="ghost" className="sm:me-auto" onClick={onCancel}>
          Cancel
        </Button>
        {step > 0 ? (
          <Button variant="outline" onClick={() => goTo((step - 1) as BuilderStep)}>
            Back
          </Button>
        ) : null}
        {step < REVIEW_STEP ? (
          <Button variant={isNew ? "default" : "outline"} onClick={next}>
            Next: {BUILDER_STEPS[step + 1]}
          </Button>
        ) : null}
        {isNew ? (
          step === REVIEW_STEP ? (
            <>
              <Button variant="outline" disabled={pending} onClick={() => save(true)}>
                Save and turn on
              </Button>
              <Button disabled={pending} onClick={() => save(false)}>
                Save in Preview
              </Button>
            </>
          ) : null
        ) : (
          <Button disabled={pending} onClick={() => save(false)}>
            Save changes
          </Button>
        )}
      </EditorFooter>
    </>
  );
}
