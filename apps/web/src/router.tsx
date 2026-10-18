import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { BoardFilterParams } from "@repo/contracts";
import { z } from "zod";
import { RunHistorySearch } from "./components/autopilot/runHistory.logic.ts";
import { AppFrame } from "./components/layout/AppFrame.tsx";
import { AppLayout } from "./components/layout/AppLayout.tsx";
import {
  AutopilotRunsPage,
  CustomAutomationEditorPage,
  CustomAutomationImportPage,
  RuleEditorPage,
  TemplateEditorPage,
} from "./components/settings/pages/EditorPages.tsx";
import { SettingsGroupPage } from "./components/settings/pages/SettingsGroupPage.tsx";
import { SettingsShell } from "./components/settings/SettingsShell.tsx";
import { isSettingsGroup } from "./components/settings/settingsNav.logic.ts";
import { SocialFeedPage } from "./components/social/SocialFeedPage.tsx";
import { StatsPage } from "./components/stats/StatsPage.tsx";
import { parseStatsPeriod } from "./components/stats/stats.logic.ts";

/**
 * Board search params: `task` opens the detail panel, and the rest are the board's filters (`BoardFilterParams`:
 * the project scope, the epic, labels, status, text and so on), which a saved view holds too.
 */
export const BoardSearch = BoardFilterParams.extend({
  task: z.union([z.string(), z.number()]).transform(String).optional().catch(undefined),
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

// The agents' social network's feed, reached only from the hidden section in Settings (docs/features/social.md).
const socialRoute = createRoute({ getParentRoute: () => appRoute, path: "/social", component: SocialFeedPage });

/** `?project=` (a project id; none is the whole board) and `?weeks=` (4, 12 or 52) on the stats page. */
const StatsSearch = z.object({
  project: z.string().min(1).optional().catch(undefined),
  weeks: z.unknown().optional().transform(parseStatsPeriod),
});

const statsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/stats",
  validateSearch: (search) => StatsSearch.parse(search),
  component: StatsPage,
});

// Editors are sub-pages; "new" stands for one not saved yet.
export const templateEditorRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "tasks/templates/$templateId",
  component: TemplateEditorPage,
});

// A static path wins over `$customId`, so "import" never reads as an automation's id.
export const customAutomationImportRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "autopilot/custom/import",
  component: CustomAutomationImportPage,
});

export const customAutomationEditorRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "autopilot/custom/$customId",
  component: CustomAutomationEditorPage,
});

// An automation's run history, or every automation's with `all`; the filters are search params.
export const autopilotRunsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "autopilot/runs/$automation",
  validateSearch: (search) => RunHistorySearch.parse(search),
  component: AutopilotRunsPage,
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
      socialRoute,
      statsRoute,
      settingsRoute.addChildren([
        settingsIndexRoute,
        settingsGroupRoute,
        templateEditorRoute,
        customAutomationImportRoute,
        customAutomationEditorRoute,
        autopilotRunsRoute,
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
  interface HistoryState {
    /** Set when a settings editor sub-page was opened from its list (see `useLeaveEditor`). */
    settingsEditorFromList?: boolean;
    /** Set when the social feed was opened from Settings (see `useLeaveSocial`). */
    socialFromSettings?: boolean;
  }
}
