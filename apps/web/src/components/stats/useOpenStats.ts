import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useProjectFilter } from "~/components/board/boardNavigation";

/** Whether the stats page is the one showing. */
export function useInStats(): boolean {
  return useLocation({ select: (location) => location.pathname === "/stats" });
}

/** Opens the stats page, scoped to the projects the board (or the stats page) is already on. */
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

/** Back from the stats page to the board, on the projects the stats page was scoped to. */
export function useLeaveStats() {
  const navigate = useNavigate();
  const project = useProjectFilter();
  return useCallback(
    () => navigate({ to: "/", search: { project: project.join(",") || undefined } }),
    [navigate, project],
  );
}
