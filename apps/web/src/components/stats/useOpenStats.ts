import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useProjectFilter } from "~/components/board/boardNavigation";

/** Opens the stats page, scoped to the project the board (or the stats page) is already on. */
export function useOpenStats() {
  const navigate = useNavigate();
  const project = useProjectFilter();
  return useCallback(
    () =>
      navigate({
        to: "/stats",
        search: { weeks: 12, project: project ?? undefined },
      }),
    [navigate, project],
  );
}
