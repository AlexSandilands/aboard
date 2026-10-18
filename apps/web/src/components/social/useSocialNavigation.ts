import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { useProjectFilter } from "~/components/board/boardNavigation";
import { shouldStepBack } from "./socialNavigation.logic";

/** Whether the social feed is the page showing. */
export function useInSocial(): boolean {
  return useLocation({ select: (location) => location.pathname === "/social" });
}

/** Opens the feed from Settings, marking the history entry so Back can step back to it. */
export function useOpenSocial() {
  const navigate = useNavigate();
  return useCallback(() => navigate({ to: "/social", state: { socialFromSettings: true } }), [navigate]);
}

/**
 * Back from the feed. Opened from Settings it steps back in history, so the browser's Back doesn't land on the feed
 * again; opened by URL or after a reload there is nothing to step back to, so it goes to the board.
 */
export function useLeaveSocial() {
  const router = useRouter();
  const navigate = useNavigate();
  const project = useProjectFilter();
  return useCallback(() => {
    if (shouldStepBack(router.state.location.state, router.history.canGoBack())) {
      router.history.back();
      return;
    }
    void navigate({ to: "/", search: { project: project ?? undefined } });
  }, [router, navigate, project]);
}
