import { CornerDownRightIcon, GaugeIcon, LayersIcon, SparklesIcon, StarIcon } from "lucide-react";
import { ProviderIcon } from "~/components/handoff/T3LaunchPickers";
import { HarnessIcon } from "~/components/sessions/SessionParts";
import { cn } from "~/lib/utils";
import type { PickerIcon as PickerIconKind } from "./modelPicker.logic";

/** The mark of a picker tab or row: a provider's logo, or the icon of a kind of choice. */
export function PickerIcon({ icon, className }: { icon: PickerIconKind; className?: string }) {
  const size = cn("size-4 shrink-0", className);
  switch (icon.kind) {
    case "harness":
      return <HarnessIcon harness={icon.harness} className={size} />;
    case "t3":
      return <ProviderIcon driver={icon.driver} className={size} />;
    case "choices":
      return <LayersIcon aria-hidden className={size} />;
    case "favorites":
      return <StarIcon aria-hidden className={cn(size, "fill-current")} />;
    case "inherit":
      return <CornerDownRightIcon aria-hidden className={size} />;
    case "tier":
      return <GaugeIcon aria-hidden className={size} />;
    case "custom":
      return <SparklesIcon aria-hidden className={size} />;
  }
}
