import type { CustomScriptLanguage, Project, TaskSummary } from "@repo/contracts";
import { CheckIcon, CopyIcon, FileUpIcon, PlayIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useTestScript } from "~/state/customAutomations";
import { testScriptRequest, withLanguage, type CustomForm } from "./customAutomations.logic";
import { Choice, Field } from "./FormFields";
import { ScriptEditor } from "./ScriptEditor";
import {
  itemsSummary,
  languageOfFile,
  SCRIPT_FILE_MAX_BYTES,
  SCRIPT_LANGUAGES,
  scriptNeeds,
  testHeadline,
  type ScriptRole,
} from "./scripts.logic";

const OUTPUT_CLASS =
  "max-h-56 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-2xs whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/85";

/**
 * A script of the form: its language (and what that needs installed), the code, loading it from a file and copying it
 * out, its timeout, and a test run. `kind` says which of the form's scripts it is: the action's, or an agent's check.
 */
export function ScriptField({
  kind,
  form,
  patch,
  projects,
  sample,
}: {
  kind: ScriptRole;
  form: CustomForm;
  patch: (next: Partial<CustomForm>) => void;
  projects: readonly Project[];
  /** The task an action's test run can be given the values of. */
  sample: TaskSummary | null;
}) {
  const check = kind === "check";
  const language = check ? form.checkLanguage : form.language;
  const body = check ? form.checkBody : form.body;
  const timeout = check ? form.checkTimeoutSeconds : form.timeoutSeconds;
  const label = check ? "Check script" : "Script";
  const setBody = (next: string) => patch(check ? { checkBody: next } : { body: next });
  const file = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  const setLanguage = (next: CustomScriptLanguage) => patch(withLanguage(form, kind, next));

  const load = async (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > SCRIPT_FILE_MAX_BYTES) {
      toastManager.add({ type: "error", title: "That file is too large for a script" });
      return;
    }
    const text = await picked.text();
    const guessed = languageOfFile(picked.name);
    // The file's own language, when its name says it, so it is highlighted and run as what it is.
    patch({
      ...(guessed ? (check ? { checkLanguage: guessed } : { language: guessed }) : {}),
      ...(check ? { checkBody: text } : { body: text }),
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toastManager.add({ type: "error", title: "Couldn't copy the script" });
    }
  };

  return (
    <div className="space-y-4">
      <Field label="Language" hint={scriptNeeds(language)}>
        <ToggleGroup
          aria-label={`${label} language`}
          value={[language]}
          onValueChange={(next) => {
            const picked = SCRIPT_LANGUAGES.find((l) => l.value === next[0]);
            if (picked) setLanguage(picked.value);
          }}
        >
          {SCRIPT_LANGUAGES.map((l) => (
            <Toggle key={l.value} value={l.value}>
              {l.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </Field>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground/80">{label}</span>
          <div className="flex items-center gap-1">
            <input
              ref={file}
              type="file"
              hidden
              accept=".py,.js,.mjs,.cjs,.ps1,.sh,.bash,text/*"
              onChange={(event) => {
                void load(event.currentTarget.files?.[0]);
                // The same file picked again must still fire.
                event.currentTarget.value = "";
              }}
            />
            <Button size="xs" variant="ghost-muted" onClick={() => file.current?.click()}>
              <FileUpIcon />
              Load from file
            </Button>
            <Button size="xs" variant="ghost-muted" disabled={body === ""} onClick={() => void copy()}>
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
        <ScriptEditor
          language={language}
          value={body}
          onChange={setBody}
          label={label}
          placeholder="Write the script"
        />
        <span className="text-2xs text-muted-foreground">
          {check
            ? 'Print one JSON object per line, each with a "key". The context arrives as JSON on stdin and as environment variables.'
            : "The context arrives as JSON on stdin and as environment variables."}{" "}
          Press Esc, then Tab, to leave the editor.
        </span>
      </div>

      <Field label="Timeout (seconds)" hint="It is stopped after this long, and the run fails.">
        <Input
          size="sm"
          type="number"
          min={1}
          max={3600}
          aria-label={`${label} timeout in seconds`}
          className="sm:w-32"
          value={timeout}
          onChange={(event) =>
            patch(
              check
                ? { checkTimeoutSeconds: event.currentTarget.value }
                : { timeoutSeconds: event.currentTarget.value },
            )
          }
        />
      </Field>

      <ScriptTest kind={kind} form={form} projects={projects} sample={sample} />
    </div>
  );
}

/** Runs the script once for real, against a project the user picks, and shows what came of it. */
function ScriptTest({
  kind,
  form,
  projects,
  sample,
}: {
  kind: ScriptRole;
  form: CustomForm;
  projects: readonly Project[];
  sample: TaskSummary | null;
}) {
  const check = kind === "check";
  // A project with no folder has nowhere to run.
  const runnable = projects.filter((p) => p.workspaceRoot);
  const [projectId, setProjectId] = useState("");
  const [withTask, setWithTask] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const test = useTestScript();
  const chosen =
    runnable.find((p) => p.id === projectId) ?? runnable.find((p) => form.projectIds.includes(p.id)) ?? runnable[0];

  // What a run would send now. A result is only shown while it still matches: edit the script, its language, timeout or
  // prompt, or pick another project, and the last run's output no longer describes what is on screen.
  const request = chosen ? testScriptRequest(form, kind, chosen.id, withTask && sample ? sample.id : null) : null;
  const requestKey = request?.ok ? JSON.stringify(request.input) : null;
  const [ranKey, setRanKey] = useState<string | null>(null);
  const current = ranKey !== null && ranKey === requestKey;

  const run = () => {
    if (!request) return;
    if (!request.ok) {
      setProblem(request.error);
      setConfirming(false);
      return;
    }
    setProblem(null);
    setConfirming(false);
    setRanKey(JSON.stringify(request.input));
    test.mutate(request.input);
  };

  const result = current ? test.data : undefined;
  const headline = result ? testHeadline(result) : null;
  const failure = problem ?? (current && test.error instanceof Error ? test.error.message : null);

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-3">
      <div className="space-y-0.5">
        <span className="block text-sm font-medium">Test run</span>
        <span className="block text-xs text-muted-foreground">
          {check
            ? "Runs the check once, now, and shows the items it prints and the prompt the first one would start."
            : "Runs the script once, now, and shows its exit code and output."}{" "}
          Nothing is saved or recorded.
        </span>
      </div>

      {runnable.length === 0 ? (
        <p className="text-xs text-muted-foreground">No project has a workspace folder to run it in.</p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-40 flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground/80">In project</span>
            <Choice
              label="Project to test in"
              value={chosen?.id ?? ""}
              items={runnable.map((p) => ({ value: p.id, label: p.title }))}
              onChange={(id) => {
                setProjectId(id);
                setConfirming(false);
              }}
            />
          </div>
          {!check && sample ? (
            <div className="flex min-w-40 flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground/80">With</span>
              <Choice
                label="Task to test with"
                value={withTask ? "task" : "none"}
                items={[
                  { value: "none", label: "No task" },
                  { value: "task", label: `#${sample.number} ${sample.title}` },
                ]}
                onChange={(next) => setWithTask(next === "task")}
              />
            </div>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={test.isPending || confirming || !chosen}
            onClick={() => setConfirming(true)}
          >
            {test.isPending ? <Spinner /> : <PlayIcon />}
            {test.isPending ? "Running…" : "Run it now…"}
          </Button>
        </div>
      )}

      {confirming && chosen ? (
        <Alert variant="warning">
          <AlertDescription>
            <p>
              This really runs the {check ? "check" : "script"}, now, in <strong>{chosen.title}</strong>&apos;s folder
              as you. It is not a dry run: anything it does happens, such as approving or merging a pull request,
              pushing, or sending a message.
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="warning-outline" onClick={run}>
                Run it for real
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {failure ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {failure}
        </p>
      ) : null}

      {result && headline && !test.isPending ? (
        <div className="space-y-2" aria-live="polite">
          <Badge variant={headline.tone} size="lg">
            {headline.text}
          </Badge>
          {result.error ? <p className="text-xs text-destructive-foreground">{result.error}</p> : null}
          {result.items ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{itemsSummary(result.items)}</p>
              {"items" in result.items && result.items.items.length > 0 ? (
                <OutputBlock title="Items">
                  {result.items.items.map((item) => JSON.stringify(item)).join("\n")}
                </OutputBlock>
              ) : null}
              {"items" in result.items && result.items.prompt ? (
                <OutputBlock title="The first item's agent would start with">{result.items.prompt}</OutputBlock>
              ) : null}
              {"items" in result.items && result.items.items.length > 0 && !result.items.prompt ? (
                <p className="text-2xs text-muted-foreground">
                  Write the prompt to see what the first item would start.
                </p>
              ) : null}
            </div>
          ) : null}
          {result.stdout ? <OutputBlock title="stdout">{result.stdout}</OutputBlock> : null}
          {result.stderr ? <OutputBlock title="stderr">{result.stderr}</OutputBlock> : null}
          {!result.error && !result.stdout && !result.stderr ? (
            <p className="text-2xs text-muted-foreground">It printed nothing.</p>
          ) : null}
          {result.truncated ? <p className="text-2xs text-muted-foreground">Long output is cut here.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function OutputBlock({ title, children }: { title: string; children: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs font-medium text-muted-foreground">{title}</span>
      <pre className={OUTPUT_CLASS}>{children}</pre>
    </div>
  );
}
