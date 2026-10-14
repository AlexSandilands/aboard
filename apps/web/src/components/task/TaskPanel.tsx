import { storageKey, type Project, type TaskDetail } from "@repo/contracts";
import { FileQuestionIcon, XIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Skeleton } from "~/components/ui/skeleton";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth, type ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { ApiError } from "~/lib/api";
import { useUpdateTask } from "~/state/mutations";
import { useBoard, useTaskDetail } from "~/state/queries";
import { usePanel } from "~/state/ui";
import { ActivityLog } from "./ActivityLog";
import { LinksSection } from "./LinksSection";
import { MarkdownField } from "./MarkdownField";
import { PlanEditor, type PlanEditorMode } from "./PlanEditor";
import { PlanTimeline } from "./PlanTimeline";
import { ResolutionCallout } from "./ResolutionCallout";
import { TaskActions } from "./TaskActions";
import { ClosePanelButton, PANEL_TOP_BAR_CLASS, TaskPanelHeader } from "./TaskPanelHeader";
import { TaskTitle } from "./TaskTitle";
import { usePlanActions } from "./usePlanActions";
import { WhereItsUpTo } from "./WhereItsUpTo";

const MIN_WIDTH = 380;
const DEFAULT_WIDTH = 540;
const EMPTY_PROJECTS: ReadonlyArray<Project> = [];

/**
 * Highest usePanel.planEditorRequest already acted on. Module-level so a request made just
 * before the panel mounts (e.g. a "Write plan" toast that also opens the panel) is still seen.
 */
let handledPlanEditorRequest = 0;

/** Docked, resizable task detail panel for `?task=<id>`. */
export function TaskPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const maxWidth = Math.max(MIN_WIDTH, Math.round((typeof window === "undefined" ? 1600 : window.innerWidth) * 0.7));
  const { width, handlers } = useResizableWidth({
    storageKey: storageKey("panel-width"),
    defaultWidth: DEFAULT_WIDTH,
    minWidth: MIN_WIDTH,
    maxWidth,
    edge: "left",
  });

  return (
    <aside
      aria-label="Task details"
      className="@container relative flex h-full min-h-0 max-w-[70vw] shrink-0 flex-col border-l border-border bg-background"
      style={{ [RESIZABLE_WIDTH_PROPERTY]: `${width}px`, width: `var(${RESIZABLE_WIDTH_PROPERTY})` } as CSSProperties}
    >
      <ResizeHandle handlers={handlers} />
      <TaskPanelContent key={taskId} taskId={taskId} onClose={onClose} />
    </aside>
  );
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

function TaskPanelContent({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const detail = useTaskDetail(taskId);
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

  if (detail.isPending) return <PanelSkeleton onClose={onClose} />;
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
      <TaskPanelHeader task={task} onClose={onClose} onOpenPlanEditor={openPlanEditor} />
      <div className="min-h-0 flex-1">
        <ScrollArea scrollFade>
          <TaskPanelBody
            task={task}
            projects={projects}
            onOpenEditor={openEditor}
            titleActions={
              <TaskActions task={task} projects={projects} onClose={onClose} onOpenPlanEditor={openPlanEditor} />
            }
          />
        </ScrollArea>
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

function TaskPanelBody({
  task,
  projects,
  onOpenEditor,
  titleActions,
}: {
  task: TaskDetail;
  projects: ReadonlyArray<Project>;
  onOpenEditor: (mode: PlanEditorMode) => void;
  titleActions: ReactNode;
}) {
  const actions = usePlanActions(task.id);
  const { mutate: updateTask } = useUpdateTask();
  return (
    <div className="flex flex-col pb-10">
      <div className="px-4 pt-4 pb-3">
        <TaskTitle task={task} project={projects.find((p) => p.id === task.projectId)} actions={titleActions} />
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <ResolutionCallout task={task} />
        {/* A task closed without a plan has nothing to be up to. */}
        {task.resolution && task.progress.total === 0 ? null : (
          <WhereItsUpTo task={task} actions={actions} onWritePlan={() => onOpenEditor("outline")} />
        )}
      </div>
      <LinksSection task={task} />
      <PlanTimeline task={task} actions={actions} onOpenEditor={onOpenEditor} />
      <MarkdownField
        title="Description"
        value={task.description}
        placeholder="Add a description…"
        onSave={(description) => updateTask({ id: task.id, description })}
      />
      <MarkdownField
        title="Plan context"
        value={task.planContext}
        placeholder="Add plan context: goals, constraints, decisions…"
        onSave={(planContext) => updateTask({ id: task.id, planContext })}
      />
      <ActivityLog task={task} projects={projects} />
    </div>
  );
}

function PanelSkeleton({ onClose }: { onClose: () => void }) {
  return (
    <div aria-busy className="flex flex-col">
      <div className={PANEL_TOP_BAR_CLASS}>
        <ClosePanelButton onClose={onClose} />
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
