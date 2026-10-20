import type { CustomScriptLanguage } from "@repo/contracts";
import { lazy, Suspense, useImperativeHandle, useRef, type ReactNode, type Ref } from "react";
import { Textarea } from "~/components/ui/textarea";
import { insertIntoTextarea, type Inserter } from "./InsertChips";

// CodeMirror is a few hundred kB, so it loads with the first script field, not with the board.
const ScriptEditorImpl = lazy(() => import("./ScriptEditorImpl"));

/**
 * A code editor for a script: monospace, line numbers and highlighting for its language. Until the editor has loaded
 * (and if it never does) the same value is editable in a plain text area. `inserter` is set to what puts text at the
 * cursor; `header` and `footer` sit inside its frame, above and below the code.
 */
export function ScriptEditor({
  language,
  value,
  onChange,
  label,
  placeholder,
  inserter,
  header,
  footer,
}: {
  language: CustomScriptLanguage;
  value: string;
  onChange: (value: string) => void;
  /** The accessible name. */
  label: string;
  placeholder?: string;
  inserter?: Ref<Inserter>;
  header?: ReactNode;
  footer?: ReactNode;
}) {
  const fallbackBox = useRef<HTMLTextAreaElement>(null);
  // Set by the editor once it has loaded; until then inserts go to the text area.
  const loaded = useRef<Inserter | null>(null);
  useImperativeHandle(
    inserter,
    () => ({
      insert: (text) =>
        loaded.current ? loaded.current.insert(text) : insertIntoTextarea(fallbackBox.current, text, onChange),
    }),
    [onChange],
  );

  return (
    <div className="relative overflow-hidden rounded-lg border border-input bg-background shadow-xs/5 ring-ring/24 transition-shadow has-[.cm-focused,textarea:focus-visible]:border-ring has-[.cm-focused,textarea:focus-visible]:ring-[3px] dark:bg-input/32">
      {header ? <div className="border-b border-input/70 px-2 py-1.5">{header}</div> : null}
      <Suspense
        fallback={
          <Textarea
            ref={fallbackBox}
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
          inserter={loaded}
        />
      </Suspense>
      {footer ? <div className="border-t border-input/70 px-2.5 py-1">{footer}</div> : null}
    </div>
  );
}
