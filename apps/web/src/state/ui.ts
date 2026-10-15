import { storageKey, type TaskStatus } from "@repo/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toggleCell, toggleColumn, type CollapseState } from "~/components/board/columnCollapse.logic";
import { DEFAULT_COLLAPSE, migrateBoardView } from "./boardView.logic";
import { DEFAULT_STAGE_BANNER, type StageBannerChoice } from "~/components/stage/stageBanner.logic";
import {
  moveSection,
  normalizeSectionLayout,
  SECTION_IDS,
  type SectionId,
  type SectionLayout,
  withCollapseChoice,
} from "~/components/task/sections.logic";
import { togglePin, type PinnableAction } from "~/components/task/taskActions.logic";

/** Persisted board view preferences. */
interface BoardViewState extends CollapseState {
  attentionOnly: boolean;
  hasPrOnly: boolean;
  showArchived: boolean;
  /** Free-text card filter from the sidebar search. Not persisted. */
  search: string;
  setAttentionOnly: (value: boolean) => void;
  setHasPrOnly: (value: boolean) => void;
  setShowArchived: (value: boolean) => void;
  /** `mixed`: some shown project differs from the column, so the header collapses them all. */
  toggleColumnCollapsed: (status: TaskStatus, mixed: boolean) => void;
  toggleCellCollapsed: (projectId: string, status: TaskStatus) => void;
  setSearch: (value: string) => void;
}

export const useBoardView = create<BoardViewState>()(
  persist(
    (set) => ({
      attentionOnly: false,
      hasPrOnly: false,
      showArchived: false,
      ...DEFAULT_COLLAPSE,
      search: "",
      setAttentionOnly: (attentionOnly) => set({ attentionOnly }),
      setHasPrOnly: (hasPrOnly) => set({ hasPrOnly }),
      setShowArchived: (showArchived) => set({ showArchived }),
      toggleColumnCollapsed: (status, mixed) => set((s) => toggleColumn(s, status, mixed)),
      toggleCellCollapsed: (projectId, status) => set((s) => toggleCell(s, projectId, status)),
      setSearch: (search) => set({ search }),
    }),
    {
      name: storageKey("board-view"),
      version: 2,
      migrate: migrateBoardView,
      partialize: ({ attentionOnly, hasPrOnly, showArchived, collapsedColumns, cellOverrides }) => ({
        attentionOnly,
        hasPrOnly,
        showArchived,
        collapsedColumns,
        cellOverrides,
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

/** Persisted task panel preferences. */
interface TaskPanelPrefsState {
  /** More-menu actions pinned beside the title. Stored values are re-validated by normalizePins. */
  pinnedActions: PinnableAction[];
  togglePinnedAction: (id: PinnableAction) => void;
  /** Section order, hidden sections and collapse choices. Read through useSectionLayout, which re-validates them. */
  sections: Partial<SectionLayout>;
  /** Choosing the section's default clears the saved choice, so the smart default applies again. */
  setSectionCollapsed: (id: SectionId, collapsed: boolean, byDefault: boolean) => void;
  setAllSectionsCollapsed: (collapsed: boolean) => void;
  moveSection: (id: SectionId, overId: SectionId) => void;
  setSectionHidden: (id: SectionId, hidden: boolean) => void;
  showAllSections: () => void;
  resetSections: () => void;
}

export const useTaskPanelPrefs = create<TaskPanelPrefsState>()(
  persist(
    (set) => {
      const updateSections = (update: (layout: SectionLayout) => Partial<SectionLayout>) =>
        set((s) => {
          const layout = normalizeSectionLayout(s.sections);
          return { sections: { ...layout, ...update(layout) } };
        });
      return {
        pinnedActions: [],
        togglePinnedAction: (id) => set((s) => ({ pinnedActions: togglePin(s.pinnedActions, id) })),
        sections: {},
        setSectionCollapsed: (id, collapsed, byDefault) =>
          updateSections((l) => ({ collapsed: withCollapseChoice(l.collapsed, id, collapsed, byDefault) })),
        setAllSectionsCollapsed: (collapsed) =>
          updateSections(() => ({ collapsed: Object.fromEntries(SECTION_IDS.map((id) => [id, collapsed])) })),
        moveSection: (id, overId) => updateSections((l) => ({ order: moveSection(l.order, id, overId) })),
        setSectionHidden: (id, hidden) =>
          updateSections((l) => ({ hidden: hidden ? [...l.hidden, id] : l.hidden.filter((h) => h !== id) })),
        showAllSections: () => updateSections(() => ({ hidden: [] })),
        resetSections: () => set({ sections: {} }),
      };
    },
    {
      name: storageKey("task-panel"),
      partialize: ({ pinnedActions, sections }) => ({ pinnedActions, sections }),
    },
  ),
);

/** The validated section layout. Memoised on the stored object so selectors stay referentially stable. */
const layoutCache = new WeakMap<object, SectionLayout>();
export function useSectionLayout(): SectionLayout {
  const stored = useTaskPanelPrefs((s) => s.sections);
  let layout = layoutCache.get(stored);
  if (!layout) {
    layout = normalizeSectionLayout(stored);
    layoutCache.set(stored, layout);
  }
  return layout;
}

/** Command palette entry points. Views are pushed onto a stack inside the palette. */
export type PaletteIntent =
  | { kind: "root" }
  | { kind: "add-project" }
  | { kind: "import-t3" }
  /** A task for the Backlog: just a title and description. */
  | { kind: "new-task"; projectId?: string }
  /** A task that opens with the plan editor, to land in Planned. */
  | { kind: "new-planned-task"; projectId?: string }
  | { kind: "go-to-task" };

interface PaletteState {
  open: boolean;
  intent: PaletteIntent;
  /** Last project used for new tasks, preselected next time. */
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
  /** Task whose "Start in T3 Code" dialog is open. */
  t3LaunchTaskId: string | null;
  openProjectSettings: (projectId: string) => void;
  closeProjectSettings: () => void;
  setAppSettingsOpen: (open: boolean) => void;
  openT3Launch: (taskId: string) => void;
  closeT3Launch: () => void;
}

export const useDialogs = create<DialogsState>()((set) => ({
  projectSettingsId: null,
  appSettingsOpen: false,
  t3LaunchTaskId: null,
  openProjectSettings: (projectSettingsId) => set({ projectSettingsId }),
  closeProjectSettings: () => set({ projectSettingsId: null }),
  setAppSettingsOpen: (appSettingsOpen) => set({ appSettingsOpen }),
  openT3Launch: (t3LaunchTaskId) => set({ t3LaunchTaskId }),
  closeT3Launch: () => set({ t3LaunchTaskId: null }),
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
