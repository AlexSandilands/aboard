import { AlertCircleIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";

// What the T3 and the Claude Code / Copilot launch dialogs show while their options load, or when they didn't.

/** Shown under the composer when the launch options didn't load; the composer stays so the prompt isn't lost. */
export function LaunchUnavailable({
  message,
  onRetry,
  onCopy,
}: {
  message: string;
  onRetry: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-border bg-card/40 p-4 text-sm">
      <p className="flex items-start gap-2">
        <AlertCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <span>{message}</span>
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
        <Button size="sm" variant="ghost" onClick={onCopy}>
          Copy prompt instead
        </Button>
      </div>
    </div>
  );
}

/** Stands in for the model, effort and access pickers while the options load. */
export function ToolbarSkeleton() {
  return (
    <>
      <Skeleton shape="pill" className="mx-2.5 h-4 w-32" />
      <Skeleton shape="pill" className="mx-2.5 h-4 w-16" />
      <Skeleton shape="pill" className="mx-2.5 h-4 w-24" />
    </>
  );
}
