import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useSettingsNav } from "~/state/ui";
import { parseSettingsTarget } from "./settingsNav.logic";

/**
 * Opens Settings at a target: a group (`"autopilot"`), a section (`"project.recurring"`) or a row
 * (`"autopilot.engine.quiet-hours"`). `project` picks the project page's project. The anchor goes in the URL hash
 * and is scrolled to once it renders, which the router can't do for content still loading.
 */
export function useOpenSettings() {
  const navigate = useNavigate();
  return useCallback(
    (target = "board", options: { project?: string; replace?: boolean } = {}) => {
      const parsed = parseSettingsTarget(target) ?? { group: "board" as const, anchor: null };
      useSettingsNav.getState().requestScroll(parsed.anchor ?? parsed.group);
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

/** Back to the board, as it was when Settings opened. */
export function useLeaveSettings() {
  const navigate = useNavigate();
  return useCallback(() => {
    void navigate({ to: "/", search: useSettingsNav.getState().boardReturn });
  }, [navigate]);
}
