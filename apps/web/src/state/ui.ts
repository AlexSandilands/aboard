import { storageKey } from "@repo/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_STAGE_BANNER, type StageBannerChoice } from "~/components/stage/stageBanner.logic";

/** Persisted board view preferences. */
interface BoardViewState {
  attentionOnly: boolean;
  hasPrOnly: boolean;
  showArchived: boolean;
  /** Lanes whose Done column is expanded beyond the most recent few. */
  expandedDone: Record<string, boolean>;
  /** Free-text card filter from the sidebar search. Not persisted. */
  search: string;
  setAttentionOnly: (value: boolean) => void;
  setHasPrOnly: (value: boolean) => void;
  setShowArchived: (value: boolean) => void;
  toggleExpandedDone: (projectId: string) => void;
  setSearch: (value: string) => void;
}

export const useBoardView = create<BoardViewState>()(
  persist(
    (set) => ({
      attentionOnly: false,
      hasPrOnly: false,
      showArchived: false,
      expandedDone: {},
      search: "",
      setAttentionOnly: (attentionOnly) => set({ attentionOnly }),
      setHasPrOnly: (hasPrOnly) => set({ hasPrOnly }),
      setShowArchived: (showArchived) => set({ showArchived }),
      toggleExpandedDone: (projectId) =>
        set((s) => ({ expandedDone: { ...s.expandedDone, [projectId]: !s.expandedDone[projectId] } })),
      setSearch: (search) => set({ search }),
    }),
    {
      name: storageKey("board-view"),
      partialize: ({ attentionOnly, hasPrOnly, showArchived, expandedDone }) => ({
        attentionOnly,
        hasPrOnly,
        showArchived,
        expandedDone,
      }),
    },
  ),
);

/** Persisted look-and-feel choices that live in the browser rather than server settings. */
interface AppearanceState {
  /** Art behind the sidebar brand row. Stored values are re-validated by resolveStageBanner. */
  banner: StageBannerChoice;
  setBanner: (banner: StageBannerChoice) => void;
}

export const useAppearance = create<AppearanceState>()(
  persist(
    (set) => ({
      banner: DEFAULT_STAGE_BANNER,
      setBanner: (banner) => set({ banner }),
    }),
    { name: storageKey("appearance"), partialize: ({ banner }) => ({ banner }) },
  ),
);

/** Command palette entry points. Views are pushed onto a stack inside the palette. */
export type PaletteIntent =
  | { kind: "root" }
  | { kind: "add-project" }
  | { kind: "import-t3" }
  | { kind: "new-idea"; projectId?: string }
  | { kind: "new-task"; projectId?: string }
  | { kind: "go-to-task" };

interface PaletteState {
  open: boolean;
  intent: PaletteIntent;
  /** Last project used for new ideas/tasks, preselected next time. */
  lastProjectId: string | null;
  openPalette: (intent?: PaletteIntent) => void;
  closePalette: () => void;
  setLastProjectId: (id: string) => void;
}

export const usePalette = create<PaletteState>()(
  persist(
    (set) => ({
      open: false,
      intent: { kind: "root" },
      lastProjectId: null,
      openPalette: (intent = { kind: "root" }) => set({ open: true, intent }),
      closePalette: () => set({ open: false }),
      setLastProjectId: (lastProjectId) => set({ lastProjectId }),
    }),
    { name: storageKey("palette"), partialize: ({ lastProjectId }) => ({ lastProjectId }) },
  ),
);

/** App-level dialogs opened from anywhere (sidebar gear, palette, panel menus). */
interface DialogsState {
  projectSettingsId: string | null;
  appSettingsOpen: boolean;
  openProjectSettings: (projectId: string) => void;
  closeProjectSettings: () => void;
  setAppSettingsOpen: (open: boolean) => void;
}

export const useDialogs = create<DialogsState>()((set) => ({
  projectSettingsId: null,
  appSettingsOpen: false,
  openProjectSettings: (projectSettingsId) => set({ projectSettingsId }),
  closeProjectSettings: () => set({ projectSettingsId: null }),
  setAppSettingsOpen: (appSettingsOpen) => set({ appSettingsOpen }),
}));

/** Signals the detail panel to focus the plan editor (e.g. after a PLAN_REQUIRED drop). */
interface PanelState {
  planEditorRequest: number;
  requestPlanEditor: () => void;
}

export const usePanel = create<PanelState>()((set) => ({
  planEditorRequest: 0,
  requestPlanEditor: () => set((s) => ({ planEditorRequest: s.planEditorRequest + 1 })),
}));
