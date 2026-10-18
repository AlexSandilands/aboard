import { describe, expect, it } from "vitest";
import {
  digestHeadline,
  digestIsEmpty,
  renderPlainDigest,
  type DigestData,
  type DigestProjectData,
} from "./digestBuilder.ts";

const project = (overrides: Partial<DigestProjectData> = {}): DigestProjectData => ({
  title: "Alpha",
  moves: [],
  merged: [],
  attention: [],
  runs: { total: 0, succeeded: 0, failed: 0, problems: [] },
  ...overrides,
});

// 2026-10-17 is a Saturday.
const data = (projects: DigestProjectData[], costUsd = 0): DigestData => ({
  from: new Date(2026, 9, 16, 9, 0),
  to: new Date(2026, 9, 17, 9, 0),
  projects,
  costUsd,
});

describe("renderPlainDigest", () => {
  it("says nothing changed, and names the period", () => {
    const text = renderPlainDigest(data([project()]));
    expect(text).toBe("# Digest: Sat 17 Oct 09:00\n\nSince Fri 16 Oct 09:00.\n\nNothing changed.\n");
  });

  it("groups by project and leaves out projects with nothing to report", () => {
    const text = renderPlainDigest(
      data([
        project({
          moves: [{ number: 12, title: "Add exports", from: "in_progress", to: "review" }],
          merged: [{ number: 7, title: "Fix build", pr: "acme/app#55" }],
          attention: [
            { number: 9, title: "Flaky test", kind: "pr_checks_failing" },
            { number: 10, title: "Docs", kind: "thread_waiting" },
            { number: 11, title: "Plans", kind: "agent_request" },
          ],
          runs: {
            total: 3,
            succeeded: 1,
            failed: 1,
            problems: [
              { number: 9, automation: "Start planned tasks", failed: true, message: "boom\nat stack line" },
              { number: null, automation: "Recurring tasks", failed: false, message: "gave up" },
            ],
          },
        }),
        project({ title: "Quiet" }),
      ]),
    );
    expect(text).toBe(
      [
        "# Digest: Sat 17 Oct 09:00",
        "",
        "Since Fri 16 Oct 09:00.",
        "",
        "## Alpha",
        "",
        "**Moved**",
        "- #12 Add exports: In Progress → Review",
        "",
        "**Merged pull requests**",
        "- #7 Fix build: acme/app#55",
        "",
        "**Needs attention**",
        "- #9 Flaky test: checks are failing",
        "- #10 Docs: an agent is waiting for you",
        "- #11 Plans: an agent asked you to look at it",
        "",
        "**Autopilot**",
        "- 3 runs: 1 succeeded, 1 failed, 1 skipped",
        "- #9 Start planned tasks failed: boom",
        "- Recurring tasks needs you: gave up",
        "",
      ].join("\n"),
    );
  });

  it("escapes Markdown in titles, so imported text can't format the digest", () => {
    const text = renderPlainDigest(
      data([project({ moves: [{ number: 1, title: "**bold** [x](y) <b>", from: "backlog", to: "planned" }] })]),
    );
    expect(text).toContain("- #1 \\*\\*bold\\*\\* \\[x\\](y) \\<b\\>: Backlog → Planned");
  });

  it("totals what Autopilot spent", () => {
    const text = renderPlainDigest(
      data([project({ moves: [{ number: 1, title: "a", from: "backlog", to: "planned" }] })], 1.5),
    );
    expect(text.trimEnd().endsWith("Autopilot spent $1.50 in this period.")).toBe(true);
    expect(renderPlainDigest(data([project()], 0))).not.toContain("spent");
  });
});

describe("digestHeadline and digestIsEmpty", () => {
  it("counts across projects", () => {
    const d = data([
      project({
        moves: [
          { number: 1, title: "a", from: "backlog", to: "planned" },
          { number: 2, title: "b", from: "backlog", to: "planned" },
        ],
        merged: [{ number: 3, title: "c", pr: "o/r#1" }],
      }),
      project({
        title: "Beta",
        attention: [{ number: 4, title: "d", kind: "thread_waiting" }],
        runs: {
          total: 1,
          succeeded: 0,
          failed: 1,
          problems: [{ number: 4, automation: "x", failed: true, message: "m" }],
        },
      }),
    ]);
    expect(digestHeadline(d)).toBe("2 moved · 1 PR merged · 1 needs attention · 1 run problem");
    expect(digestIsEmpty(d)).toBe(false);
  });

  it("reads a quiet period as nothing changed", () => {
    expect(digestHeadline(data([project()]))).toBe("Nothing changed");
    expect(digestIsEmpty(data([project(), project({ title: "Beta" })]))).toBe(true);
  });
});
