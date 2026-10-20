import type { CustomScriptLanguage, SdkValue } from "@repo/contracts";
import { cn } from "~/lib/utils";
import type { ChipTone } from "./insertChips.logic";

/** The colours of a value's group, so a chip, a reference row and its code read as the same kind of thing. */
export const TONE: Record<ChipTone, { text: string; surface: string; ring: string }> = {
  task: {
    text: "text-success-foreground",
    surface: "bg-success/10",
    ring: "ring-success/30 hover:ring-success/60",
  },
  project: {
    text: "text-info-foreground",
    surface: "bg-info/10",
    ring: "ring-info/30 hover:ring-info/60",
  },
  own: {
    text: "text-primary",
    surface: "bg-primary/10",
    ring: "ring-primary/30 hover:ring-primary/60",
  },
};

/** Which group a value of the reference belongs to, or null for one only a prompt gets (the item). */
export function toneOf(value: SdkValue): ChipTone | null {
  const key = value.stdin ?? "";
  if (key.startsWith("task.") || key.startsWith("pr.")) return "task";
  if (key.startsWith("project.") || key === "automation") return "project";
  if (key.startsWith("inputs.") || key.startsWith("vars.")) return "own";
  return null;
}

const LANGUAGE_BADGE: Record<CustomScriptLanguage, { short: string; className: string }> = {
  node: { short: "JS", className: "bg-warning/15 text-warning-foreground ring-warning/30" },
  python: { short: "PY", className: "bg-info/15 text-info-foreground ring-info/30" },
  powershell: { short: "PS", className: "bg-primary/15 text-primary ring-primary/30" },
  sh: { short: "SH", className: "bg-success/15 text-success-foreground ring-success/30" },
};

/** A small coloured tag for a script's language, the way an editor tab marks a file. */
export function LanguageBadge({ language, className }: { language: CustomScriptLanguage; className?: string }) {
  const badge = LANGUAGE_BADGE[language];
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-4 min-w-6 items-center justify-center rounded px-1 font-mono text-[0.625rem] leading-none font-semibold ring-1 ring-inset",
        badge.className,
        className,
      )}
    >
      {badge.short}
    </span>
  );
}
