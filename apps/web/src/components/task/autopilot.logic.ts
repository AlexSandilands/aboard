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
