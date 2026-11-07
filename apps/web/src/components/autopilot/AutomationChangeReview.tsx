import { actionScripts, type AutomationDraft, type CustomAutomation } from "@repo/contracts";
import { BotIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { EditorFooter, EditorHeader, EditorTitle } from "~/components/settings/EditorFrame";
import { SettingsGroup } from "~/components/settings/settingsLayout";
import { Diff } from "~/components/settings/SuggestionsSection";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { useApplyAutomationDraft, useDismissAutomationDraft } from "~/state/customAutomations";
import { useSettings } from "~/state/queries";
import { Block } from "./BuilderSteps";
import { addedTools, automationChanges, changesScripts, proposedDefinition } from "./changeReview.logic";
import { formFromCustom, parseAllowedTools, type CustomForm } from "./customAutomations.logic";
import { InputValueControl } from "./InputsAndSlots";
import { ScriptWarning } from "./ScriptWarning";

/**
 * A draft that replaces one of the user's custom automations (draft_automation's `replaces`): the difference field by
 * field, then Keep current (dismiss it), Edit first (the builder, on the automation, with the change filled in) or
 * Apply change, which changes the automation in place and keeps its id, switches and run history. A changed script is
 * read and confirmed first, as on an import.
 */
export function AutomationChangeReview({
  draft,
  current,
  onDone,
  onCancel,
  onEditFirst,
}: {
  draft: AutomationDraft;
  current: CustomAutomation;
  /** After applying or keeping: the automation's id. */
  onDone: (id: string) => void;
  onCancel: () => void;
  /** Opens the builder on the automation with this form, the change applied. */
  onEditFirst: (form: CustomForm) => void;
}) {
  const { bundle } = draft;
  const profiles = useSettings().data?.modelProfiles ?? [];
  const apply = useApplyAutomationDraft();
  const dismiss = useDismissAutomationDraft();
  const currentInputs = new Set(current.action.inputs.map((i) => i.name));
  const currentSlots = new Set(current.action.kind === "agent" ? current.action.slots.map((s) => s.name) : []);
  // Only what is new needs filling in: the rest keeps the automation's values.
  const newInputs = bundle.inputs.filter((i) => !currentInputs.has(i.name));
  const newSlots = bundle.slots.filter((s) => !currentSlots.has(s.name));
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(newInputs.map((i) => [i.name, i.default])),
  );
  const [slots, setSlots] = useState<Record<string, string>>({});
  const [confirmScript, setConfirmScript] = useState(false);
  const keepsSkill = current.action.kind === "agent" && bundle.skill?.name === current.action.skill;
  const [installSkill, setInstallSkill] = useState(false);

  const fill = useMemo(
    () => ({
      inputs,
      slots: Object.fromEntries(Object.entries(slots).map(([name, text]) => [name, parseAllowedTools(text)])),
    }),
    [inputs, slots],
  );
  const proposed = useMemo(() => {
    try {
      return { ok: true as const, def: proposedDefinition(current, bundle, fill) };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  }, [current, bundle, fill]);
  const changes = proposed.ok ? automationChanges(current, proposed.def, profiles) : [];
  const scriptChanged = proposed.ok && changesScripts(current, proposed.def);
  const tools = proposed.ok ? addedTools(current, proposed.def) : [];
  const offersSkill = Boolean(bundle.skill) && !keepsSkill;

  const submit = () =>
    apply.mutate(
      { id: draft.id, ...fill, confirmScript, installSkill: offersSkill && installSkill },
      {
        onSuccess: ({ automation, skill }) => {
          toastManager.add({ type: "success", title: `Applied the change to ${automation.name}` });
          if (skill?.renamed) {
            toastManager.add({
              type: "info",
              title: `Skill saved as ${skill.name}`,
              description: "You already had a skill with the draft's name, so it was kept apart.",
            });
          }
          onDone(automation.id);
        },
      },
    );

  return (
    <>
      <EditorHeader>
        <EditorTitle>Change to {current.name}</EditorTitle>
        <p className="text-sm text-muted-foreground">
          Proposed by {draft.createdBy}. Nothing changes until you apply it. Applying keeps its mode (Off, Preview or
          On), where it runs and its run history.
        </p>
      </EditorHeader>
      <div className="space-y-4">
        {draft.note ? (
          <Alert variant="info">
            <BotIcon />
            <AlertTitle>Why</AlertTitle>
            <AlertDescription>
              <p className="whitespace-pre-wrap">{draft.note}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        {!proposed.ok ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {proposed.error}
          </p>
        ) : changes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The draft is the same as the automation: there is nothing to apply.
          </p>
        ) : (
          <div className="space-y-3">
            {changes.map((change) => (
              <section key={change.title} className="space-y-1.5" aria-label={`${change.title} change`}>
                <h2 className="px-1 text-xs font-medium text-foreground/80">{change.title}</h2>
                <Diff before={change.before} after={change.after} />
              </section>
            ))}
          </div>
        )}

        {tools.length > 0 ? (
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertDescription>
              It adds tools the agent may use without asking: {tools.join(", ")}. They run unattended, with your access.
            </AlertDescription>
          </Alert>
        ) : null}

        {newInputs.length > 0 || newSlots.length > 0 || offersSkill || scriptChanged ? (
          <SettingsGroup>
            {newInputs.length > 0 ? (
              <Block>
                <span className="text-xs font-medium text-foreground/80">New inputs</span>
                {newInputs.map((input) => (
                  <div key={input.name} className="flex flex-col gap-1">
                    <span className="text-xs">{input.label}</span>
                    <InputValueControl
                      label={input.label}
                      input={{ type: input.type, value: inputs[input.name] ?? input.default }}
                      onChange={(value) => setInputs((typed) => ({ ...typed, [input.name]: value }))}
                    />
                  </div>
                ))}
              </Block>
            ) : null}
            {newSlots.length > 0 ? (
              <Block>
                <span className="text-xs font-medium text-foreground/80">New tools it needs</span>
                {newSlots.map((slot) => (
                  <div key={slot.name} className="flex flex-col gap-1">
                    <span className="text-xs">
                      {slot.label}
                      {slot.description ? <span className="text-muted-foreground"> — {slot.description}</span> : null}
                    </span>
                    <Textarea
                      aria-label={`${slot.label} tools`}
                      className="font-mono"
                      rows={2}
                      value={slots[slot.name] ?? ""}
                      placeholder="mcp__issue-tracker__search_jira"
                      onChange={(event) => {
                        const text = event.currentTarget.value;
                        setSlots((typed) => ({ ...typed, [slot.name]: text }));
                      }}
                    />
                  </div>
                ))}
              </Block>
            ) : null}
            {offersSkill && bundle.skill ? (
              <Block>
                <span className="text-xs font-medium text-foreground/80">Skill: {bundle.skill.name}</span>
                <pre className="max-h-56 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-2xs whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/85">
                  {bundle.skill.body}
                </pre>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm">Save this skill so the agent can use it</span>
                  <Switch aria-label="Save the skill" checked={installSkill} onCheckedChange={setInstallSkill} />
                </div>
              </Block>
            ) : null}
            {scriptChanged ? (
              <Block>
                <ScriptWarning>
                  <p>
                    Read the new {actionScripts(bundle.action).length === 1 ? "script" : "scripts"} above before you
                    apply it.
                  </p>
                </ScriptWarning>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm">
                    I&apos;ve read the changed script and I understand it runs on my machine as me
                  </span>
                  <Switch
                    aria-label="Confirm the script runs on your machine"
                    checked={confirmScript}
                    onCheckedChange={setConfirmScript}
                  />
                </div>
              </Block>
            ) : null}
          </SettingsGroup>
        ) : null}
      </div>
      <EditorFooter className="sm:items-center">
        <Button variant="ghost" className="sm:me-auto" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="outline"
          disabled={dismiss.isPending}
          onClick={() =>
            dismiss.mutate(draft.id, {
              onSuccess: () => {
                toastManager.add({ type: "info", title: `Kept ${current.name} as it was` });
                onDone(current.id);
              },
            })
          }
        >
          Keep current
        </Button>
        <Button
          variant="outline"
          disabled={!proposed.ok}
          onClick={() => proposed.ok && onEditFirst(formFromCustom(proposed.def))}
        >
          Edit first
        </Button>
        <Button
          disabled={!proposed.ok || changes.length === 0 || (scriptChanged && !confirmScript) || apply.isPending}
          onClick={submit}
        >
          Apply change
        </Button>
      </EditorFooter>
    </>
  );
}
