import {
  actionScripts,
  type AutomationBundle,
  customAllowedTools,
  customAutomationKey,
  type AutomationExample,
} from "@repo/contracts";
import { BotIcon, FileUpIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { EditorFooter, EditorHeader, EditorPanel, EditorTitle } from "~/components/settings/EditorFrame";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { toastManager } from "~/components/ui/toast";
import {
  useAutomationDraft,
  useCustomAutomations,
  useDismissAutomationDraft,
  useImportCustomAutomation,
} from "~/state/customAutomations";
import { useSetAutopilotScope } from "~/state/mutations";
import { useBoard, useSettings } from "~/state/queries";
import { AutomationChangeReview } from "./AutomationChangeReview";
import { formFromBundle, formSentence } from "./builder.logic";
import { CustomAutomationEditorForm } from "./CustomAutomationEditorForm";
import {
  draftToRequest,
  importProblem,
  initialDraft,
  needsScriptConfirm,
  readBundle,
  type ImportDraft,
} from "./customAutomationImport.logic";
import { actionModelLabel, parseAllowedTools, type CustomForm } from "./customAutomations.logic";
import { InputValueControl } from "./InputsAndSlots";
import { ScriptWarning } from "./ScriptWarning";
import { VariableNeedsList } from "./VariablesEditor";
import { variableNeeds } from "./variables.logic";

/** A file bigger than this isn't an automation. */
const FILE_MAX_BYTES = 500_000;

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground/80">{title}</span>
      {children}
      {hint ? <span className="text-2xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function Code({ children, tall }: { children: string; tall?: boolean }) {
  return (
    <pre
      className={`overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-2xs whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/85 ${tall ? "max-h-96" : "max-h-56"}`}
    >
      {children}
    </pre>
  );
}

/**
 * The builder's review step for an automation someone else wrote: a shared file, or an agent's draft
 * (docs/features/autopilot.md#drafts). Read everything it would run (it runs on this machine), fill in its inputs and
 * tool slots, choose projects, then Import it (in Preview or on), or Edit first in the builder. Nothing is saved until
 * then. A draft that replaces one of the user's automations opens the before/after review instead.
 */
export function CustomAutomationImportForm({
  examples,
  initial,
  draftId,
  onDone,
  onCancel,
}: {
  examples?: readonly AutomationExample[];
  /** A bundle to open with (a recipe from the Add gallery), read like a file; the user can still load another. */
  initial?: AutomationBundle | undefined;
  /** An agent's draft to open; importing it deletes it. */
  draftId?: string | undefined;
  /** Called with the new automation's id. */
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const [bundle, setBundle] = useState<AutomationBundle | null>(initial ?? null);
  const [draft, setDraft] = useState<ImportDraft | null>(() => (initial ? initialDraft(initial) : null));
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const board = useBoard().data;
  const importing = useImportCustomAutomation();
  const agentDraft = useAutomationDraft(draftId);
  const dismissing = useDismissAutomationDraft();
  // The draft shown, until another file or example replaces it.
  const [fromDraft, setFromDraft] = useState<string | null>(null);
  const opened = useRef<string | null>(null);
  const projects = board?.projects.filter((p) => p.archivedAt === null) ?? [];
  const customs = useCustomAutomations();
  const setScope = useSetAutopilotScope(null);
  const [mode, setMode] = useState<"preview" | "on">("preview");
  // "Edit first": the builder, opened on what this would import (or, for a change, on the automation it changes).
  const [editing, setEditing] = useState<{ form: CustomForm; customId: string | null } | null>(null);
  const settings = useSettings().data;
  const boardVariables = settings?.automationVariables ?? [];
  const needs =
    bundle && draft
      ? variableNeeds(
          bundle.action,
          boardVariables,
          projects.filter((p) => draft.projectIds.length === 0 || draft.projectIds.includes(p.id)),
        )
      : [];

  const load = (next: AutomationBundle, draftFrom: string | null = null) => {
    setBundle(next);
    setDraft(initialDraft(next));
    setError(null);
    setFromDraft(draftFrom);
  };

  // Once per draft: a refetch (another window's change) mustn't wipe what the user filled in.
  const loaded = agentDraft.data;
  useEffect(() => {
    if (!loaded || opened.current === loaded.id) return;
    opened.current = loaded.id;
    setBundle(loaded.bundle);
    setDraft(initialDraft(loaded.bundle));
    setError(null);
    setFromDraft(loaded.id);
  }, [loaded]);
  const shownDraft = fromDraft && loaded?.id === fromDraft ? loaded : null;

  const readFile = async (file: File) => {
    if (file.size > FILE_MAX_BYTES) {
      setError("That file is too big to be an automation");
      return;
    }
    const read = readBundle(await file.text());
    if (read.ok) load(read.bundle);
    else {
      setBundle(null);
      setDraft(null);
      setFromDraft(null);
      setError(read.error);
    }
  };

  const problem = bundle && draft ? importProblem(bundle, draft) : null;
  const patch = (next: Partial<ImportDraft>) => setDraft((current) => (current ? { ...current, ...next } : current));

  const submit = () => {
    if (!bundle || !draft || problem || needsScriptConfirm(bundle, draft)) return;
    importing.mutate(draftToRequest(bundle, draft, shownDraft?.id), {
      onSuccess: ({ automation, skill }) => {
        if (skill?.renamed) {
          toastManager.add({
            type: "info",
            title: `Skill saved as ${skill.name}`,
            description: "You already had a skill with the file's name, so it was kept apart.",
          });
        }
        if (mode === "on") {
          setScope.mutate(
            { automation: customAutomationKey(automation.id), mode: "on" },
            { onSettled: () => onDone(automation.id) },
          );
        } else onDone(automation.id);
      },
    });
  };

  const editFirst = () => {
    if (!bundle || !draft) return;
    try {
      const form = formFromBundle(bundle, {
        inputs: draft.inputs,
        slots: Object.fromEntries(Object.entries(draft.slots).map(([name, text]) => [name, parseAllowedTools(text)])),
        projectIds: draft.projectIds,
      });
      setEditing({ form, customId: null });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  if (editing) {
    return (
      <CustomAutomationEditorForm
        customId={editing.customId}
        initial={editing.form}
        startStep={2}
        draftId={shownDraft?.id}
        title={editing.customId ? "Edit the change first" : "Edit before importing"}
        notice={
          <p className="text-sm text-muted-foreground">
            {editing.customId
              ? "The change is filled in. Saving changes the automation in place and removes the draft."
              : `Saving makes it as you leave it${shownDraft ? " and removes the draft" : ""}.`}
            {bundle?.skill
              ? ` The skill it carries (${bundle.skill.name}) isn't saved this way: import it as it is to save the skill.`
              : ""}
          </p>
        }
        onDone={onDone}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const target = shownDraft?.replaces ? customs.data?.find((c) => c.id === shownDraft.replaces) : undefined;
  if (shownDraft?.replaces) {
    if (target) {
      return (
        <AutomationChangeReview
          draft={shownDraft}
          current={target}
          onDone={onDone}
          onCancel={onCancel}
          onEditFirst={(form) => setEditing({ form, customId: target.id })}
        />
      );
    }
    if (customs.data) {
      return (
        <>
          <EditorHeader>
            <EditorTitle>Review a change</EditorTitle>
          </EditorHeader>
          <p role="alert" className="px-3 text-sm text-muted-foreground sm:px-4">
            The automation this draft changes was deleted, so there is nothing to apply it to.
          </p>
          <EditorFooter>
            <Button variant="ghost" onClick={onCancel}>
              Back
            </Button>
            <Button
              variant="outline"
              disabled={dismissing.isPending}
              onClick={() => dismissing.mutate(shownDraft.id, { onSuccess: onCancel })}
            >
              Dismiss draft
            </Button>
          </EditorFooter>
        </>
      );
    }
  }

  // What it does in one sentence, read like the builder's last step; a file that can't make a form shows none.
  const sentence = (() => {
    if (!bundle || !draft) return null;
    try {
      return formSentence(formFromBundle(bundle, { projectIds: draft.projectIds }), projects);
    } catch {
      return null;
    }
  })();

  const { action } = bundle ?? {};
  const tools = action ? customAllowedTools(action) : [];
  const scripts = action ? actionScripts(action) : [];

  return (
    <>
      <EditorHeader>
        <EditorTitle>{shownDraft ? "Review the draft" : "Import an automation"}</EditorTitle>
        <p className="text-sm text-muted-foreground">
          {shownDraft
            ? "Read what it would run before you import it: fill in its inputs and the tools it needs, and choose where it applies."
            : "Pick a file someone shared. You read what it would run, fill in its inputs and the tools it needs, and choose where it applies."}{" "}
          It comes in in Preview, recording what it would do, unless you choose On.
        </p>
      </EditorHeader>
      <EditorPanel className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="Automation file"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void readFile(file);
            }}
          />
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            <FileUpIcon />
            Choose a file
          </Button>
          {examples?.map((example) => (
            <Button key={example.id} variant="ghost-muted" size="sm" onClick={() => load(example.bundle)}>
              Example: {example.title}
            </Button>
          ))}
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
        {draftId && agentDraft.isError ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {agentDraft.error.message}
          </p>
        ) : draftId && agentDraft.isPending ? (
          <p className="text-xs text-muted-foreground">Loading the draft...</p>
        ) : null}
        {shownDraft ? (
          <Alert variant="info">
            <BotIcon />
            <AlertTitle>Drafted by an agent ({shownDraft.createdBy})</AlertTitle>
            <AlertDescription>
              {shownDraft.note ? <p className="whitespace-pre-wrap">{shownDraft.note}</p> : null}
              <p>
                An agent can only draft an automation: nothing is saved until you import it, and then it only records
                what it would do (in Preview) until you turn it on. Read it as carefully as a file from someone else. It
                is kept until {shownDraft.expiresAt.slice(0, 10)}.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {bundle && draft && action ? (
          <>
            <Alert variant="warning">
              <TriangleAlertIcon />
              <AlertTitle>Read all of this before you import it</AlertTitle>
              <AlertDescription>
                This was written by someone else. Once you turn it on, it runs on this machine with your access, so what
                it says below is what it will do. Nothing is saved until you import, and it imports in Preview, where a
                check script already runs for real.
              </AlertDescription>
            </Alert>

            <Section title="What it does">
              <p className="text-sm font-medium">{bundle.name}</p>
              {bundle.description ? <p className="text-sm text-muted-foreground">{bundle.description}</p> : null}
              {sentence ? <p className="text-sm leading-relaxed">{sentence}</p> : null}
            </Section>

            {action.kind === "agent" ? (
              <>
                <Section
                  title="Prompt the agent starts with"
                  hint={`Model: ${actionModelLabel(action.model, settings?.modelProfiles ?? [], bundle.trigger.kind === "schedule")}.${action.onPrBranch ? " Works on the pull request's branch." : ""}${action.skill && !bundle.skill ? ` It is told to use a skill called ${action.skill}, which isn't in the file: you need it installed already.` : ""}`}
                >
                  <Code tall>{action.prompt}</Code>
                </Section>
                {tools.length > 0 ? (
                  <Section
                    title="Tools it may use without asking"
                    hint="They run unattended, with nobody to approve a call. Read them against your own MCP servers."
                  >
                    <Code>{tools.join("\n")}</Code>
                  </Section>
                ) : null}
              </>
            ) : action.kind === "script" ? null : (
              <Section title="Command it runs">
                <Code tall>{action.command}</Code>
                <Alert variant="warning">
                  <TriangleAlertIcon />
                  <AlertDescription>
                    This runs on your machine as you, in the project&apos;s folder, whenever the trigger fires.
                    Don&apos;t import it unless you trust who wrote it and have read every line.
                  </AlertDescription>
                </Alert>
              </Section>
            )}

            {scripts.map(({ role, script }) => (
              <Section
                key={role}
                title={
                  role === "check"
                    ? `Check script it runs first (${script.language})`
                    : `Script it runs (${script.language})`
                }
                hint={
                  role === "check"
                    ? `It runs on this machine before the agent starts. Each line it prints starts an agent of its own${
                        action.kind === "agent" && !action.untrustedItems
                          ? ", which trusts the line and gets the usual access."
                          : ", which treats the line as untrusted: read-only, with only this board's tools."
                      }`
                    : undefined
                }
              >
                <Code tall>{script.body}</Code>
              </Section>
            ))}
            {scripts.length > 0 ? (
              <>
                <ScriptWarning>
                  <p>Don&apos;t import it unless you trust who wrote it and have read every line.</p>
                </ScriptWarning>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm">
                    I&apos;ve read {scripts.length === 1 ? "the script" : "the scripts"} above and I understand{" "}
                    {scripts.length === 1 ? "it runs" : "they run"} on my machine as me
                  </span>
                  <Switch
                    aria-label="Confirm the script runs on your machine"
                    checked={draft.confirmScript}
                    onCheckedChange={(confirmScript) => patch({ confirmScript })}
                  />
                </div>
              </>
            ) : null}

            {bundle.skill ? (
              <Section
                title={`Skill: ${bundle.skill.name}`}
                hint="Written to your skills folder (~/.claude/skills). A name you already use is kept apart, never overwritten."
              >
                <Code tall>{bundle.skill.body}</Code>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm">Save this skill so the agent can use it</span>
                  <Switch
                    aria-label="Save the skill"
                    checked={draft.installSkill}
                    onCheckedChange={(installSkill) => patch({ installSkill })}
                  />
                </div>
                {draft.installSkill ? null : (
                  <p className="text-2xs text-muted-foreground">Without it the automation runs without the skill.</p>
                )}
              </Section>
            ) : null}

            {bundle.inputs.length > 0 ? (
              <Section
                title="Inputs"
                hint={
                  bundle.action.kind === "agent"
                    ? "The prompt reads these as {{inputs.name}}. Start from the author's values."
                    : "It reads these as environment variables. Start from the author's values."
                }
              >
                <div className="flex flex-col gap-3">
                  {bundle.inputs.map((input) => (
                    <div key={input.name} className="flex flex-col gap-1">
                      <span className="text-xs">{input.label}</span>
                      <InputValueControl
                        label={input.label}
                        input={{ type: input.type, value: draft.inputs[input.name] ?? input.default }}
                        onChange={(value) => patch({ inputs: { ...draft.inputs, [input.name]: value } })}
                      />
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}

            {bundle.slots.length > 0 ? (
              <Section
                title="Tools it needs"
                hint="One tool per line, from your own MCP servers (mcp__server__tool, or mcp__server for all of its tools). It can't be switched on until each is filled in."
              >
                <div className="flex flex-col gap-3">
                  {bundle.slots.map((slot) => (
                    <div key={slot.name} className="flex flex-col gap-1">
                      <span className="text-xs">
                        {slot.label}
                        {slot.description ? <span className="text-muted-foreground"> — {slot.description}</span> : null}
                      </span>
                      <Textarea
                        aria-label={`${slot.label} tools`}
                        className="font-mono"
                        rows={2}
                        value={draft.slots[slot.name] ?? ""}
                        placeholder={"mcp__issue-tracker__search_jira\nmcp__issue-tracker__get_jira_issue"}
                        onChange={(event) =>
                          patch({ slots: { ...draft.slots, [slot.name]: event.currentTarget.value } })
                        }
                      />
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}

            {needs.length > 0 ? (
              <Section
                title="Variables it reads"
                hint="The file doesn't carry their values: they are yours. Set them for every project under Settings → Autopilot → Limits & safety → Variables, or in a project's settings. It doesn't run in a project where one has no value."
              >
                <VariableNeedsList needs={needs} />
              </Section>
            ) : null}

            <Section title="Only in these projects" hint="None picked is every project you switch it on in.">
              <ToggleGroup
                multiple
                aria-label="Projects"
                className="flex-wrap"
                value={draft.projectIds}
                onValueChange={(projectIds) => patch({ projectIds })}
              >
                {projects.map((p) => (
                  <Toggle key={p.id} value={p.id}>
                    {p.title}
                  </Toggle>
                ))}
              </ToggleGroup>
            </Section>

            <Section
              title="Saves in"
              hint={
                mode === "preview"
                  ? `Preview records what it would do and does none of it${scripts.some((s) => s.role === "check") ? ", but its check script still runs for real" : ""}. Switch it on once its Preview runs look right.`
                  : "On acts for real in every project it is switched on in, from now."
              }
            >
              <ToggleGroup
                aria-label="Saves in"
                value={[mode]}
                onValueChange={(next) => {
                  if (next[0] === "preview" || next[0] === "on") setMode(next[0]);
                }}
              >
                <Toggle value="preview">Preview</Toggle>
                <Toggle value="on">On</Toggle>
              </ToggleGroup>
            </Section>

            {problem ? (
              <p role="alert" className="text-xs text-destructive-foreground">
                {problem}
              </p>
            ) : null}
          </>
        ) : null}
      </EditorPanel>
      <EditorFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {shownDraft ? (
          <Button
            variant="outline"
            disabled={dismissing.isPending}
            onClick={() => dismissing.mutate(shownDraft.id, { onSuccess: onCancel })}
          >
            Dismiss draft
          </Button>
        ) : null}
        {bundle && draft ? (
          <Button variant="outline" onClick={editFirst}>
            Edit first
          </Button>
        ) : null}
        <Button
          disabled={
            !bundle ||
            !draft ||
            Boolean(problem) ||
            needsScriptConfirm(bundle, draft) ||
            importing.isPending ||
            setScope.isPending
          }
          onClick={submit}
        >
          Import
        </Button>
      </EditorFooter>
    </>
  );
}
