/** Docked, resizable task detail panel for `?task=<id>`. Placeholder — implemented by the detail-panel work package. */
export function TaskPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  return (
    <aside className="w-[540px] shrink-0 border-l border-border p-4 text-sm text-muted-foreground">
      Task {taskId}{" "}
      <button type="button" onClick={onClose}>
        close
      </button>
    </aside>
  );
}
