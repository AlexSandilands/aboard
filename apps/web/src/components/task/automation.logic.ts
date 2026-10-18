import { autoReviewValue, type AutoReviewChoice } from "~/components/review/review.logic";
import { autopilotValue, type AutopilotChoice } from "./autopilot.logic";

/** The update a choice in the Automation section sends, so each select writes its own field. */
export type AutomationChange =
  | { setting: "autopilot"; choice: AutopilotChoice }
  | { setting: "autoMerge"; choice: AutopilotChoice }
  | { setting: "autoReview"; choice: AutoReviewChoice }
  | { setting: "priority"; on: boolean };

export function automationUpdate(
  change: AutomationChange,
):
  | { autopilot: boolean | null }
  | { autoMerge: boolean | null }
  | { autoReview: boolean | null }
  | { priority: boolean } {
  switch (change.setting) {
    case "autopilot":
      return { autopilot: autopilotValue(change.choice) };
    case "autoMerge":
      return { autoMerge: autopilotValue(change.choice) };
    case "autoReview":
      return { autoReview: autoReviewValue(change.choice) };
    case "priority":
      return { priority: change.on };
  }
}
