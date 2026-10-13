// Adapted from T3 Code (MIT) — see NOTICE.
import { deriveProjectIdentity, type ProjectIcon } from "@repo/contracts";
import { FolderCodeIcon } from "lucide-react";
import type { IconName } from "lucide-react/dynamic";
import { lazy, Suspense } from "react";
import { cn } from "~/lib/utils";
import { ProjectMonogram } from "./ProjectMonogram";
import { projectIconColorClassName } from "./projectIconColors";

const DynamicIcon = lazy(() =>
  import("lucide-react/dynamic").then((module) => ({ default: module.DynamicIcon })),
);

function DynamicProjectIconFallback() {
  return <FolderCodeIcon className="size-full text-inherit" />;
}

/**
 * A project's identity tile: its saved icon (monogram, emoji or Lucide glyph), or a
 * monogram derived from the title when it has none. Always pass the saved title, not a
 * display label, so the derived monogram stays stable across surfaces.
 */
export function ProjectFavicon(input: {
  title: string;
  icon: ProjectIcon | null;
  className?: string | undefined;
}) {
  const { icon, title } = input;
  if (icon?.kind === "monogram") {
    return <ProjectMonogram text={icon.text} color={icon.color} className={input.className} />;
  }
  if (icon?.kind === "emoji") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-3.5 shrink-0 items-center justify-center leading-none [container-type:size]",
          input.className,
        )}
      >
        <span className="text-[length:80cqh] leading-none">{icon.emoji}</span>
      </span>
    );
  }
  if (icon?.kind === "lucide") {
    const colorClassName = projectIconColorClassName(icon.color);
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-3.5 shrink-0 items-center justify-center",
          colorClassName,
          input.className,
        )}
      >
        <Suspense fallback={<DynamicProjectIconFallback />}>
          <DynamicIcon
            name={icon.name as IconName}
            className={cn("size-full", colorClassName)}
            fallback={DynamicProjectIconFallback}
          />
        </Suspense>
      </span>
    );
  }
  if (title.trim().length > 0) {
    const identity = deriveProjectIdentity(title);
    return (
      <ProjectMonogram
        text={identity.monogram}
        color={identity.color}
        className={input.className}
      />
    );
  }
  return <FolderCodeIcon className={cn("size-3.5 shrink-0 text-icon-muted", input.className)} />;
}
