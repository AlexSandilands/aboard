import {
  AUTOMATION_SDK_RULES,
  AUTOMATION_SDK_SCOPE,
  AUTOMATION_SDK_SNIPPETS,
  type CustomScriptLanguage,
} from "@repo/contracts";
import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import type { ScriptRole } from "./scripts.logic";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toastManager.add({ type: "error", title: "Couldn't copy the snippet" });
    }
  };
  return (
    <Button size="xs" variant="ghost-muted" aria-label={label} onClick={() => void copy()}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/**
 * "What it can read": every value in scope (as a prompt, an environment variable and the stdin JSON name it), the rules
 * on exit codes and output, and snippets in the script's language for its role. Folded until opened. The text is
 * contracts' (AUTOMATION_SDK_*), which the authoring skill reuses.
 */
export function SdkPanel({ language, scriptRole }: { language: CustomScriptLanguage; scriptRole: ScriptRole }) {
  const [open, setOpen] = useState(false);
  const snippets = AUTOMATION_SDK_SNIPPETS[language].filter((s) => s.roles.includes(scriptRole));
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="-ms-1 inline-flex h-6 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 transition-transform motion-reduce:transition-none", open && "rotate-90")}
        />
        What it can read, with examples
      </CollapsibleTrigger>
      <CollapsiblePanel className="mt-2 space-y-3 rounded-lg border border-border/50 p-3">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-2xs">
            <thead className="text-foreground/70">
              <tr>
                <th className="pe-3 pb-1 font-medium">Value</th>
                <th className="pe-3 pb-1 font-medium">Environment</th>
                <th className="pb-1 font-medium">stdin JSON</th>
              </tr>
            </thead>
            <tbody className="font-mono text-foreground/85">
              {AUTOMATION_SDK_SCOPE.filter((v) => v.env).map((v) => (
                <tr key={v.what}>
                  <td className="pe-3 py-0.5 font-sans">{v.what}</td>
                  <td className="pe-3 py-0.5">{v.env}</td>
                  <td className="py-0.5">{v.stdin ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="list-disc space-y-1 ps-4 text-2xs text-muted-foreground">
          {AUTOMATION_SDK_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
        {snippets.map((snippet) => (
          <div key={snippet.title} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs font-medium text-foreground/70">{snippet.title}</span>
              <CopyButton text={snippet.code} label={`Copy ${snippet.title}`} />
            </div>
            <pre className="overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-2xs whitespace-pre text-foreground/85">
              {snippet.code}
            </pre>
          </div>
        ))}
      </CollapsiblePanel>
    </Collapsible>
  );
}
