// Adapted from T3 Code (apps/web/src/components/settings/ThemeEditorHost.tsx), MIT — see NOTICE. Mounted in the app
// shell so the editor survives leaving Settings: you can open the board and inspect it while editing.
import { lazy, Suspense } from "react";
import { toastManager } from "~/components/ui/toast";
import { useTheme } from "~/hooks/useTheme";
import type { ThemeDefinition } from "~/theme/palettes";
import { findTheme, themeOwners } from "~/theme/themeState.logic";
import type { ThemeSaveResult } from "./ThemeEditorPanel";
import { useThemeEditorStore } from "./themeEditorStore";

const ThemeEditorPanel = lazy(() =>
  import("./ThemeEditorPanel").then((module) => ({ default: module.ThemeEditorPanel })),
);

export function ThemeEditorHost() {
  const session = useThemeEditorStore((store) => store.session);
  const closeThemeEditor = useThemeEditorStore((store) => store.closeThemeEditor);
  const { theme: mode, themeId, themeHalves, customThemes, setThemeId } = useTheme();
  if (!session) return null;

  const handleSaved = (saved: ThemeDefinition, { created, mergedAppearance }: ThemeSaveResult) => {
    if (mergedAppearance) {
      setThemeId(saved.id);
      toastManager.add({
        type: "success",
        title: `${saved.label} updated`,
        description: `Its ${mergedAppearance} palette was added.`,
      });
      return;
    }
    if (!created) {
      // Saving already re-applied the theme; the selection is left alone, since selecting would clear a light/dark mix.
      const owners = themeOwners({ mode, themeId, halves: themeHalves }, customThemes);
      const wasActive = owners.light === saved.id || owners.dark === saved.id;
      toastManager.add({
        type: "success",
        title: `${saved.label} saved`,
        description: wasActive ? "Your changes are now active." : "Your changes are saved.",
      });
      return;
    }
    setThemeId(saved.id);
    toastManager.add({ type: "success", title: `${saved.label} created`, description: "It’s now active." });
  };

  return (
    <Suspense fallback={null}>
      <ThemeEditorPanel
        editingTheme={findTheme(session.editingThemeId, customThemes)}
        initialAppearance={session.initialAppearance}
        key={session.id}
        onClose={closeThemeEditor}
        onSaved={handleSaved}
        seedName={session.seedName}
        seedTheme={findTheme(session.seedThemeId, customThemes)}
      />
    </Suspense>
  );
}
