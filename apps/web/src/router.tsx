import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Outlet } from "@tanstack/react-router";
import { z } from "zod";
import { AppLayout } from "./components/layout/AppLayout.tsx";

/**
 * Board search params: `task` opens the detail panel, `project` scopes the board, `labels` (comma-separated)
 * filters it, and `epic` shows only that epic's band.
 */
export const BoardSearch = z.object({
  task: z.string().optional(),
  project: z.string().optional(),
  labels: z.string().optional(),
  epic: z.string().optional(),
});
export type BoardSearch = z.infer<typeof BoardSearch>;

const rootRoute = createRootRoute({ component: () => <Outlet /> });

export const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search) => BoardSearch.parse(search),
  component: AppLayout,
});

// Dev-only component gallery; the DEV guard lets the production build drop it entirely.
const devRoutes = import.meta.env.DEV
  ? [
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/__gallery",
        component: lazyRouteComponent(() => import("./dev/StyleGallery.tsx"), "StyleGallery"),
      }),
    ]
  : [];

export const router = createRouter({ routeTree: rootRoute.addChildren([boardRoute, ...devRoutes]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
