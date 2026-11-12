import { afterEach, describe, expect, it } from "vitest";
import { useAppearance, useReveal, useTaskPanelPrefs } from "./ui";

afterEach(() => {
  useReveal.setState({ request: null });
  useAppearance.setState({ scrollToTask: true });
  useTaskPanelPrefs.setState({ sections: {} });
});

describe("requestReveal", () => {
  it("makes no request when the scroll setting is off, unless the user asked for the jump", () => {
    useAppearance.setState({ scrollToTask: false });
    useReveal.getState().requestReveal("t");
    expect(useReveal.getState().request).toBeNull();
    useReveal.getState().requestReveal("t", { explicit: true });
    expect(useReveal.getState().request).toMatchObject({ taskId: "t", explicit: true });
  });

  it("marks a request made when a task opens as not explicit", () => {
    useReveal.getState().requestReveal("t");
    expect(useReveal.getState().request).toMatchObject({ taskId: "t", explicit: false });
  });
});

describe("section columns", () => {
  it("saves a moved section's column, and the reset clears it", () => {
    const prefs = () => useTaskPanelPrefs.getState();
    prefs().moveSectionToColumn("plan", "rail");
    expect(prefs().sections.columns).toEqual({ plan: "rail" });
    prefs().resetSections();
    expect(prefs().sections.columns).toBeUndefined();
  });
});
