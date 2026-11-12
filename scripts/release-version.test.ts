import { describe, expect, it } from "vitest";
import { releaseVersion } from "./release-version.ts";

describe("releaseVersion", () => {
  it("takes vMAJOR.MINOR.PATCH and drops the v", () => {
    expect(releaseVersion("v1.0.0")).toBe("1.0.0");
    expect(releaseVersion("v0.3.12")).toBe("0.3.12");
    expect(releaseVersion("v10.0.0")).toBe("10.0.0");
    expect(releaseVersion("v1.20.300")).toBe("1.20.300");
  });

  it.each([
    "",
    "pacman",
    "1.0.0",
    "V1.0.0",
    "v1",
    "v1.0",
    "v1.0.0.0",
    "v2026.11.13.1",
    "v1.0.0-rc.1",
    "v1.0.0+1",
    "v01.0.0",
    "v1.00.0",
    "v1.0.05",
    "v1.0.x",
    " v1.0.0",
    "v1.0.0\n",
  ])("refuses %j", (tag) => {
    expect(releaseVersion(tag)).toBeNull();
  });

  it("refuses the version that marks a build from source", () => {
    expect(releaseVersion("v0.0.0")).toBeNull();
    expect(releaseVersion("v0.0.1")).toBe("0.0.1");
  });
});
