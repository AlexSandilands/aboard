import type { AttentionReason } from "@taskboard/contracts";
import { CircleAlertIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "~/lib/utils";

export const ATTENTION_TONE: Record<AttentionReason["severity"], string> = {
  warning: "text-warning-foreground",
  error: "text-error",
};

export function AttentionIcon({ severity, className }: { severity: AttentionReason["severity"]; className?: string }) {
  const Icon = severity === "error" ? CircleAlertIcon : TriangleAlertIcon;
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", ATTENTION_TONE[severity], className)} />;
}
