import {
  actionScripts,
  type AutomationBundle,
  customAllowedTools,
  describeCustomTrigger,
  MODEL_TIERS,
  type AutomationExample,
} from "@repo/contracts";
import { FileUpIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { EditorFooter, EditorHeader, EditorPanel, EditorTitle } from "~/components/settings/EditorFrame";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { toastManager } from "~/components/ui/toast";
import { useImportCustomAutomation } from "~/state/customAutomations";
import { useBoard } from "~/state/queries";
import {
  draftToRequest,
  importProblem,
  initialDraft,
  needsScriptConfirm,
  readBundle,
  type ImportDraft,
} from "./customAutomationImport.logic";
import { InputValueControl } from "./InputsAndSlots";
import { ScriptWarning } from "./ScriptWarning";

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
 * Importing a shared automation: pick the file, read everything it would run (it is someone else's, and runs on this
 * machine), fill in its inputs and tool slots, choose projects. Nothing is saved until Import, and it comes in off.
 */
export function CustomAutomationImportForm({
  examples,
  onDone,
  onCancel,
}: {
  examples?: readonly AutomationExample[];
  /** Called with the new automation's id. */
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const [bundle, setBundle] = useState<AutomationBundle | null>(null);
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const board = useBoard().data;
  const importing = useImportCustomAutomation();
  const projects = board?.projects.filter((p) => p.archivedAt === null) ?? [];

  const load = (next: AutomationBundle) => {
    setBundle(next);
    setDraft(initialDraft(next));
    setError(null);
  };

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
      setError(read.error);
    }
  };

  const problem = bundle && draft ? importProblem(bundle, draft) : null;
  const patch = (next: Partial<ImportDraft>) => setDraft((current) => (current ? { ...current, ...next } : current));

  const submit = () => {
    if (!bundle || !draft || problem || needsScriptConfirm(bundle, draft)) return;
    importing.mutate(draftToRequest(bundle, draft), {
      onSuccess: ({ automation, skill }) => {
        if (skill?.renamed) {
          toastManager.add({
            type: "info",
            title: `Skill saved as ${skill.name}`,
            description: "You already had a skill with the file's name, so it was kept apart.",
          });
        }
        onDone(automation.id);
      },
    });
  };

  const { action } = bundle ?? {};
  const tools = action ? customAllowedTools(action) : [];
  const scripts = action ? actionScripts(action) : [];

  return (
    <>
      <EditorHeader>
        <EditorTitle>Import an automation</EditorTitle>
        <p className="text-sm text-muted-foreground">
          Pick a file someone shared. You read what it would run, fill in its inputs and the tools it needs, and choose
          where it applies. It comes in switched off.
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

        {bundle && draft && action ? (
          <>
            <Alert variant="warning">
              <TriangleAlertIcon />
              <AlertTitle>Read all of this before you import it</AlertTitle>
              <AlertDescription>
                This was written by someone else. Once you switch it on, it runs on this machine with your access, so
                what it says below is what it will do. Nothing is saved until you import.
              </AlertDescription>
            </Alert>

            <Section title="Automation">
              <p className="text-sm font-medium">{bundle.name}</p>
              {bundle.description ? <p className="text-sm text-muted-foreground">{bundle.description}</p> : null}
              <p className="text-xs text-muted-foreground">
                {describeCustomTrigger(bundle.trigger)}
                {bundle.filters.labels.length > 0 ? `, on tasks labelled ${bundle.filters.labels.join(" or ")}` : ""}
              </p>
            </Section>

            {action.kind === "agent" ? (
              <>
                <Section
                  title="Prompt the agent starts with"
                  hint={`Model tier: ${MODEL_TIERS.find((t) => t.value === action.tier)?.label ?? "the default"}.${action.onPrBranch ? " Works on the pull request's branch." : ""}${action.skill && !bundle.skill ? ` It is told to use a skill called ${action.skill}, which isn't in the file: you need it installed already.` : ""}`}
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
                hint={role === "check" ? "It runs on this machine before the agent starts." : undefined}
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
              <Section title="Inputs" hint="The prompt reads these as {{inputs.name}}. Start from the author's values.">
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
        <Button
          disabled={!bundle || !draft || Boolean(problem) || needsScriptConfirm(bundle, draft) || importing.isPending}
          onClick={submit}
        >
          Import automation
        </Button>
      </EditorFooter>
    </>
  );
}
