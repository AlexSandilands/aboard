import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useProjectFilter } from "~/components/board/boardNavigation";

/** Opens the stats window, scoped to the projects the board is on. */
export function useOpenStats() {
  const navigate = useNavigate();
  const project = useProjectFilter();
  return useCallback(
    () =>
      navigate({
        to: "/stats",
        search: { weeks: 12, project: project.join(",") || undefined },
      }),
    [navigate, project],
  );
}
