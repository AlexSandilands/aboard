import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "./components/ui/toast.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { initTheme } from "./hooks/useTheme.ts";
import { captureTokenFromHash } from "./lib/api.ts";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay.ts";
import { restoreBoardScope } from "./components/board/projectScopeRestore.ts";
import { router } from "./router.tsx";
import { initAppearance } from "./theme/appearance.ts";
import "./index.css";

captureTokenFromHash();
syncDocumentWindowControlsOverlayClass();
initTheme();
initAppearance();

restoreProjectScope();

/**
 * The desktop shell always loads the bare board URL, so a restart would drop the project scope. Before the first
 * render, a bare board takes the scope remembered last time; after that the URL rules (`useRememberProjectScope`, which
 * also restores a board first reached from another page).
 */
function restoreProjectScope() {
  const { pathname, search } = router.state.location;
  const project = restoreBoardScope(pathname, search);
  if (!project) return;
  const params = new URLSearchParams(window.location.search);
  params.set("project", project);
  router.history.replace(`${pathname}?${params}${window.location.hash}`);
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: 1 } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
