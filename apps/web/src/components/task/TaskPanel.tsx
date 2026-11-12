import { storageKey, type Project, type TaskDetail } from "@repo/contracts";
import { FileQuestionIcon, Maximize2Icon, XIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

import { Button } from "~/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Skeleton } from "~/components/ui/skeleton";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth, type ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { ApiError } from "~/lib/api";
import { boardTransitionRunning } from "~/lib/boardMotion";
import { slideDuration, slideOffset, slidesOn, startSlide } from "~/lib/slide";
import { useBoard, useTaskDetail } from "~/state/queries";
import { useTaskView } from "~/state/taskView";
import { usePanel, useSectionLayout } from "~/state/ui";
import { cn } from "~/lib/utils";
import { AutopilotSection } from "~/components/autopilot/AutopilotSection";
import { LabelsSection } from "~/components/labels/LabelsSection";
import { ReviewSection } from "~/components/review/ReviewSection";
import { ActivityLog } from "./ActivityLog";
import { AttentionRequestCallout } from "./AttentionRequestCallout";
import { LinksSection } from "./LinksSection";
import { DetailsSection } from "./DetailsSection";
import { ImportCallout } from "./ImportCallout";
import { ManagedSections } from "./ManagedSections";
import { PanelTaskLinksProvider } from "./PanelTaskLinks";
import { PlanEditor, type PlanEditorMode } from "./PlanEditor";
import { PlanTimeline } from "./PlanTimeline";
import { RelationsSection } from "./RelationsSection";
import { ResolutionCallout } from "./ResolutionCallout";
import { SessionsSection } from "./SessionsSection";
import { UsageSection } from "./UsageSection";
import { TaskActions } from "./TaskActions";
import { ClosePanelButton, PANEL_TOP_BAR_CLASS, TaskPanelHeader, WINDOW_TOP_BAR_CLASS } from "./TaskPanelHeader";
import { TaskTitle } from "./TaskTitle";
import { usePlanActions } from "./usePlanActions";
import { WhereItsUpTo } from "./WhereItsUpTo";
import { EpicChildren } from "./EpicChildren";
import { useEpicFilter, useSetEpicFilter } from "~/components/board/boardNavigation";
import { splitsIntoColumns, type SectionId, type TaskPanelLayout } from "./sections.logic";
import { TaskLayoutContext } from "./taskLayout";

const MIN_WIDTH = 380;
const DEFAULT_WIDTH = 540;
const EMPTY_PROJECTS: ReadonlyArray<Project> = [];
/** An epic has no plan and isn't reviewed itself (its children are). Its Autopilot section shows runs only: no flags or priority. */
const EPIC_HIDDEN_SECTIONS: ReadonlyArray<SectionId> = ["plan", "review"];

/**
 * Highest usePanel.planEditorRequest already acted on. Module-level so a request made just
 * before the panel mounts (e.g. a "Write plan" toast that also opens the panel) is still seen.
 */
let handledPlanEditorRequest = 0;

/**
 * Docked, resizable task detail panel for `?task=<id>`. `closing` plays the slide-out, after which
 * `onClosed` lets the parent unmount it. While the task shows in the task window (`inWindow`) the panel keeps its
 * width with a placeholder, so the board doesn't reflow, and the task's contents live in the window alone: they have
 * side effects that must run once (`useTaskView`, the plan editor request).
 */
export function TaskPanel({
  taskId,
  inWindow = false,
  closing = false,
  slideIn = true,
  onClose,
  onClosed,
}: {
  taskId: string;
  inWindow?: boolean;
  closing?: boolean;
  /** False for a panel that is restored, not opened (see `panelRestored`): it appears in place. Closing still slides. */
  slideIn?: boolean;
  onClose: () => void;
  onClosed?: () => void;
}) {
  const maxWidth = Math.max(MIN_WIDTH, Math.round((typeof window === "undefined" ? 1600 : window.innerWidth) * 0.7));
  const { width, handlers } = useResizableWidth({
    storageKey: storageKey("panel-width"),
    defaultWidth: DEFAULT_WIDTH,
    minWidth: MIN_WIDTH,
    maxWidth,
    edge: "left",
  });

  const asideRef = useRef<HTMLElement>(null);
  const contentsRef = useRef<HTMLDivElement>(null);
  usePanelSlide(asideRef, contentsRef, closing, slideIn, onClosed);

  return (
    <aside
      ref={asideRef}
      aria-label="Task details"
      data-task-panel
      aria-hidden={closing || undefined}
      inert={closing}
      className="relative flex h-full min-h-0 max-w-[70vw] shrink-0"
      style={{ [RESIZABLE_WIDTH_PROPERTY]: `${width}px`, width: `var(${RESIZABLE_WIDTH_PROPERTY})` } as CSSProperties}
    >
      <ResizeHandle handlers={handlers} />
      {/* Keeps the contents at the panel's full width (at least MIN_WIDTH) and is the container the @ queries see.
          Pinned to the right edge, so it slides on its own transform while the aside's width opens the board up. */}
      <div
        ref={contentsRef}
        data-panel-contents=""
        className="@container absolute inset-y-0 right-0 flex min-h-0 max-w-[70vw] flex-col border-l border-border bg-background"
        style={{ width: `var(${RESIZABLE_WIDTH_PROPERTY})`, minWidth: MIN_WIDTH }}
      >
        {inWindow ? <InWindowPlaceholder /> : <TaskPanelContent key={taskId} taskId={taskId} onClose={onClose} />}
      </div>
    </aside>
  );
}

/**
 * Slides the panel in from the window's right edge when it mounts and out again when `closing`, then calls
 * `onClosed`, with the board making room at the same time (see `lib/slide.ts`): the aside is the room and the
 * contents, pinned to its right edge, the mover. A toggle mid-slide turns around from where the panel is.
 */
function usePanelSlide(
  asideRef: RefObject<HTMLElement | null>,
  contentsRef: RefObject<HTMLElement | null>,
  closing: boolean,
  slideIn: boolean,
  onClosed?: () => void,
) {
  const closed = useEffectEvent(() => onClosed?.());
  // Only the mount's value counts: the opening is the one slide a restored panel skips.
  const [skipOpening] = useState(!slideIn);
  useLayoutEffect(() => {
    const aside = asideRef.current;
    const contents = contentsRef.current;
    if (!aside || !contents) return;
    // Only the mount's opening is skipped: a slide already running or held (the panel closing, then reopened before it
    // left) is turned around as usual.
    if (skipOpening && !closing && slidesOn(contents, aside).length === 0) return;
    // In a board transition the router's View Transition moves the panel and the board (index.css).
    const duration = boardTransitionRunning() ? 0 : slideDuration();
    if (duration === 0) {
      if (closing) closed();
      return;
    }
    const width = contents.offsetWidth;
    // How far the contents sit right of where they rest; the aside is that much narrower.
    const from = slidesOn(contents, aside).length > 0 ? slideOffset(contents) : closing ? 0 : width;
    const to = closing ? width : 0;
    const { slide } = startSlide({
      mover: contents,
      room: aside,
      from,
      to,
      roomFrom: width - from,
      roomTo: width - to,
      width,
      duration,
      // Closed, it stays out of view until AppLayout unmounts it.
      fill: closing,
    });
    if (closing) slide.addEventListener("finish", () => closed());
  }, [asideRef, contentsRef, closing, skipOpening]);
}

// Adapted from T3 Code (preview/RightPanelResizeHandle.tsx), MIT — see NOTICE.
function ResizeHandle({ handlers }: { handlers: ResizableWidthHandlers }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize task panel"
      className="group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize select-none"
      {...handlers}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-primary/60"
      />
    </div>
  );
}

/** What the docked panel shows behind the task window, which has the task. */
function InWindowPlaceholder() {
  return (
    <div
      data-in-window-placeholder=""
      className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground"
    >
      <Maximize2Icon className="size-4" />
      Open in a window
    </div>
  );
}

/**
 * The task's details: the top bar, the body and the plan editor. Rendered once, in the docked panel or in the task
 * window (`layout`), never both.
 */
export function TaskPanelContent({
  taskId,
  layout = "panel",
  onClose,
  onDock,
}: {
  taskId: string;
  layout?: TaskPanelLayout;
  onClose: () => void;
  /** The window's Dock button. */
  onDock?: () => void;
}) {
  const detail = useTaskDetail(taskId);
  useTaskView(taskId, detail.data?.links.some((l) => l.kind === "pr" && l.ref !== null) ?? false);
  const projects = useBoard().data?.projects ?? EMPTY_PROJECTS;
  const [editor, setEditor] = useState<{ open: boolean; mode: PlanEditorMode; session: number }>({
    open: false,
    mode: "outline",
    session: 0,
  });
  const openEditor = (mode: PlanEditorMode) => setEditor((e) => ({ open: true, mode, session: e.session + 1 }));

  // The board asks for the plan editor after a PLAN_REQUIRED drop; it opens once the detail loads.
  const planEditorRequest = usePanel((s) => s.planEditorRequest);
  const [seenPlanEditorRequest, setSeenPlanEditorRequest] = useState(handledPlanEditorRequest);
  if (planEditorRequest > seenPlanEditorRequest) {
    setSeenPlanEditorRequest(planEditorRequest);
    setEditor((e) => ({ open: true, mode: "outline", session: e.session + 1 }));
  }
  useEffect(() => {
    handledPlanEditorRequest = Math.max(handledPlanEditorRequest, seenPlanEditorRequest);
  }, [seenPlanEditorRequest]);

  if (detail.isPending) return <PanelSkeleton layout={layout} onClose={onClose} />;
  if (detail.isError && !detail.data) {
    const notFound = detail.error instanceof ApiError && detail.error.code === "NOT_FOUND";
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileQuestionIcon />
          </EmptyMedia>
          <EmptyTitle>{notFound ? "Task not found" : "Couldn't load task"}</EmptyTitle>
          <EmptyDescription>
            {notFound ? "It may have been deleted or the link is out of date." : detail.error.message}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex gap-2">
            {notFound ? null : (
              <Button size="sm" variant="outline" onClick={() => void detail.refetch()}>
                Retry
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={onClose}>
              <XIcon />
              Close
            </Button>
          </div>
        </EmptyContent>
      </Empty>
    );
  }

  const task = detail.data;
  const openPlanEditor = () => openEditor("outline");
  return (
    <>
      <TaskPanelHeader
        task={task}
        layout={layout}
        onClose={onClose}
        onDock={onDock}
        onOpenPlanEditor={openPlanEditor}
      />
      <div className="min-h-0 flex-1">
        <PanelTaskLinksProvider>
          <TaskPanelBody
            task={task}
            layout={layout}
            projects={projects}
            onOpenEditor={openEditor}
            titleActions={
              <TaskActions task={task} projects={projects} onClose={onClose} onOpenPlanEditor={openPlanEditor} />
            }
          />
        </PanelTaskLinksProvider>
      </div>
      <PlanEditor
        task={task}
        open={editor.open}
        mode={editor.mode}
        session={editor.session}
        onOpenChange={(open) => setEditor((e) => ({ ...e, open }))}
      />
    </>
  );
}

/** The task window's width from which the sections split into two columns: about 56rem. */
const TWO_COLUMNS_FROM = 896;

/**
 * Whether the element is at least `px` wide, following its resizes. Its layout width, not its box on screen: the task
 * window mounts transformed onto its card or the docked panel (`lib/windowZoom.ts`), and a transform fires no resize.
 */
function useWiderThan(ref: RefObject<HTMLElement | null>, px: number, enabled: boolean): boolean {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const update = () => setWide(element.offsetWidth >= px);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, px, enabled]);
  return enabled && wide;
}

/**
 * Each column's scrollbar starts right at the header's bottom line, meeting the rail's border, instead of the usual
 * inset at the top.
 */
const COLUMN_SCROLLBAR_CLASS = "[&>[data-slot=scroll-area-scrollbar][data-orientation=vertical]]:mt-0";

function TaskPanelBody({
  task,
  layout,
  projects,
  onOpenEditor,
  titleActions,
}: {
  task: TaskDetail;
  layout: TaskPanelLayout;
  projects: ReadonlyArray<Project>;
  onOpenEditor: (mode: PlanEditorMode) => void;
  titleActions: ReactNode;
}) {
  const actions = usePlanActions(task.id);
  const setEpicFilter = useSetEpicFilter();
  const boardEpicFilter = useEpicFilter();
  const rootRef = useRef<HTMLDivElement>(null);
  const inWindow = layout === "window";
  // Layout A: the story in a main column and the properties in a rail beside it, each scrolling on its own so the rail
  // is always in view. Narrower, one column in the panel's saved order, as the docked panel has it.
  const wide = useWiderThan(rootRef, TWO_COLUMNS_FROM, inWindow);
  const exclude = task.kind === "epic" ? EPIC_HIDDEN_SECTIONS : undefined;
  const sections = useSectionLayout();
  // With every shown section in one column, one column rather than an empty strip beside it.
  const twoColumns = wide && splitsIntoColumns(sections, exclude);
  const render = (id: SectionId) => {
    switch (id) {
      case "labels":
        return <LabelsSection task={task} />;
      case "sessions":
        return <SessionsSection task={task} />;
      case "usage":
        return <UsageSection task={task} />;
      case "links":
        return <LinksSection task={task} />;
      case "relations":
        return <RelationsSection task={task} />;
      case "review":
        return <ReviewSection task={task} />;
      case "autopilot":
        return <AutopilotSection task={task} />;
      case "plan":
        return <PlanTimeline task={task} actions={actions} onOpenEditor={onOpenEditor} />;
      case "details":
        return <DetailsSection task={task} />;
      case "activity":
        return <ActivityLog task={task} projects={projects} />;
    }
  };
  const top = (
    <>
      <div className={cn("px-4 pt-4 pb-3", inWindow && "sm:px-6 sm:pt-6")}>
        <TaskTitle task={task} project={projects.find((p) => p.id === task.projectId)} actions={titleActions} />
      </div>
      <div className={cn("flex flex-col gap-2 px-3 pb-3", inWindow && "sm:px-5")}>
        <AttentionRequestCallout task={task} />
        <ImportCallout task={task} />
        <ResolutionCallout task={task} />
        {task.kind === "epic" ? (
          <EpicChildren task={task} boardFilter={boardEpicFilter} onFilter={(epicId) => void setEpicFilter(epicId)} />
        ) : // A task closed without a plan has nothing to be up to.
        task.resolution && task.progress.total === 0 ? null : (
          <WhereItsUpTo task={task} actions={actions} onWritePlan={() => onOpenEditor("outline")} />
        )}
      </div>
    </>
  );
  return (
    <TaskLayoutContext value={{ layout }}>
      <div ref={rootRef} data-task-layout={layout} className="size-full">
        {twoColumns ? (
          <div className="grid size-full grid-cols-[minmax(0,1fr)_21rem] grid-rows-[minmax(0,1fr)]">
            <ScrollArea scrollFade className={COLUMN_SCROLLBAR_CLASS}>
              <div className="flex min-w-0 flex-col px-2 pb-10">
                {top}
                <TaskLayoutContext value={{ layout, column: "main" }}>
                  <ManagedSections task={task} column="main" exclude={exclude} render={render} />
                </TaskLayoutContext>
              </div>
            </ScrollArea>
            {/* The border sits on the scroll area, outside its fade, so it runs unbroken from the header down. */}
            <ScrollArea
              scrollFade
              radius="none"
              role="complementary"
              aria-label="Properties"
              className={cn("border-s border-border/65", COLUMN_SCROLLBAR_CLASS)}
            >
              {/* The header's bottom line already tops the rail, so what comes first (a section, or the hidden
                  sections note when every rail section is hidden) drops its own hairline. */}
              <div className="flex min-w-0 flex-col pb-10 [&>*:first-child]:border-t-0 [&>*:first-child>section]:border-t-0">
                <TaskLayoutContext value={{ layout, column: "rail" }}>
                  <ManagedSections task={task} column="rail" exclude={exclude} render={render} />
                </TaskLayoutContext>
              </div>
            </ScrollArea>
          </div>
        ) : (
          <ScrollArea scrollFade>
            <div className={cn("flex flex-col pb-10", inWindow && "sm:px-2")}>
              {top}
              {/* Wide, with every section in one column, it is the main column: side sections keep their width. */}
              <TaskLayoutContext value={{ layout, column: wide ? "main" : undefined }}>
                <ManagedSections task={task} exclude={exclude} render={render} />
              </TaskLayoutContext>
            </div>
          </ScrollArea>
        )}
      </div>
    </TaskLayoutContext>
  );
}

function PanelSkeleton({ layout, onClose }: { layout: TaskPanelLayout; onClose: () => void }) {
  return (
    <div aria-busy className="flex flex-col">
      <div className={layout === "window" ? WINDOW_TOP_BAR_CLASS : PANEL_TOP_BAR_CLASS}>
        {layout === "window" ? null : <ClosePanelButton onClose={onClose} />}
        <Skeleton className="h-4 w-8" />
        <Skeleton className="h-6 w-24" />
      </div>
      <div className="flex flex-col gap-3 px-4 pt-4">
        <div className="flex items-start gap-2">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="ms-auto hidden size-6 shrink-0 @min-[460px]:block" />
        </div>
        <Skeleton className="h-4 w-40" />
        <Skeleton shape="card" className="mt-1 h-28 w-full" />
        <Skeleton className="mt-3 h-4 w-16" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="mt-3 h-4 w-16" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    </div>
  );
}
