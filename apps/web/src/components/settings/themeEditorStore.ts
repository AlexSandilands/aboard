// Copied from T3 Code (apps/web/src/components/settings/themeEditorStore.ts), MIT — see NOTICE. Which theme the
// floating editor is open on. It lives outside Settings so the editor stays open while you look at the board.
import { create } from "zustand";
import type { ThemeAppearance } from "~/theme/palettes";

export type ThemeEditorSessionInput = {
  /** The custom theme being edited, or null to create one. */
  editingThemeId: string | null;
  /** The theme a new one starts from (Duplicate, or the active theme for Create theme); null is T3 Code. */
  seedThemeId: string | null;
  seedName: string | null;
  initialAppearance: ThemeAppearance;
};

export type ThemeEditorSession = ThemeEditorSessionInput & { id: number };

type ThemeEditorStore = {
  session: ThemeEditorSession | null;
  openThemeEditor: (session: ThemeEditorSessionInput) => void;
  closeThemeEditor: () => void;
};

let nextSessionId = 0;

export const useThemeEditorStore = create<ThemeEditorStore>((set) => ({
  session: null,
  // A fresh id per open, so the panel remounts and reseeds even when it was already open on the same theme.
  openThemeEditor: (session) => set({ session: { ...session, id: ++nextSessionId } }),
  closeThemeEditor: () => set({ session: null }),
}));
