import {
  storageKey,
  type AgentSessionSnapshot,
  type CreateTemplateInput,
  type MergeMethod,
  type TaskStatus,
} from "@repo/contracts";
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
  /** Epic bands folded to their header, by epic id. */
  collapsedEpics: Record<string, true>;
  /** Free-text card filter from the sidebar search. Not persisted. */
  search: string;
  setAttentionOnly: (value: boolean) => void;
  setHasPrOnly: (value: boolean) => void;
  setShowArchived: (value: boolean) => void;
  /** `mixed`: some shown project differs from the column, so the header collapses them all. */
  toggleColumnCollapsed: (status: TaskStatus, mixed: boolean) => void;
  /** `rowId`: a project id for its loose cards, or an epic id for its band. */
  toggleCellCollapsed: (rowId: string, status: TaskStatus) => void;
  toggleEpicCollapsed: (epicId: string) => void;
  /** Drops collapsed epics that are no longer on the board. */
  pruneCollapsedEpics: (epicIds: ReadonlySet<string>) => void;
  setSearch: (value: string) => void;
}

export const useBoardView = create<BoardViewState>()(
  persist(
    (set) => ({
      attentionOnly: false,
      hasPrOnly: false,
      showArchived: false,
      collapsedEpics: {},
      ...DEFAULT_COLLAPSE,
      search: "",
      setAttentionOnly: (attentionOnly) => set({ attentionOnly }),
      setHasPrOnly: (hasPrOnly) => set({ hasPrOnly }),
      setShowArchived: (showArchived) => set({ showArchived }),
      toggleColumnCollapsed: (status, mixed) => set((s) => toggleColumn(s, status, mixed)),
      toggleCellCollapsed: (rowId, status) => set((s) => toggleCell(s, rowId, status)),
      toggleEpicCollapsed: (epicId) =>
        set(({ collapsedEpics: { [epicId]: was, ...rest } }) => ({
          collapsedEpics: was ? rest : { ...rest, [epicId]: true },
        })),
      pruneCollapsedEpics: (epicIds) =>
        set(({ collapsedEpics }) => {
          const kept = Object.keys(collapsedEpics).filter((id) => epicIds.has(id));
          return kept.length === Object.keys(collapsedEpics).length
            ? {}
            : { collapsedEpics: Object.fromEntries(kept.map((id) => [id, true as const])) };
        }),
      setSearch: (search) => set({ search }),
    }),
    {
      name: storageKey("board-view"),
      version: 2,
      migrate: migrateBoardView,
      partialize: ({ attentionOnly, hasPrOnly, showArchived, collapsedEpics, collapsedColumns, cellOverrides }) => ({
        attentionOnly,
        hasPrOnly,
        showArchived,
        collapsedEpics,
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
  /** A task for the Backlog: just a title and description. `epicId` puts it in that epic. */
  | { kind: "new-task"; projectId?: string; epicId?: string }
  /** An epic, which groups tasks. */
  | { kind: "new-epic"; projectId?: string }
  /** A task that opens with the plan editor, to land in Planned. */
  | { kind: "new-planned-task"; projectId?: string; epicId?: string }
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
  /** A section of project settings to scroll to when it opens. */
  projectSettingsSection: "recurring" | null;
  appSettingsOpen: boolean;
  /** The Autopilot digest panel, from the header button or the palette. */
  digestOpen: boolean;
  /** What the open "Start in T3 Code" dialog starts a thread for: a task, or a project's Suggest epics. */
  t3Launch: { kind: "task"; taskId: string } | { kind: "project"; projectId: string } | null;
  /** PR link whose merge dialog is open, from the panel or a card chip. */
  mergePr: { taskId: string; linkId: string } | null;
  /** Agent session the server wouldn't reopen because it is running, with the status it read. */
  sessionWarning: { taskId: string; linkId: string; snapshot: AgentSessionSnapshot | null } | null;
  openProjectSettings: (projectId: string, section?: "recurring") => void;
  closeProjectSettings: () => void;
  setAppSettingsOpen: (open: boolean) => void;
  setDigestOpen: (open: boolean) => void;
  openT3Launch: (taskId: string) => void;
  openProjectT3Launch: (projectId: string) => void;
  closeT3Launch: () => void;
  openMergePr: (taskId: string, linkId: string) => void;
  closeMergePr: () => void;
  openSessionWarning: (warning: NonNullable<DialogsState["sessionWarning"]>) => void;
  closeSessionWarning: () => void;
  /** A template being made outside Settings, e.g. "Save as template" on a task. */
  templateDraft: CreateTemplateInput | null;
  openTemplateDraft: (draft: CreateTemplateInput) => void;
  closeTemplateDraft: () => void;
}

export const useDialogs = create<DialogsState>()((set) => ({
  projectSettingsId: null,
  projectSettingsSection: null,
  appSettingsOpen: false,
  digestOpen: false,
  t3Launch: null,
  mergePr: null,
  sessionWarning: null,
  templateDraft: null,
  openProjectSettings: (projectSettingsId, section) =>
    set({ projectSettingsId, projectSettingsSection: section ?? null }),
  closeProjectSettings: () => set({ projectSettingsId: null, projectSettingsSection: null }),
  setAppSettingsOpen: (appSettingsOpen) => set({ appSettingsOpen }),
  setDigestOpen: (digestOpen) => set({ digestOpen }),
  openT3Launch: (taskId) => set({ t3Launch: { kind: "task", taskId } }),
  openProjectT3Launch: (projectId) => set({ t3Launch: { kind: "project", projectId } }),
  closeT3Launch: () => set({ t3Launch: null }),
  openMergePr: (taskId, linkId) => set({ mergePr: { taskId, linkId } }),
  closeMergePr: () => set({ mergePr: null }),
  openSessionWarning: (sessionWarning) => set({ sessionWarning }),
  closeSessionWarning: () => set({ sessionWarning: null }),
  openTemplateDraft: (templateDraft) => set({ templateDraft }),
  closeTemplateDraft: () => set({ templateDraft: null }),
}));

/** The merge method last picked per repo (`host/owner/repo`), offered first next time. */
interface MergeMethodState {
  lastByRepo: Record<string, MergeMethod>;
  remember: (repoKey: string, method: MergeMethod) => void;
}

export const useMergeMethods = create<MergeMethodState>()(
  persist(
    (set) => ({
      lastByRepo: {},
      remember: (repoKey, method) => set((s) => ({ lastByRepo: { ...s.lastByRepo, [repoKey]: method } })),
    }),
    { name: storageKey("merge-methods") },
  ),
);

/** Signals the detail panel to focus the plan editor (e.g. after a PLAN_REQUIRED drop). */
interface PanelState {
  planEditorRequest: number;
  requestPlanEditor: () => void;
}

export const usePanel = create<PanelState>()((set) => ({
  planEditorRequest: 0,
  requestPlanEditor: () => set((s) => ({ planEditorRequest: s.planEditorRequest + 1 })),
}));
