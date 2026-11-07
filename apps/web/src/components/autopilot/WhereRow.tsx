import type { AutopilotAutomation } from "@repo/contracts";
import { Skeleton } from "~/components/ui/skeleton";
import { ScopeRow } from "./ScopeRow";
import { scopeState, scopeToggle, type PopoverScope } from "./where.logic";
import { useWhere } from "./useWhere";

/**
 * One automation's row in a lane or epic popover: the compact form of the Where it runs widget. Its switch edits the
 * same project or epic switch the widget lists as an exception, and its second line is the widget's sentence.
 */
export function WhereRow({
  automation,
  scope,
  title,
}: {
  automation: AutopilotAutomation;
  scope: PopoverScope;
  /** The project's or epic's name, for the switch's label. */
  title: string;
}) {
  const { input, description, apply } = useWhere(automation);
  const state = input ? scopeState(input, scope) : null;
  // The board is still loading, or the scope was just archived or deleted: nothing true to show yet.
  if (!input || !description || state === null) {
    return (
      <div className="flex min-h-9 items-center justify-between gap-2 py-1">
        <Skeleton className="h-3 w-28" />
        <Skeleton shape="pill" className="h-4 w-7" />
      </div>
    );
  }
  return (
    <ScopeRow
      name={automation.title}
      description={automation.description}
      label={`${automation.title} in ${title}`}
      checked={state !== "off"}
      preview={state === "preview"}
      where={description.sentence}
      blocked={automation.blocked}
      disabled={apply.isPending}
      onChange={(next) => {
        const writes = scopeToggle(input, scope, next);
        if (writes.length > 0) apply.mutate(writes);
      }}
    />
  );
}
