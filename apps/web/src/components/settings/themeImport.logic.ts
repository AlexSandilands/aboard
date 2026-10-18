// Adapted from T3 Code (apps/web/src/components/settings/ThemeImportDialog.tsx), MIT — see NOTICE. The pure parts of
// adding themes from files or pasted JSON.
import type { ThemeDefinition } from "~/theme/palettes";
import { parseThemeFile, THEME_FILE_VERSION } from "~/theme/themeFile";
import { humanizeThemeName, isVsCodeThemeFile, parseVsCodeThemeFile } from "~/theme/vscodeThemeImport";

/**
 * Checked on the size before a file is read: a large file would otherwise be pulled into memory and highlighted, which
 * locks the page for as long as that takes.
 */
export const MAX_THEME_FILE_BYTES = 256 * 1024;

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

export function describeOversizedThemeFile(bytes: number): string | null {
  if (bytes <= MAX_THEME_FILE_BYTES) return null;
  return `That file is ${formatByteSize(bytes)}. Theme files are only a few KB, so this one was not read (limit ${formatByteSize(MAX_THEME_FILE_BYTES)}).`;
}

/** A theme from a decoded JSON file: a T3 Code theme file, or a VS Code colour theme converted. */
export function parseImportedTheme(value: unknown): ThemeDefinition {
  return isVsCodeThemeFile(value) ? parseVsCodeThemeFile(value) : parseThemeFile(value);
}

/**
 * "Keep both": the theme under a name whose id is free. A single dropped file tries its file name first (themes often
 * share a display name across files); otherwise "Name (1)", "Name (2)" and so on.
 */
export function versionedCopy(
  theme: ThemeDefinition,
  takenIds: ReadonlySet<string>,
  preferredName?: string | null,
): ThemeDefinition {
  const copyNamed = (name: string) =>
    parseThemeFile({
      version: THEME_FILE_VERSION,
      name,
      appearance: theme.appearance,
      colors: theme.colors,
      ...(theme.variants ? { variants: theme.variants } : {}),
      ...(theme.managed ? { managed: true } : {}),
    });
  if (preferredName && preferredName.toLowerCase() !== theme.label.toLowerCase()) {
    const candidate = copyNamed(preferredName.slice(0, 48));
    if (!takenIds.has(candidate.id)) return candidate;
  }
  for (let copy = 1; copy < 100; copy += 1) {
    const suffix = ` (${copy})`;
    const candidate = copyNamed(`${theme.label.slice(0, 48 - suffix.length)}${suffix}`);
    if (!takenIds.has(candidate.id)) return candidate;
  }
  throw new Error(`Too many copies of "${theme.label}".`);
}

/** The name a file suggests for its theme: "tokyo-night-storm.json" → "Tokyo Night Storm". */
export function nameFromFileName(fileName: string): string {
  return humanizeThemeName(fileName.replace(/\.[^.]+$/, ""));
}

/** JSON as HTML with token colours from the active theme. Escapes everything it doesn't wrap. */
export function highlightJson(value: string): string {
  const escape = (text: string) =>
    text.replace(
      /[&<>"']/g,
      (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character,
    );
  const tokenPattern = /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;
  let highlighted = "";
  let cursor = 0;
  for (const match of value.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    highlighted += escape(value.slice(cursor, index));
    let tokenClass = "text-[var(--app-theme-secondary-foreground,var(--color-amber-600))]";
    if (token.startsWith('"')) {
      tokenClass = /^\s*:/.test(value.slice(index + token.length))
        ? "text-[var(--app-theme-accent,var(--color-blue-600))]"
        : "text-[var(--app-theme-message-action,var(--color-emerald-600))]";
    } else if (token === "true" || token === "false" || token === "null") {
      tokenClass = "text-[var(--app-theme-accent-surface-foreground,var(--color-violet-600))]";
    }
    highlighted += `<span class="${tokenClass}">${escape(token)}</span>`;
    cursor = index + token.length;
  }
  return highlighted + escape(value.slice(cursor));
}
