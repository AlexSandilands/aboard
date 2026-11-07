import { describe, expect, it } from "vitest";
import {
  DEFAULT_SENSITIVE_PATHS,
  matchesPathPattern,
  parseControlCommand,
  parseLogins,
  parsePathPatterns,
  parseReviewMarker,
  repoPrDedupeKey,
  reviewMarker,
  sensitiveFiles,
} from "./repoPrReview.ts";

describe("sensitive paths", () => {
  it("matches folders at the root by prefix, bare names in any folder, and paths with a slash whole", () => {
    expect(matchesPathPattern(".github/workflows/ci.yml", ".github/")).toBe(true);
    expect(matchesPathPattern("web/.github/x", ".github/")).toBe(false);
    expect(matchesPathPattern("web/yarn.lock", "*.lock")).toBe(true);
    expect(matchesPathPattern("docs/CODEOWNERS", "CODEOWNERS")).toBe(true);
    expect(matchesPathPattern("notes/a.md", "notes/*.md")).toBe(true);
    expect(matchesPathPattern("notes/x/a.md", "notes/*.md")).toBe(false);
    expect(matchesPathPattern("notes/x/a.md", "notes/**/*.md")).toBe(true);
    expect(matchesPathPattern("src/lock.ts", "*.lock")).toBe(false);
  });

  it("reads the default list", () => {
    const patterns = parsePathPatterns(DEFAULT_SENSITIVE_PATHS);
    expect(sensitiveFiles(["src/a.ts", "uv.lock", "tools/x.sh", "pnpm-lock.yaml"], patterns)).toEqual([
      "pnpm-lock.yaml",
      "tools/x.sh",
      "uv.lock",
    ]);
  });
});

describe("markers and commands", () => {
  it("round-trips a marker, and reads the custom automation's", () => {
    const marker = reviewMarker({ head: "abc", verdict: "approve", counted: 0, round: 2 });
    expect(marker).toBe("<!-- autopilot-review head=abc verdict=approve counted=0 round=2 -->");
    expect(parseReviewMarker(`Body\n\n${marker}`)).toEqual({
      head: "abc",
      verdict: "approve",
      counted: "0",
      round: "2",
    });
    expect(parseReviewMarker("x <!-- autopilot-review finding -->")).toEqual({ finding: "" });
    expect(parseReviewMarker("no marker")).toBeNull();
  });

  it("reads /autopilot stop and resume at the start, in any case", () => {
    expect(parseControlCommand("  /Autopilot STOP please")).toBe("stop");
    expect(parseControlCommand("/autopilot resume")).toBe("resume");
    expect(parseControlCommand("please /autopilot stop")).toBeNull();
    expect(parseControlCommand("/autopilot stopped")).toBeNull();
  });

  it("parses logins and keys reviews by head, resume and reply", () => {
    expect(parseLogins("Alice, @bob\ncarol alice")).toEqual(["alice", "bob", "carol"]);
    const pr = { host: "github.com", repo: "acme/app", number: 7 };
    expect(repoPrDedupeKey(pr, "a".repeat(40), 0, 0)).toBe(`review:repo:github.com/acme/app#7:${"a".repeat(12)}:r0`);
    expect(repoPrDedupeKey(pr, "a".repeat(40), 5, 9)).toMatch(/:r5:c9$/);
  });
});
