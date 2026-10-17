import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { z } from "zod";
import { AppFrame } from "./components/layout/AppFrame.tsx";
import { AppLayout } from "./components/layout/AppLayout.tsx";
import {
  CustomAutomationEditorPage,
  RuleEditorPage,
  TemplateEditorPage,
} from "./components/settings/pages/EditorPages.tsx";
import { SettingsGroupPage } from "./components/settings/pages/SettingsGroupPage.tsx";
import { SettingsShell } from "./components/settings/SettingsShell.tsx";
import { isSettingsGroup } from "./components/settings/settingsNav.logic.ts";

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

// Pathless layout around the board and Settings, so the shell (and its live-update stream) stays mounted between them.
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: "_app", component: AppFrame });

export const boardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  validateSearch: (search) => BoardSearch.parse(search),
  component: AppLayout,
});

/** `?project=` on the project settings page and its rule editor: the project shown. */
const SettingsProjectSearch = z.object({ project: z.string().optional() });

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: SettingsShell,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/settings/$group", params: { group: "board" }, replace: true });
  },
});

export const settingsGroupRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "$group",
  validateSearch: (search) => SettingsProjectSearch.parse(search),
  beforeLoad: ({ params }) => {
    if (!isSettingsGroup(params.group)) {
      throw redirect({ to: "/settings/$group", params: { group: "board" }, replace: true });
    }
  },
  component: SettingsGroupPage,
});

// Editors are sub-pages; "new" stands for one not saved yet.
export const templateEditorRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "tasks/templates/$templateId",
  component: TemplateEditorPage,
});

export const customAutomationEditorRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "autopilot/custom/$customId",
  component: CustomAutomationEditorPage,
});

export const ruleEditorRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "project/recurring/$ruleId",
  validateSearch: (search) => SettingsProjectSearch.parse(search),
  component: RuleEditorPage,
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

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    appRoute.addChildren([
      boardRoute,
      settingsRoute.addChildren([
        settingsIndexRoute,
        settingsGroupRoute,
        templateEditorRoute,
        customAutomationEditorRoute,
        ruleEditorRoute,
      ]),
    ]),
    ...devRoutes,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
