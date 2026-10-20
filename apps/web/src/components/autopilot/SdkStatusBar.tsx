import {
  AUTOMATION_SDK_RULES,
  AUTOMATION_SDK_SCOPE,
  AUTOMATION_SDK_SNIPPETS,
  brandEnv,
  type CustomScriptLanguage,
  type SdkSnippet,
} from "@repo/contracts";
import {
  BracesIcon,
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  CornerDownLeftIcon,
  FolderGit2Icon,
  ListTodoIcon,
  type LucideIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SquareTerminalIcon,
  VariableIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { SettingsGroup, SettingsSectionHeader } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle, SheetTrigger } from "~/components/ui/sheet";
import { toastManager } from "~/components/ui/toast";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import type { ChipTone } from "./insertChips.logic";
import { SCRIPT_LANGUAGES, type ScriptRole } from "./scripts.logic";
import { LanguageBadge, TONE, toneOf } from "./sdkStyle";

/** Copies text, flipping `copied` on for a moment; a failure says so in a toast. */
function useCopy(what: string) {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toastManager.add({ type: "error", title: `Couldn't copy the ${what}` });
    }
  };
  return { copied, copy };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { copied, copy } = useCopy("snippet");
  return (
    <Button size="xs" variant="ghost-muted" aria-label={label} onClick={() => void copy(text)}>
      {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/** An example in an editor-like frame: the language and title on a tab bar, then the code. */
function SnippetCard({
  language,
  snippets,
  picked,
  onPick,
  actions,
}: {
  language: CustomScriptLanguage;
  snippets: readonly SdkSnippet[];
  picked: SdkSnippet;
  onPick: (snippet: SdkSnippet) => void;
  actions?: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card/40 shadow-xs/5">
      <div role="tablist" aria-label="Examples" className="flex items-center gap-0.5 border-b border-border/50 px-1.5">
        <LanguageBadge language={language} className="ms-1 me-1.5" />
        {snippets.map((s) => (
          <button
            key={s.title}
            type="button"
            role="tab"
            aria-selected={s === picked}
            onClick={() => onPick(s)}
            className={cn(
              "-mb-px border-b-2 px-2 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
              s === picked
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {s.title}
          </button>
        ))}
      </div>
      <pre className="max-h-64 overflow-auto px-3 py-2.5 font-mono text-2xs leading-relaxed whitespace-pre text-foreground/85">
        {picked.code}
      </pre>
      <div className="flex justify-end gap-1 border-t border-border/50 px-1.5 py-1">
        <CopyButton text={picked.code} label={`Copy ${picked.title}`} />
        {actions}
      </div>
    </div>
  );
}

const LINK =
  "rounded-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring data-popup-open:underline";

/** The examples for the language and role, one at a time, to copy or put at the editor's cursor. */
function Examples({
  language,
  snippets,
  onInsert,
}: {
  language: CustomScriptLanguage;
  snippets: readonly SdkSnippet[];
  onInsert?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(snippets[0]);
  const snippet = picked && snippets.includes(picked) ? picked : snippets[0];
  if (!snippet) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={LINK}>Examples</PopoverTrigger>
      <PopoverPopup align="end" side="top" padding="none" className="w-[min(34rem,calc(100vw-2rem))]">
        <SnippetCard
          language={language}
          snippets={snippets}
          picked={snippet}
          onPick={setPicked}
          actions={
            onInsert ? (
              <Button
                size="xs"
                variant="secondary"
                onClick={() => {
                  setOpen(false);
                  onInsert(`${snippet.code}\n`);
                }}
              >
                <CornerDownLeftIcon />
                Insert at cursor
              </Button>
            ) : null
          }
        />
      </PopoverPopup>
    </Popover>
  );
}

const GROUPS: { tone: ChipTone; title: string; icon: LucideIcon }[] = [
  { tone: "task", title: "The task", icon: ListTodoIcon },
  { tone: "project", title: "The project", icon: FolderGit2Icon },
  { tone: "own", title: "Yours", icon: SlidersHorizontalIcon },
];

/** One value as a settings row: what it is on the left, its name as a coloured pill that copies it on the right. */
function ValueRow({ what, name, tone }: { what: string; name: string; tone: ChipTone }) {
  const { copied, copy } = useCopy("name");
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 sm:px-4">
      <span className="text-sm text-foreground/90">{what}</span>
      <button
        type="button"
        aria-label={`Copy ${name}`}
        onClick={() => void copy(name)}
        className={cn(
          "group inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-2xs ring-1 ring-inset outline-none focus-visible:ring-2 focus-visible:ring-ring",
          TONE[tone].text,
          TONE[tone].surface,
          TONE[tone].ring,
        )}
      >
        <span className="truncate">{name}</span>
        {copied ? (
          <CheckIcon aria-hidden className="size-3 shrink-0" />
        ) : (
          <CopyIcon
            aria-hidden
            className="size-3 shrink-0 opacity-0 group-hover:opacity-70 group-focus-visible:opacity-70"
          />
        )}
      </button>
    </div>
  );
}

const RULE_LOOK: Record<string, { icon: LucideIcon; className: string }> = {
  "Exit code": { icon: CircleCheckIcon, className: "bg-success/12 text-success-foreground" },
  Output: { icon: SquareTerminalIcon, className: "bg-info/12 text-info-foreground" },
  "Values, not code": { icon: ShieldCheckIcon, className: "bg-warning/12 text-warning-foreground" },
  Variables: { icon: VariableIcon, className: "bg-primary/12 text-primary" },
};

/** Everything in one side sheet: each value by stdin path or environment variable, the rules, and the examples. */
function FullReference({ language, snippets }: { language: CustomScriptLanguage; snippets: readonly SdkSnippet[] }) {
  // sh can't parse the stdin JSON, so it opens on the environment.
  const [view, setView] = useState<"stdin" | "env">(language === "sh" ? "env" : "stdin");
  const [picked, setPicked] = useState(snippets[0]);
  const snippet = picked && snippets.includes(picked) ? picked : snippets[0];
  const label = SCRIPT_LANGUAGES.find((l) => l.value === language)?.label ?? language;
  return (
    <Sheet>
      <SheetTrigger className={LINK}>Full reference</SheetTrigger>
      <SheetPopup className="max-w-lg">
        <SheetHeader className="flex-row items-start gap-3 pb-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/25 ring-inset">
            <BracesIcon className="size-5" />
          </span>
          <div className="min-w-0 space-y-1 pe-8">
            <SheetTitle className="flex items-center gap-2 text-base">
              What it can read
              <LanguageBadge language={language} />
            </SheetTitle>
            <SheetDescription className="text-xs">
              {language === "sh"
                ? "sh reads the environment; the same values are on stdin as JSON for a tool like jq. Click a name to copy it."
                : `The JSON on stdin, parsed into ctx in ${label}, or the environment. Click a name to copy it.`}
            </SheetDescription>
          </div>
        </SheetHeader>
        <div className="flex min-h-0 flex-col gap-6 overflow-y-auto px-6 pb-8">
          <ToggleGroup
            aria-label="Show values as"
            value={[view]}
            onValueChange={(next) => {
              if (next[0] === "stdin" || next[0] === "env") setView(next[0]);
            }}
          >
            <Toggle value="stdin">stdin JSON</Toggle>
            <Toggle value="env">Environment</Toggle>
          </ToggleGroup>

          {GROUPS.map((group) => {
            const rows = AUTOMATION_SDK_SCOPE.filter((v) => toneOf(v) === group.tone);
            const Icon = group.icon;
            return (
              <section key={group.tone} className="space-y-2">
                <SettingsSectionHeader
                  title={group.title}
                  status={<Icon aria-hidden className={cn("size-3.5", TONE[group.tone].text)} />}
                />
                <SettingsGroup>
                  {rows.map((v) => (
                    <ValueRow
                      key={v.what}
                      what={v.what}
                      name={(view === "stdin" ? v.stdin : v.env) ?? ""}
                      tone={group.tone}
                    />
                  ))}
                </SettingsGroup>
              </section>
            );
          })}

          <section className="space-y-2">
            <SettingsSectionHeader title="Rules" />
            <div className="grid gap-2 sm:grid-cols-2">
              {AUTOMATION_SDK_RULES.map((rule) => {
                const look = RULE_LOOK[rule.title] ?? { icon: CircleCheckIcon, className: "bg-muted text-foreground" };
                const Icon = look.icon;
                return (
                  <div
                    key={rule.title}
                    className="space-y-2 rounded-xl border border-border/60 bg-card/40 p-3 shadow-xs/5"
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn("grid size-6 place-items-center rounded-md", look.className)}>
                        <Icon aria-hidden className="size-3.5" />
                      </span>
                      <span className="text-sm font-medium">{rule.title}</span>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">{rule.text}</p>
                  </div>
                );
              })}
            </div>
          </section>

          {snippet ? (
            <section className="space-y-2">
              <SettingsSectionHeader title="Examples" />
              <SnippetCard language={language} snippets={snippets} picked={snippet} onPick={setPicked} />
            </section>
          ) : null}
        </div>
      </SheetPopup>
    </Sheet>
  );
}

/**
 * The one line under a script or command: how values arrive and what makes a run pass, with the examples (to copy or
 * insert) and the full reference a click away. The text is contracts' (AUTOMATION_SDK_*), which the authoring skill
 * reuses.
 */
export function SdkStatusBar({
  language,
  scriptRole,
  onInsert,
  className,
}: {
  language: CustomScriptLanguage;
  scriptRole: ScriptRole;
  onInsert?: (text: string) => void;
  className?: string;
}) {
  const snippets = AUTOMATION_SDK_SNIPPETS[language].filter((s) => s.roles.includes(scriptRole));
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground", className)}>
      <span>
        {language === "sh" ? "Reads " : "Reads stdin JSON as ctx, and "}
        <code className="font-mono">{brandEnv("*")}</code> env
      </span>
      <span className="inline-flex items-center gap-1">
        <span aria-hidden className="size-1.5 rounded-full bg-success" />
        exit 0 succeeds
      </span>
      {scriptRole === "check" ? <span>one JSON object per line</span> : null}
      <span>keeps the last 4,000 characters</span>
      {/* Keyed by language so a switch starts each on its own first example; distinct keys, as siblings. */}
      <span className="ms-auto flex items-center gap-3">
        <Examples key={`examples-${language}`} language={language} snippets={snippets} onInsert={onInsert} />
        <FullReference key={`reference-${language}`} language={language} snippets={snippets} />
      </span>
    </div>
  );
}
