import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "./components/ui/toast.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { initTheme } from "./hooks/useTheme.ts";
import { captureTokenFromHash } from "./lib/api.ts";
import { onPageHiddenChange, pageHidden } from "./lib/pageHidden.ts";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay.ts";
import { router } from "./router.tsx";
import { initAppearance } from "./theme/appearance.ts";
import "./index.css";

captureTokenFromHash();
syncDocumentWindowControlsOverlayClass();
initTheme();
initAppearance();

// Query pauses its intervals while the page is hidden and refetches the refetchOnWindowFocus queries when it shows
// again, judged by document visibility alone. The desktop shell keeps a page in the tray visible, so use its state too.
focusManager.setEventListener((setFocused) => {
  if (pageHidden()) setFocused(false);
  return onPageHiddenChange(() => setFocused(!pageHidden()));
});

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
