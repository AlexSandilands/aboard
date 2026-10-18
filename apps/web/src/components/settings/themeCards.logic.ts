// Adapted from T3 Code (apps/web/src/components/settings/ThemeSettings.tsx), MIT — see NOTICE. How custom themes are
// laid out as cards: one card per theme, or per collection (an Open VSX extension's themes share one card).
import type { ThemeDefinition } from "~/theme/palettes";

/** Custom themes grouped into cards, in the order they were saved. */
export function groupCustomThemes(themes: ReadonlyArray<ThemeDefinition>): Array<[string, ThemeDefinition[]]> {
  const groups = new Map<string, ThemeDefinition[]>();
  for (const theme of themes) {
    const key = theme.collection ? `collection:${theme.collection.id}` : `theme:${theme.id}`;
    const group = groups.get(key);
    if (group) group.push(theme);
    else groups.set(key, [theme]);
  }
  return [...groups.entries()];
}

/**
 * Short names for a collection's variants: the words every label starts with are dropped ("Catppuccin Mocha",
 * "Catppuccin Latte" → "Mocha", "Latte"). A label that would be left empty keeps its full name.
 */
export function collectionVariantLabels(themes: ReadonlyArray<ThemeDefinition>): ReadonlyArray<string> {
  if (themes.length === 0) return [];
  const words = themes.map((theme) => theme.label.trim().split(/\s+/));
  const firstWords = words[0]!;
  const sharedWordCount = firstWords.findIndex((word, index) =>
    words.some((labelWords) => labelWords[index]?.toLocaleLowerCase() !== word.toLocaleLowerCase()),
  );
  const prefixLength = sharedWordCount === -1 ? firstWords.length - 1 : sharedWordCount;
  return themes.map((theme, index) => words[index]?.slice(Math.max(0, prefixLength)).join(" ").trim() || theme.label);
}
