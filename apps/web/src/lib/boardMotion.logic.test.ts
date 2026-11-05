import { describe, expect, it } from "vitest";
import { panelTransitionType } from "./boardMotion.logic";

describe("panelTransitionType", () => {
  it("opens when a task opens with none open, and closes when the last one closes", () => {
    expect(panelTransitionType(undefined, "t1")).toBe("panel-open");
    expect(panelTransitionType("t1", undefined)).toBe("panel-close");
  });

  it("leaves switching tasks and other navigations alone", () => {
    expect(panelTransitionType("t1", "t2")).toBeNull();
    expect(panelTransitionType(undefined, undefined)).toBeNull();
    expect(panelTransitionType("", "")).toBeNull();
  });
});
