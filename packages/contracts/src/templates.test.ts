import { describe, expect, it } from "vitest";
import { isoDate, renderTemplateText, templateHasPlan } from "./templates.ts";

const context = { date: new Date(2026, 9, 6, 23, 59), project: "Alpha" };

describe("renderTemplateText", () => {
  it("fills {{date}} with the local date and {{project}} with the project title", () => {
    expect(renderTemplateText("Review {{date}} for {{project}}", context)).toBe("Review 2026-10-06 for Alpha");
    expect(isoDate(new Date(2026, 0, 2))).toBe("2026-01-02");
  });
  it("accepts spaces and any case inside the braces, and fills every occurrence", () => {
    expect(renderTemplateText("{{ DATE }} {{Project}} {{date}}", context)).toBe("2026-10-06 Alpha 2026-10-06");
  });
  it("leaves other placeholders alone", () => {
    expect(renderTemplateText("{{who}} {{date", context)).toBe("{{who}} {{date");
  });
});

describe("templateHasPlan", () => {
  it("needs at least one step", () => {
    expect(templateHasPlan({ phases: [] })).toBe(false);
    expect(templateHasPlan({ phases: [{ title: "Empty", steps: [] }] })).toBe(false);
    expect(templateHasPlan({ phases: [{ title: "P", steps: [{ title: "s" }] }] })).toBe(true);
  });
});
