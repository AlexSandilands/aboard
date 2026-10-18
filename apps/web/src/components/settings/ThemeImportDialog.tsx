// Adapted from T3 Code (apps/web/src/components/settings/ThemeImportDialog.tsx), MIT — see NOTICE. Add a theme:
// search Open VSX, drop or choose theme files (T3 Code or VS Code), or paste a theme's JSON.
import { DownloadIcon, PlusIcon } from "lucide-react";
import { type ChangeEvent, type DragEvent, type UIEvent, useEffect, useRef, useState } from "react";
import { Alert } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { toastManager } from "~/components/ui/toast";
import { customThemeLibrary, useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import type { ThemeDefinition } from "~/theme/palettes";
import { pairVsCodeThemes, resolveThemeLabelCollisions } from "~/theme/vscodeThemeImport";
import {
  describeOversizedThemeFile,
  highlightJson,
  nameFromFileName,
  parseImportedTheme,
  versionedCopy,
} from "./themeImport.logic";
import { ThemeSearchSection } from "./ThemeSearchSection";

/** Highlighting rebuilds the whole markup on every keystroke, so big pastes fall back to plain text. */
const MAX_HIGHLIGHTED_JSON_LENGTH = 20_000;

function ThemeJsonEditor({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  const highlightRef = useRef<HTMLPreElement>(null);
  const isPlainText = value.length > MAX_HIGHLIGHTED_JSON_LENGTH;
  const syncScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    const highlight = highlightRef.current;
    if (!highlight) return;
    highlight.scrollTop = event.currentTarget.scrollTop;
    highlight.scrollLeft = event.currentTarget.scrollLeft;
  };
  return (
    <div className="relative overflow-hidden rounded-xl border border-input bg-background shadow-xs/5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/24 focus-within:ring-inset">
      {isPlainText ? null : (
        <pre
          ref={highlightRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 m-0 overflow-hidden p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-foreground"
        >
          {/* oxlint-disable-next-line react/no-danger -- highlightJson escapes every character it doesn't wrap in its own spans */}
          <code dangerouslySetInnerHTML={{ __html: highlightJson(value) }} />
        </pre>
      )}
      <textarea
        aria-label="Theme JSON"
        className={cn(
          "relative z-10 block min-h-44 w-full resize-y overflow-auto bg-transparent p-3 font-mono text-xs leading-5 caret-foreground outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground",
          isPlainText ? "text-foreground" : "text-transparent",
        )}
        id={id}
        onChange={(event) => onChange(event.currentTarget.value)}
        onScroll={syncScroll}
        placeholder={'{\n  "version": 1,\n  "name": "Aurora",\n  "appearance": "light",\n  "colors": { ... }\n}'}
        spellCheck={false}
        value={value}
      />
    </div>
  );
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

export function ThemeImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { setThemeId } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [json, setJson] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [conflicts, setConflicts] = useState<ReadonlyArray<ThemeDefinition> | null>(null);
  const requestRef = useRef(0);

  const [renderedOpen, setRenderedOpen] = useState(open);
  if (renderedOpen !== open) {
    setRenderedOpen(open);
    setIsDropTarget(false);
    if (open) {
      setJson("");
      setFileName(null);
      setError(null);
      setIsReading(false);
      setConflicts(null);
    }
  }
  // Opening or closing drops any read still in flight.
  useEffect(() => {
    if (!open) return;
    requestRef.current += 1;
    return () => {
      requestRef.current += 1;
    };
  }, [open]);

  const installedIds = () => new Set(customThemeLibrary.themes().map((theme) => theme.id));

  const announce = (themes: ReadonlyArray<ThemeDefinition>, updated: boolean) => {
    const verb = updated ? "updated" : "added";
    toastManager.add({
      type: "success",
      title: themes.length === 1 ? `${themes[0]!.label} ${verb}` : `${themes.length} themes ${verb}`,
      description: themes.map((theme) => theme.label).join(", "),
    });
  };

  /** One theme added from the JSON box becomes the active one, as in T3 Code. */
  const selectImported = (theme: ThemeDefinition) => {
    setThemeId(theme.id);
    const only = theme.variants ? null : theme.appearance;
    toastManager.add({
      type: "success",
      title: `${theme.label} added`,
      description: only ? `It’s now your ${only} theme.` : "It’s now active.",
    });
  };

  const readSingleFile = async (file: File) => {
    const oversized = describeOversizedThemeFile(file.size);
    if (oversized) {
      setError(oversized);
      return;
    }
    const request = ++requestRef.current;
    setIsReading(true);
    let text: string;
    try {
      text = await file.text();
    } catch {
      if (request === requestRef.current) {
        setIsReading(false);
        setError("Could not read that file. Paste the JSON below instead.");
      }
      return;
    }
    if (request !== requestRef.current) return;
    setIsReading(false);
    setJson(text);
    setFileName(file.name);
    setError(null);
  };

  /** Several files go straight in; the ones already installed are offered for Update or Keep both. */
  const installBatch = async (files: ReadonlyArray<File>) => {
    const request = ++requestRef.current;
    setIsReading(true);
    const failures: string[] = [];
    const parsed: Array<{ theme: ThemeDefinition; sourceName: string }> = [];
    for (const file of files) {
      if (describeOversizedThemeFile(file.size)) {
        failures.push(`${file.name}: too large`);
        continue;
      }
      try {
        parsed.push({ sourceName: file.name, theme: parseImportedTheme(JSON.parse(await file.text())) });
      } catch (cause) {
        failures.push(`${file.name}: ${errorMessage(cause, "not a theme file")}`);
      }
    }
    if (request !== requestRef.current) return;
    setIsReading(false);
    const installed: ThemeDefinition[] = [];
    const conflicting: ThemeDefinition[] = [];
    // Light and dark files of one theme ("Nord Light", "Nord Dark") become one theme with both palettes.
    for (const theme of pairVsCodeThemes(resolveThemeLabelCollisions(parsed))) {
      if (installedIds().has(theme.id)) {
        conflicting.push(theme);
        continue;
      }
      try {
        installed.push(customThemeLibrary.install(theme));
      } catch (cause) {
        failures.push(`${theme.label}: ${errorMessage(cause, "could not install")}`);
      }
    }
    if (installed.length > 0) announce(installed, false);
    if (failures.length > 0) setError(failures.join(" — "));
    else if (conflicting.length > 0) setConflicts(conflicting);
    else if (installed.length > 0) onOpenChange(false);
  };

  const readFiles = (files: ReadonlyArray<File>) => {
    if (files.length === 0) return;
    if (files.length === 1) void readSingleFile(files[0]!);
    else void installBatch(files);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    readFiles(files);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDropTarget(false);
    readFiles([...event.dataTransfer.files]);
  };

  const resolveConflicts = (mode: "update" | "copy") => {
    if (!conflicts) return;
    const resolved: ThemeDefinition[] = [];
    const failures: string[] = [];
    const preferredName = conflicts.length === 1 && fileName ? nameFromFileName(fileName) : null;
    for (const theme of conflicts) {
      try {
        if (mode === "update") {
          // An update keeps the installed theme's collection, so it stays on its card.
          const existing = customThemeLibrary.themes().find((candidate) => candidate.id === theme.id);
          resolved.push(
            customThemeLibrary.update(existing?.collection ? { ...theme, collection: existing.collection } : theme),
          );
        } else {
          resolved.push(customThemeLibrary.install(versionedCopy(theme, installedIds(), preferredName)));
        }
      } catch (cause) {
        failures.push(`${theme.label}: ${errorMessage(cause, "failed")}`);
      }
    }
    if (resolved.length > 0) announce(resolved, mode === "update");
    setConflicts(null);
    if (failures.length > 0) setError(failures.join(" — "));
    else onOpenChange(false);
  };

  const handleSubmit = () => {
    const oversized = describeOversizedThemeFile(json.length);
    if (oversized) {
      setError(oversized);
      return;
    }
    try {
      const theme = parseImportedTheme(JSON.parse(json));
      if (installedIds().has(theme.id)) {
        setError(null);
        setConflicts([theme]);
        return;
      }
      selectImported(customThemeLibrary.install(theme));
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof SyntaxError ? "That isn’t valid JSON." : errorMessage(cause, "That theme file is invalid."),
      );
    }
  };

  const dropHandlers = {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDropTarget(true);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDropTarget(true);
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setIsDropTarget(false);
    },
    onDrop: handleDrop,
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Add a theme</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {open ? (
            <ThemeSearchSection
              onInstalled={(themes, { updated }) => {
                announce(themes, updated);
                onOpenChange(false);
              }}
            />
          ) : null}

          <div className="flex items-center gap-3" aria-hidden>
            <div className="h-px flex-1 bg-border" />
            <span className="text-2xs tracking-wider text-muted-foreground uppercase">or import a file</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          {conflicts ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
                <p className="text-sm font-medium">Already installed</p>
                <p className="mt-1 text-xs text-muted-foreground">{conflicts.map((theme) => theme.label).join(", ")}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => resolveConflicts("update")}>
                  Update existing
                </Button>
                <Button size="sm" variant="outline" onClick={() => resolveConflicts("copy")}>
                  Keep both
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConflicts(null)}>
                  Back
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div
                className={cn(
                  "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed px-3 py-3 transition-colors",
                  isDropTarget ? "border-ring bg-accent/20" : "border-border/80 bg-muted/20",
                )}
                {...dropHandlers}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">Theme file</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {fileName ?? "Drop T3 Code or VS Code .json files"}
                  </p>
                </div>
                <Button disabled={isReading} size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
                  <DownloadIcon />
                  {isReading ? "Reading…" : "Choose files"}
                </Button>
                <input
                  ref={fileInputRef}
                  accept=".json,application/json"
                  className="sr-only"
                  multiple
                  onChange={handleFileChange}
                  tabIndex={-1}
                  type="file"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="theme-json-editor">
                  Theme JSON
                </label>
                <ThemeJsonEditor id="theme-json-editor" onChange={setJson} value={json} />
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button disabled={!json.trim() || isReading} onClick={handleSubmit}>
                  <PlusIcon />
                  Add theme
                </Button>
              </div>
            </div>
          )}

          {error ? (
            <Alert aria-live="polite" variant="error">
              {error}
            </Alert>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
