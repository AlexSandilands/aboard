import { describe, expect, it } from "vitest";
import { retentionOptions, timeLeft } from "./trash.logic";

describe("retentionOptions", () => {
  it("offers the usual choices, plus a stored one that isn't among them", () => {
    expect(retentionOptions(30).map((o) => o.value)).toEqual(["1", "7", "14", "30", "60", "90", "180", "365"]);
    expect(retentionOptions(45).map((o) => o.label)).toContain("45 days");
    expect(retentionOptions(1)[0]).toEqual({ value: "1", label: "1 day" });
  });
});

describe("timeLeft", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  it("counts days until the purge, rounded", () => {
    expect(timeLeft("2026-12-07T11:59:00Z", now)).toBe("30 days left");
    expect(timeLeft("2026-11-17T13:00:00Z", now)).toBe("10 days left");
    expect(timeLeft("2026-11-08T12:00:00Z", now)).toBe("1 day left");
    expect(timeLeft("2026-11-08T11:00:00Z", now)).toBe("less than a day left");
    expect(timeLeft("2026-11-01T11:00:00Z", now)).toBe("less than a day left");
  });
});
