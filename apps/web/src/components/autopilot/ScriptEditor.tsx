import type { CustomScriptLanguage } from "@repo/contracts";
import { lazy, Suspense } from "react";
import { Textarea } from "~/components/ui/textarea";

// CodeMirror is a few hundred kB, so it loads with the first script field, not with the board.
const ScriptEditorImpl = lazy(() => import("./ScriptEditorImpl"));

/**
 * A code editor for a script: monospace, line numbers and highlighting for its language. Until the editor has loaded
 * (and if it never does) the same value is editable in a plain text area.
 */
export function ScriptEditor({
  language,
  value,
  onChange,
  label,
  placeholder,
}: {
  language: CustomScriptLanguage;
  value: string;
  onChange: (value: string) => void;
  /** The accessible name. */
  label: string;
  placeholder?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-input bg-background shadow-xs/5 ring-ring/24 transition-shadow has-focus-visible:border-ring has-focus-visible:ring-[3px] dark:bg-input/32">
      <Suspense
        fallback={
          <Textarea
            aria-label={label}
            className="font-mono text-xs"
            rows={10}
            unstyled
            value={value}
            placeholder={placeholder}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        }
      >
        <ScriptEditorImpl
          language={language}
          value={value}
          onChange={onChange}
          label={label}
          placeholder={placeholder}
        />
      </Suspense>
    </div>
  );
}
