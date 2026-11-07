import { customAutomationKey } from "@repo/contracts";
import { useMemo, useState, type ReactNode } from "react";
import { EditorFooter, EditorHeader, EditorTitle } from "~/components/settings/EditorFrame";
import { Button } from "~/components/ui/button";
import {
  useCreateCustomAutomation,
  useDismissAutomationDraft,
  useTurnOnCustomAutomation,
  useUpdateCustomAutomation,
} from "~/state/customAutomations";
import { useAutopilotOverview, useBoard, useSettings } from "~/state/queries";
import {
  BUILDER_STEPS,
  firstProblem,
  formRunsScript,
  formSentence,
  REVIEW_STEP,
  stepProblem,
  suggestedName,
  type BuilderStep,
} from "./builder.logic";
import {
  DetailsStep,
  DoStep,
  ReviewStep,
  ScriptConfirm,
  Stepper,
  WhenStep,
  WhereStep,
  type StepProps,
} from "./BuilderSteps";
import { customFormToInput, type CustomForm } from "./customAutomations.logic";
import { useWhere } from "./useWhere";

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
  confirmScript = false,
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
  /**
   * It was opened on a script someone else wrote (Edit first on a file or an agent's draft): saving waits for the same
   * "I've read it" confirmation an import does, so editing first is no way around it.
   */
  confirmScript?: boolean;
}) {
  const opening = startStep ?? (customId ? REVIEW_STEP : 0);
  const [form, setFormState] = useState(() =>
    opening === REVIEW_STEP && !initial.name.trim() ? { ...initial, name: suggestedName(initial) } : initial,
  );
  const [step, setStep] = useState<BuilderStep>(opening);
  // Every step of an existing automation (or a file being edited) is filled in already, so all of them can be opened.
  const [reached, setReached] = useState<BuilderStep>(customId || opening > 0 ? REVIEW_STEP : opening);
  const [error, setError] = useState<string | null>(null);
  const [scriptRead, setScriptRead] = useState(false);
  const board = useBoard().data;
  const boardVariables = useSettings().data?.automationVariables ?? [];
  const create = useCreateCustomAutomation();
  const update = useUpdateCustomAutomation();
  const turnOn = useTurnOnCustomAutomation();
  const dismiss = useDismissAutomationDraft();
  const pending = create.isPending || update.isPending || turnOn.isPending;
  // A saved one's Where step edits its switches in place, so it needs its catalogue entry.
  const overview = useAutopilotOverview(customId !== null).data;
  const automation = useMemo(
    () => (customId ? (overview?.automations.find((a) => a.key === customAutomationKey(customId)) ?? null) : null),
    [overview, customId],
  );

  const setForm = (next: (current: CustomForm) => CustomForm) => {
    setFormState(next);
    setError(null);
  };
  const patch = (next: Partial<CustomForm>) => setForm((current) => ({ ...current, ...next }));

  const projects = board?.projects.filter((p) => p.archivedAt === null) ?? [];
  const tasks = board?.tasks ?? [];
  const epics = tasks.filter((t) => t.kind === "epic" && t.archivedAt === null);
  // A saved one's form reads where it runs from its switches, so the sentence and the previews say where it really runs.
  const where = useWhere(automation ?? { key: "", epicScope: false }).description;
  const shown =
    automation && where ? { ...form, everywhere: where.reach === "everywhere", projectIds: where.projects } : form;
  const props: StepProps = { form: shown, patch, setForm, projects, epics, tasks, boardVariables, automation };
  const sentence = formSentence(shown, projects);

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

  // Only while it still runs a script: one switched to an agent without a check has nothing to read.
  const mustConfirm = confirmScript && !scriptRead && formRunsScript(form);

  const save = (on: boolean) => {
    const problem = firstProblem(form);
    if (problem) {
      setStep(problem.step);
      setError(problem.error);
      return;
    }
    if (mustConfirm) {
      setStep(REVIEW_STEP);
      setError("Read the script, then confirm it runs on your machine as you");
      return;
    }
    const result = customFormToInput(form);
    if (!result.ok) return;
    if (customId) {
      // Where it runs was saved as it was picked: the definition is the rest.
      const { name, trigger, filters, action } = result.input;
      update.mutate({ id: customId, name, trigger, filters, action }, { onSuccess: () => finish(customId) });
      return;
    }
    create.mutate(result.input, {
      // A new one is saved in Preview where it was made to run; "Save and turn on" then switches it on there.
      onSuccess: (custom) => {
        if (on) {
          turnOn.mutate(
            { id: custom.id, projectIds: result.input.projectIds ?? [] },
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
        {step === REVIEW_STEP && confirmScript && formRunsScript(form) ? (
          <ScriptConfirm checked={scriptRead} onCheckedChange={setScriptRead} />
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
