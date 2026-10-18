import { AUTOPILOT_ALL_RUNS, AUTOPILOT_ORCHESTRATE } from "@repo/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { useSettingsNav } from "~/state/ui";
import { editorListSection, parseSettingsTarget, type SettingsGroupId } from "./settingsNav.logic";

/** History state for opening an editor sub-page from its list, so leaving it can step back instead. */
export const FROM_SETTINGS_LIST = { settingsEditorFromList: true } as const;

/**
 * Opens Settings at a target: a group (`"autopilot"`), a section (`"project.recurring"`) or a row
 * (`"autopilot.engine.quiet-hours"`). `project` picks the project page's project. The anchor goes in the URL hash
 * and is scrolled to once it renders, which the router can't do for content still loading. `highlight` flashes it
 * once it is in view.
 */
export function useOpenSettings() {
  const navigate = useNavigate();
  return useCallback(
    (target = "board", options: { project?: string; replace?: boolean; highlight?: boolean } = {}) => {
      const parsed = parseSettingsTarget(target) ?? { group: "board" as const, anchor: null };
      useSettingsNav.getState().requestScroll(parsed.anchor ?? parsed.group, options.highlight);
      void navigate({
        to: "/settings/$group",
        params: { group: parsed.group },
        search: parsed.group === "project" && options.project ? { project: options.project } : {},
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

/**
 * Leaves a run history page for the Autopilot settings, scrolled to where its link was: Orchestrate's area, the list of
 * automations, or the custom automations. Steps back in history when the page was opened from there (as
 * `useLeaveEditor`).
 */
export function useLeaveRunHistory(automation: string) {
  const router = useRouter();
  const openSettings = useOpenSettings();
  return useCallback(() => {
    const section =
      automation === AUTOPILOT_ORCHESTRATE
        ? "autopilot.engine.orchestrate"
        : automation === AUTOPILOT_ALL_RUNS
          ? "autopilot.engine"
          : "autopilot.custom";
    if (router.state.location.state.settingsEditorFromList && router.history.canGoBack()) {
      // A custom automation's history is opened from its editor, which is what Back returns to: nothing to scroll.
      if (automation === AUTOPILOT_ORCHESTRATE || automation === AUTOPILOT_ALL_RUNS) {
        useSettingsNav.getState().requestScroll(section);
      }
      router.history.back();
      return;
    }
    openSettings(section);
  }, [router, openSettings, automation]);
}

/** Back to the board, as it was when Settings opened. */
export function useLeaveSettings() {
  const navigate = useNavigate();
  return useCallback(() => {
    void navigate({ to: "/", search: useSettingsNav.getState().boardReturn });
  }, [navigate]);
}
