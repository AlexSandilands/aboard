import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { z } from "zod";
import { AppLayout } from "./components/layout/AppLayout.tsx";
import { StyleGallery } from "./dev/StyleGallery.tsx";

/** Board search params: `task` opens the detail panel, `project` scopes the board. */
export const BoardSearch = z.object({
  task: z.string().optional(),
  project: z.string().optional(),
});
export type BoardSearch = z.infer<typeof BoardSearch>;

const rootRoute = createRootRoute({ component: () => <Outlet /> });

export const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search) => BoardSearch.parse(search),
  component: AppLayout,
});

const galleryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__gallery",
  component: StyleGallery,
});

export const router = createRouter({ routeTree: rootRoute.addChildren([boardRoute, galleryRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
