import { type ReactNode, useId } from "react";

// A wide viewBox keeps the 96-unit art height at a fixed scale while sidebar resizing reveals
// more horizontal canvas instead of zooming the scene. Art that must cover the full width is
// drawn as a pattern; one-off shapes sit in the first ~300 units, the default sidebar width.
export const STAGE_VIEW_BOX = "0 0 8192 96";

/** Element ids for one art instance. useId keeps two copies on a page (style gallery) apart. */
export function useArtIds<K extends string>(names: readonly K[]): Record<K, string> {
  const prefix = useId().replaceAll(":", "");
  return Object.fromEntries(names.map((name) => [name, `${prefix}-${name}`])) as Record<K, string>;
}

export function StageSvg({
  art,
  tone = "dark",
  children,
}: {
  art: string;
  tone?: "dark" | "theme";
  children?: ReactNode;
}) {
  return (
    <svg
      data-stage-art={art}
      data-stage-tone={tone}
      className="h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={STAGE_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}
