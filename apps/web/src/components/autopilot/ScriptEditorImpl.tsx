import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
  type LanguageSupport,
} from "@codemirror/language";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { CustomScriptLanguage } from "@repo/contracts";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import type { Inserter } from "./InsertChips";

// The editor behind ScriptEditor. It is a separate file so CodeMirror stays out of the main bundle: the board only
// loads it when a script field is shown.

const LANGUAGES: Record<CustomScriptLanguage, () => Extension | LanguageSupport> = {
  python: () => python(),
  node: () => javascript(),
  powershell: () => StreamLanguage.define(powerShell),
  sh: () => StreamLanguage.define(shell),
};

// Colours come from the app's tokens, so the editor follows the theme and the Contrast setting.
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword], color: "var(--update-foreground)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--success-foreground)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--warning-foreground)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--muted-foreground)", fontStyle: "italic" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName)],
    color: "var(--info-foreground)",
  },
  { tag: [tags.className, tags.typeName, tags.standard(tags.variableName)], color: "var(--info-foreground)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--foreground)" },
  { tag: [tags.invalid], color: "var(--error-foreground)" },
]);

const theme = EditorView.theme({
  "&": {
    color: "var(--foreground)",
    backgroundColor: "transparent",
    fontSize: "12px",
    minHeight: "12rem",
    maxHeight: "28rem",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", overflow: "auto" },
  ".cm-content": { padding: "8px 0", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0 10px" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    border: "none",
    paddingLeft: "4px",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 4px", minWidth: "2.5ch", opacity: "0.6" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--foreground) 4%, transparent)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--primary) 28%, transparent)",
  },
  ".cm-matchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--primary) 22%, transparent)",
    outline: "none",
  },
  ".cm-placeholder": { color: "var(--placeholder, var(--muted-foreground))" },
});

export interface ScriptEditorImplProps {
  language: CustomScriptLanguage;
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  inserter?: Ref<Inserter>;
}

export default function ScriptEditorImpl({
  language,
  value,
  onChange,
  label,
  placeholder: hint,
  inserter,
}: ScriptEditorImplProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const languageSlot = useRef(new Compartment());
  // The newest callback, so the view made once never calls a stale one.
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    // Tab indents; Escape lets the next Tab leave the editor, so a keyboard user is never stuck in it.
    let tabLeaves = false;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(highlight),
        EditorState.tabSize.of(4),
        keymap.of([
          {
            key: "Escape",
            run: () => {
              tabLeaves = true;
              return true;
            },
          },
          {
            key: "Tab",
            run: (v) => {
              if (tabLeaves) return false;
              return v.state.selection.ranges.some((r) => !r.empty) ? indentMore(v) : insertSoftTab(v);
            },
            shift: (v) => (tabLeaves ? false : indentLess(v)),
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.domEventHandlers({
          keydown: (event) => {
            if (event.key !== "Escape") tabLeaves = false;
          },
          blur: () => {
            tabLeaves = false;
          },
        }),
        EditorView.contentAttributes.of({ "aria-label": label, "aria-multiline": "true" }),
        hint ? placeholder(hint) : [],
        theme,
        languageSlot.current.of(LANGUAGES[language]()),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changed.current(update.state.doc.toString());
        }),
      ],
    });
    const next = new EditorView({ state, parent: host.current! });
    view.current = next;
    return () => {
      next.destroy();
      view.current = null;
    };
    // The view is made once; the props below are applied by the effects after it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- value, language and label are synced by their own effects
  }, []);

  useImperativeHandle(
    inserter,
    () => ({
      insert: (text) => {
        const v = view.current;
        if (!v) return;
        const { from, to } = v.state.selection.main;
        v.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
          userEvent: "input",
        });
        v.focus();
      },
    }),
    [],
  );

  useEffect(() => {
    view.current?.dispatch({ effects: languageSlot.current.reconfigure(LANGUAGES[language]()) });
  }, [language]);

  // A value that changed from outside (a loaded file, a starter): typing already matches it.
  useEffect(() => {
    const current = view.current;
    if (!current || current.state.doc.toString() === value) return;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} data-slot="script-editor" />;
}

/** Four spaces (the tab size) up to the next stop, since a script's tabs are rarely wanted and Python mixes badly. */
function insertSoftTab(v: EditorView): boolean {
  const { state } = v;
  const unit = state.tabSize;
  const changes = state.changeByRange((range) => {
    const col = range.from - state.doc.lineAt(range.from).from;
    const insert = " ".repeat(unit - (col % unit));
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });
  v.dispatch(changes, { userEvent: "input" });
  return true;
}
