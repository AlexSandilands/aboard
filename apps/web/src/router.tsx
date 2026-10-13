import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { z } from "zod";
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
  component: function BoardPlaceholder() {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-neutral-400">Taskboard — shell coming up</div>
    );
  },
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
