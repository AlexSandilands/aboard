export type AutopilotChoice = "default" | "on" | "off";

/** Default never auto-starts a task, so it reads the same as Off; only On makes Start planned tasks pick it up. */
export const AUTOPILOT_OPTIONS: ReadonlyArray<{ value: AutopilotChoice; label: string }> = [
  { value: "default", label: "Default (not started)" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

export const autopilotChoice = (value: boolean | null): AutopilotChoice =>
  value === null ? "default" : value ? "on" : "off";

export const autopilotValue = (choice: AutopilotChoice): boolean | null =>
  choice === "default" ? null : choice === "on";

/** Default never auto-merges either: merge_task_pr refuses a task unless it is On. Same tri-state as Autopilot. */
export const AUTO_MERGE_OPTIONS: ReadonlyArray<{ value: AutopilotChoice; label: string }> = [
  { value: "default", label: "Default (off)" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];
