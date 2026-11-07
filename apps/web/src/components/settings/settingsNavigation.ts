import { AUTOPILOT_ALL_RUNS } from "@repo/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { useSettingsNav } from "~/state/ui";
import {
  automationOfTarget,
  autopilotTabOf,
  editorListSection,
  parseSettingsTarget,
  providerOfTarget,
  type SettingsGroupId,
} from "./settingsNav.logic";

/** History state for opening an editor sub-page from its list, so leaving it can step back instead. */
export const FROM_SETTINGS_LIST = { settingsEditorFromList: true } as const;

/**
 * Opens Settings at a target: a group (`"autopilot"`), a section (`"project.recurring"`) or a row
 * (`"autopilot.limits.quiet-hours"`). `project` picks the project page's project; a Providers target
 * (`"agents.providers.codex.cli-path"`) picks the provider. The anchor goes in the URL hash
 * and is scrolled to once it renders, which the router can't do for content still loading. `highlight` flashes it
 * once it is in view.
 */
export function useOpenSettings() {
  const navigate = useNavigate();
  return useCallback(
    (target = "board", options: { project?: string; replace?: boolean; highlight?: boolean } = {}) => {
      const parsed = parseSettingsTarget(target) ?? { group: "board" as const, anchor: null };
      useSettingsNav.getState().requestScroll(parsed.anchor ?? parsed.group, options.highlight);
      // The Autopilot page's Runs and Limits tabs have paths of their own.
      if (parsed.group === "autopilot" && autopilotTabOf(parsed.anchor) !== "automations") {
        const hash = parsed.anchor ?? "";
        if (autopilotTabOf(parsed.anchor) === "runs") {
          void navigate({
            to: "/settings/autopilot/runs/$automation",
            params: { automation: AUTOPILOT_ALL_RUNS },
            hash,
            hashScrollIntoView: false,
            replace: options.replace,
          });
        } else {
          void navigate({
            to: "/settings/autopilot/limits",
            hash,
            hashScrollIntoView: false,
            replace: options.replace,
          });
        }
        return;
      }
      const automation = automationOfTarget(parsed.anchor);
      // A provider's section or row selects that provider on the Providers page.
      const provider = providerOfTarget(parsed.anchor);
      void navigate({
        to: "/settings/$group",
        params: { group: parsed.group },
        search:
          parsed.group === "project" && options.project
            ? { project: options.project }
            : provider
              ? { provider }
              : automation
                ? { automation }
                : {},
        hash: parsed.anchor ?? "",
        hashScrollIntoView: false,
        replace: options.replace,
      });
    },
    [navigate],
  );
}

/**
 * Leaves an editor sub-page for the section listing what it edits (Cancel, Save and Esc all do this). Opened from that
 * list, it steps back in history, so the browser's Back doesn't land on the same page again; opened from a link or
 * a reload, it goes to the list as a new entry. Either way the section is scrolled into view.
 */
export function useLeaveEditor() {
  const router = useRouter();
  const openSettings = useOpenSettings();
  return useCallback(
    (group: SettingsGroupId, project?: string) => {
      const section = editorListSection(group);
      if (router.state.location.state.settingsEditorFromList && router.history.canGoBack()) {
        useSettingsNav.getState().requestScroll(section);
        router.history.back();
        return;
      }
      openSettings(section, project ? { project } : {});
    },
    [router, openSettings],
  );
}

/** Back to the board, as it was when Settings opened. */
export function useLeaveSettings() {
  const navigate = useNavigate();
  return useCallback(() => {
    void navigate({ to: "/", search: useSettingsNav.getState().boardReturn });
  }, [navigate]);
}
