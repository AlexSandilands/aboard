import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AUTOPILOT_ALL_RUNS, BoardFilterParams } from "@repo/contracts";
import { z } from "zod";
import { RunHistorySearch } from "./components/autopilot/runHistory.logic.ts";
import { AppFrame } from "./components/layout/AppFrame.tsx";
import { boardSnapshotMotion, prepareBoardTransition, snapshotMotionSupported } from "./lib/boardMotion.ts";
import { panelTransitionType } from "./lib/boardMotion.logic.ts";
import { AppLayout } from "./components/layout/AppLayout.tsx";
import { AutopilotLimitsPage } from "./components/autopilot/AutopilotPage.tsx";
import {
  AutopilotRunsPage,
  CustomAutomationEditorPage,
  CustomAutomationImportPage,
  RuleEditorPage,
  TemplateEditorPage,
} from "./components/settings/pages/EditorPages.tsx";
import { SettingsGroupPage } from "./components/settings/pages/SettingsGroupPage.tsx";
import { SettingsShell } from "./components/settings/SettingsShell.tsx";
import {
  automationOfTarget,
  autopilotTabOf,
  isSettingsGroup,
  providerOfTarget,
  redirectSettingsTarget,
} from "./components/settings/settingsNav.logic.ts";
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
/**
 * The settings pages' search: the project page's project, the provider the Providers page edits, or the automation
 * the Autopilot page shows.
 */
const SettingsGroupSearch = SettingsProjectSearch.extend({
  provider: z.string().optional(),
  automation: z.string().optional(),
});

/**
 * Where an old settings link goes once its target has moved: the Autopilot page's Runs and Limits tabs have paths of
 * their own; anything else is a group page with the target as its hash, and the provider or automation it selects.
 */
function movedSettingsRedirect(moved: string, provider?: string) {
  const group = moved.split(".")[0]!;
  if (group === "autopilot" && autopilotTabOf(moved) === "limits") {
    return redirect({ to: "/settings/autopilot/limits", hash: moved, replace: true });
  }
  if (group === "autopilot" && autopilotTabOf(moved) === "runs") {
    return redirect({
      to: "/settings/autopilot/runs/$automation",
      params: { automation: AUTOPILOT_ALL_RUNS },
      hash: moved,
      replace: true,
    });
  }
  const selected = provider ?? providerOfTarget(moved);
  const automation = automationOfTarget(moved);
  return redirect({
    to: "/settings/$group",
    params: { group },
    search: selected ? { provider: selected } : automation ? { automation } : {},
    hash: moved,
    replace: true,
  });
}
/** `draft` opens an automation an agent drafted (docs/features/autopilot.md#drafts). */
const ImportSearch = z.object({ draft: z.string().optional() });

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
  validateSearch: (search) => SettingsGroupSearch.parse(search),
  beforeLoad: ({ params, location }) => {
    const hash = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!isSettingsGroup(params.group)) {
      // The old Providers and Models pages are sections of Agents now; anything else goes to the first page.
      const moved = redirectSettingsTarget(hash || params.group);
      const group = moved.split(".")[0]!;
      if (!isSettingsGroup(group))
        throw redirect({ to: "/settings/$group", params: { group: "board" }, replace: true });
      throw movedSettingsRedirect(moved, (location.search as { provider?: string }).provider);
    }
    // An old link into Integrations (`#integrations.claude-code.cli-path`) or the old Autopilot page goes to where
    // that setting is now.
    const moved = hash ? redirectSettingsTarget(hash) : hash;
    if (moved !== hash) throw movedSettingsRedirect(moved);
  },
  component: SettingsGroupPage,
});

// The agents' social network's feed, reached only from the hidden section in Settings (docs/features/social.md).
const socialRoute = createRoute({ getParentRoute: () => appRoute, path: "/social", component: SocialFeedPage });

/** `?project=` (project ids, comma-separated; none is the whole board) and `?weeks=` (4, 12 or 52) on the stats page. */
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
  validateSearch: (search) => ImportSearch.parse(search),
  component: CustomAutomationImportPage,
});

export const customAutomationEditorRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "autopilot/custom/$customId",
  component: CustomAutomationEditorPage,
});

// The Autopilot page's Runs tab: an automation's run history, or every automation's with `all`; the filters are
// search params.
export const autopilotRunsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "autopilot/runs/$automation",
  validateSearch: (search) => RunHistorySearch.parse(search),
  component: AutopilotRunsPage,
});

// The Autopilot page's Limits & safety tab. A static path, so it wins over `$group`-style reads of "limits".
export const autopilotLimitsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "autopilot/limits",
  component: AutopilotLimitsPage,
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
        autopilotLimitsRoute,
        ruleEditorRoute,
      ]),
    ]),
    ...devRoutes,
  ]),
  // Smooth board motion (lib/boardMotion.ts): the task panel opening or closing on the board runs as a View
  // Transition. Any other navigation returns false, which skips the transition.
  defaultViewTransition: snapshotMotionSupported() && {
    types: ({ fromLocation, toLocation }) => {
      if (!boardSnapshotMotion() || fromLocation?.pathname !== "/" || toLocation.pathname !== "/") return false;
      const type = panelTransitionType(
        (fromLocation.search as { task?: unknown }).task,
        (toLocation.search as { task?: unknown }).task,
      );
      if (!type) return false;
      prepareBoardTransition("panel");
      return [type];
    },
  },
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
