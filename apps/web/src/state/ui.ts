import {
  storageKey,
  type AgentHarness,
  type AgentSessionSnapshot,
  type CreateTemplateInput,
  type MergeMethod,
  type TaskStatus,
} from "@repo/contracts";
import { create } from "zustand";
import type { BoardSearch } from "~/router";
import { persist } from "zustand/middleware";
import { togglePicked } from "~/components/board/boardSelection.logic";
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
import {
  DEFAULT_PINS,
  migrateTaskPanelPrefs,
  togglePin,
  type PinnableAction,
} from "~/components/task/taskActions.logic";
import { DEFAULT_APPEARANCE_PREFS, normalizeAppearancePrefs, type AppearancePrefs } from "~/theme/appearance.logic";

/** Persisted board view preferences. The filters are not here: they are the board's URL params. */
interface BoardViewState extends CollapseState {
  /** Priority tasks gather in a lane above the projects. Off, they stay in their own lanes. */
  showPriorityLane: boolean;
  /** The lane's Autopilot pill counts down to Orchestrate's next check while it is on in the project. */
  showAutopilotTimer: boolean;
  /** Epic bands folded to their header, by epic id. */
  collapsedEpics: Record<string, true>;
  setShowPriorityLane: (value: boolean) => void;
  setShowAutopilotTimer: (value: boolean) => void;
  /** `mixed`: some shown project differs from the column, so the header collapses them all. */
  toggleColumnCollapsed: (status: TaskStatus, mixed: boolean) => void;
  /** `rowId`: a project id for its loose cards, or an epic id for its band. */
  toggleCellCollapsed: (rowId: string, status: TaskStatus) => void;
  toggleEpicCollapsed: (epicId: string) => void;
  /** Drops collapsed epics that are no longer on the board. */
  pruneCollapsedEpics: (epicIds: ReadonlySet<string>) => void;
}

export const useBoardView = create<BoardViewState>()(
  persist(
    (set) => ({
      showPriorityLane: true,
      showAutopilotTimer: true,
      collapsedEpics: {},
      ...DEFAULT_COLLAPSE,
      setShowPriorityLane: (showPriorityLane) => set({ showPriorityLane }),
      setShowAutopilotTimer: (showAutopilotTimer) => set({ showAutopilotTimer }),
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
    }),
    {
      name: storageKey("board-view"),
      version: 2,
      migrate: migrateBoardView,
      partialize: ({ showPriorityLane, showAutopilotTimer, collapsedEpics, collapsedColumns, cellOverrides }) => ({
        showPriorityLane,
        showAutopilotTimer,
        collapsedEpics,
        collapsedColumns,
        cellOverrides,
      }),
    },
  ),
);

/** Cards picked with Ctrl/⌘-click to plan together. Not persisted: a pick is for the moment. */
interface BoardPickState {
  picked: string[];
  togglePicked: (taskId: string) => void;
  clearPicked: () => void;
}

export const useBoardPick = create<BoardPickState>()((set) => ({
  picked: [],
  togglePicked: (taskId) => set((s) => ({ picked: togglePicked(s.picked, taskId) })),
  clearPicked: () => set((s) => (s.picked.length ? { picked: [] } : s)),
}));

/** Where a bulk planning session starts: a T3 Code thread, a CLI in a terminal, or a prompt on the clipboard. */
export type PlanTarget = { kind: "t3" } | { kind: "session"; harness: AgentHarness } | { kind: "copy" };

/**
 * Persisted look-and-feel choices that live in the browser rather than server settings. The contrast, glass,
 * animation and font prefs are applied to the page by theme/appearance.ts; the theme itself is in hooks/useTheme.ts.
 */
interface AppearanceState extends AppearancePrefs {
  /** Art behind the sidebar brand row. Stored values are re-validated by resolveStageBanner. */
  banner: StageBannerChoice;
  setBanner: (banner: StageBannerChoice) => void;
  /** Opening a task from outside the board (search, a link, a notification) scrolls the board to its card. */
  scrollToTask: boolean;
  setScrollToTask: (value: boolean) => void;
  /** Sets one or more of the prefs; values are clamped to their ranges. */
  setPrefs: (prefs: Partial<AppearancePrefs>) => void;
}

const prefsOf = (s: AppearancePrefs): AppearancePrefs => ({
  contrast: s.contrast,
  glassOpacity: s.glassOpacity,
  panelAnimationMs: s.panelAnimationMs,
  fontSans: s.fontSans,
  fontMono: s.fontMono,
  fontSize: s.fontSize,
});

export const useAppearance = create<AppearanceState>()(
  persist(
    (set) => ({
      banner: DEFAULT_STAGE_BANNER,
      setBanner: (banner) => set({ banner }),
      scrollToTask: true,
      setScrollToTask: (scrollToTask) => set({ scrollToTask }),
      ...DEFAULT_APPEARANCE_PREFS,
      setPrefs: (prefs) => set((s) => normalizeAppearancePrefs({ ...prefsOf(s), ...prefs })),
    }),
    {
      name: storageKey("appearance"),
      partialize: (s) => ({ banner: s.banner, scrollToTask: s.scrollToTask, ...prefsOf(s) }),
      // Saves from before these prefs have none; a hand-edited one may be out of range.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<AppearanceState>;
        return { ...current, ...saved, ...normalizeAppearancePrefs({ ...prefsOf(current), ...saved }) };
      },
    },
  ),
);

/**
 * A request to bring a task's card into view on the board, made when a task is opened from outside the board or by
 * the panel's jump action. The board acts on it once it can show the card. `nonce` repeats a reveal of the same
 * task; `at` lets a request nobody could fulfil expire rather than fire on some later board. `explicit` marks one the
 * user asked for (it ignores the scroll setting and explains itself when the card can't be shown). Not persisted.
 */
interface RevealState {
  request: { taskId: string; nonce: number; at: number; explicit: boolean } | null;
  requestReveal: (taskId: string, options?: { explicit?: boolean }) => void;
  /** The board is done with a request (shown, hidden or expired), so a remounted board doesn't act on it again. */
  consumeReveal: (nonce: number) => void;
}

let revealNonce = 0;

export const useReveal = create<RevealState>()((set) => ({
  request: null,
  requestReveal: (taskId, options) => {
    const explicit = options?.explicit ?? false;
    if (!explicit && !useAppearance.getState().scrollToTask) return;
    set({ request: { taskId, nonce: ++revealNonce, at: Date.now(), explicit } });
  },
  consumeReveal: (nonce) => set((s) => (s.request?.nonce === nonce ? { request: null } : {})),
}));

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
        pinnedActions: [...DEFAULT_PINS],
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
      version: 1,
      migrate: migrateTaskPanelPrefs,
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

/** App-level dialogs opened from anywhere (header buttons, palette, panel menus). */
interface DialogsState {
  /** The Autopilot digest panel, from the header button or the palette. */
  digestOpen: boolean;
  /**
   * What the open "Start in T3 Code" dialog starts a thread for: a task (with `fixLinkId`, to fix that PR link: "Fix in →"),
   * or a project's Suggest epics.
   */
  t3Launch:
    | { kind: "task"; taskId: string; fixLinkId?: string }
    | { kind: "project"; projectId: string }
    /** A thread that plans several of the project's tasks, linked to each. */
    | { kind: "plan"; projectId: string; taskIds: string[] }
    | null;
  /** The open "New Claude Code / Copilot session" dialog: the task and the CLI it starts, and the PR link it fixes. */
  sessionLaunch: { taskId: string; harness: AgentHarness; fixLinkId?: string } | null;
  /** "Plan tasks…": the picker of the project's tasks to plan, and where the session starts once they are picked. */
  planPicker: { projectId: string; target: PlanTarget } | null;
  /** The new CLI session that plans the picked tasks. */
  planSession: { projectId: string; taskIds: string[]; harness: AgentHarness } | null;
  /** PR link whose merge dialog is open, from the panel or a card chip. */
  mergePr: { taskId: string; linkId: string } | null;
  /** Agent session the server wouldn't reopen because it is running, with the status it read. */
  sessionWarning: { taskId: string; linkId: string; snapshot: AgentSessionSnapshot | null } | null;
  /** The save or rename dialog for a saved view: `save` stores the board's current filters, `rename` renames the view. */
  viewDialog: { kind: "save" } | { kind: "rename"; viewId: string } | null;
  setDigestOpen: (open: boolean) => void;
  openViewDialog: (dialog: NonNullable<DialogsState["viewDialog"]>) => void;
  closeViewDialog: () => void;
  openT3Launch: (taskId: string, fixLinkId?: string) => void;
  openProjectT3Launch: (projectId: string) => void;
  openPlanT3Launch: (projectId: string, taskIds: string[]) => void;
  openPlanPicker: (projectId: string, target: PlanTarget) => void;
  closePlanPicker: () => void;
  openPlanSession: (projectId: string, taskIds: string[], harness: AgentHarness) => void;
  closePlanSession: () => void;
  closeT3Launch: () => void;
  openSessionLaunch: (taskId: string, harness: AgentHarness, fixLinkId?: string) => void;
  closeSessionLaunch: () => void;
  openMergePr: (taskId: string, linkId: string) => void;
  closeMergePr: () => void;
  openSessionWarning: (warning: NonNullable<DialogsState["sessionWarning"]>) => void;
  closeSessionWarning: () => void;
  /** A template being made outside Settings, e.g. "Save as template" on a task. */
  templateDraft: CreateTemplateInput | null;
  openTemplateDraft: (draft: CreateTemplateInput) => void;
  closeTemplateDraft: () => void;
  /** The pasted image open in the preview. */
  imagePreview: { id: string; filename: string } | null;
  openImagePreview: (image: { id: string; filename: string }) => void;
  closeImagePreview: () => void;
}

/** True while any of the app's dialogs is open (what the `dialogOpen` shortcut condition means). */
export function anyDialogOpen(state: DialogsState): boolean {
  return (
    state.digestOpen ||
    state.viewDialog !== null ||
    state.t3Launch !== null ||
    state.planPicker !== null ||
    state.planSession !== null ||
    state.mergePr !== null ||
    state.sessionWarning !== null ||
    state.templateDraft !== null ||
    state.imagePreview !== null
  );
}

export const useDialogs = create<DialogsState>()((set) => ({
  digestOpen: false,
  viewDialog: null,
  t3Launch: null,
  sessionLaunch: null,
  planPicker: null,
  planSession: null,
  mergePr: null,
  sessionWarning: null,
  templateDraft: null,
  imagePreview: null,
  setDigestOpen: (digestOpen) => set({ digestOpen }),
  openViewDialog: (viewDialog) => set({ viewDialog }),
  closeViewDialog: () => set({ viewDialog: null }),
  openT3Launch: (taskId, fixLinkId) => set({ t3Launch: { kind: "task", taskId, ...(fixLinkId ? { fixLinkId } : {}) } }),
  openProjectT3Launch: (projectId) => set({ t3Launch: { kind: "project", projectId } }),
  openPlanT3Launch: (projectId, taskIds) => set({ t3Launch: { kind: "plan", projectId, taskIds } }),
  openPlanPicker: (projectId, target) => set({ planPicker: { projectId, target } }),
  closePlanPicker: () => set({ planPicker: null }),
  openPlanSession: (projectId, taskIds, harness) => set({ planSession: { projectId, taskIds, harness } }),
  closePlanSession: () => set({ planSession: null }),
  closeT3Launch: () => set({ t3Launch: null }),
  openSessionLaunch: (taskId, harness, fixLinkId) =>
    set({ sessionLaunch: { taskId, harness, ...(fixLinkId ? { fixLinkId } : {}) } }),
  closeSessionLaunch: () => set({ sessionLaunch: null }),
  openMergePr: (taskId, linkId) => set({ mergePr: { taskId, linkId } }),
  closeMergePr: () => set({ mergePr: null }),
  openSessionWarning: (sessionWarning) => set({ sessionWarning }),
  closeSessionWarning: () => set({ sessionWarning: null }),
  openTemplateDraft: (templateDraft) => set({ templateDraft }),
  closeTemplateDraft: () => set({ templateDraft: null }),
  openImagePreview: (imagePreview) => set({ imagePreview }),
  closeImagePreview: () => set({ imagePreview: null }),
}));

/** The settings page's scroll state, shared by its sidebar list and the page. Not persisted. */
interface SettingsNavState {
  /** The section in view (scroll-spy), highlighted in the list. */
  activeSection: string | null;
  /**
   * A section or row to bring into view once it renders. `nonce` repeats a scroll to the same target; `at` lets a
   * request nobody could fulfil expire rather than fire on some later page. `highlight` flashes the element once
   * it is in view (a pick from settings search).
   */
  scrollTarget: { id: string; nonce: number; at: number; highlight: boolean } | null;
  /** The board's search when Settings opened, so Back returns to the same view. */
  boardReturn: BoardSearch;
  setActiveSection: (id: string | null) => void;
  requestScroll: (id: string, highlight?: boolean) => void;
  setBoardReturn: (search: BoardSearch) => void;
}

export const useSettingsNav = create<SettingsNavState>()((set) => ({
  activeSection: null,
  scrollTarget: null,
  boardReturn: {},
  setActiveSection: (activeSection) => set({ activeSection }),
  requestScroll: (id, highlight = false) =>
    set((s) => ({ scrollTarget: { id, nonce: (s.scrollTarget?.nonce ?? 0) + 1, at: Date.now(), highlight } })),
  setBoardReturn: (boardReturn) => set({ boardReturn }),
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
