import type { DesktopBridge, DesktopRelease } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  closeAction,
  defaultRelease,
  detailsSummary,
  groupReleases,
  highlightSections,
  isLaterVersion,
  releaseDate,
  releaseNotesBridge,
  releaseNotesHeading,
} from "./releaseNotes.logic";

const release = (version: string, highlights = "- Something"): DesktopRelease => ({
  version,
  name: `v${version}`,
  publishedAt: "2026-11-28T09:00:00Z",
  url: `https://github.com/o/r/releases/tag/v${version}`,
  highlights,
  details: "* feat: one by @me in #1\n* fix: two by @me in #2",
});
const list = ["0.13.0", "0.12.0", "0.11.0", "0.10.0"].map((v) => release(v));
const versions = (releases: DesktopRelease[]) => releases.map((r) => r.version);

describe("isLaterVersion", () => {
  it("compares each part as a number", () => {
    expect(isLaterVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isLaterVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isLaterVersion("0.9.0", "0.10.0")).toBe(false);
    expect(isLaterVersion("dev", "0.1.0")).toBe(false);
  });
});

describe("groupReleases", () => {
  it("puts the releases since the one last seen first", () => {
    const groups = groupReleases(list, "0.11.0");
    expect(versions(groups.fresh)).toEqual(["0.13.0", "0.12.0"]);
    expect(versions(groups.earlier)).toEqual(["0.11.0", "0.10.0"]);
  });

  it("has nothing new from Settings", () => {
    const groups = groupReleases(list, null);
    expect(groups.fresh).toEqual([]);
    expect(versions(groups.earlier)).toEqual(["0.13.0", "0.12.0", "0.11.0", "0.10.0"]);
  });
});

describe("defaultRelease", () => {
  it("opens on the newest new release after an update", () => {
    expect(defaultRelease(groupReleases(list, "0.11.0"), "0.13.0")?.version).toBe("0.13.0");
  });

  it("opens on the running version from Settings", () => {
    expect(defaultRelease(groupReleases(list, null), "0.12.0")?.version).toBe("0.12.0");
  });

  it("falls back to the newest when the running version isn't listed, and to null with none", () => {
    expect(defaultRelease(groupReleases(list, null), "0.0.0")?.version).toBe("0.13.0");
    expect(defaultRelease(groupReleases([], null), "0.13.0")).toBeNull();
  });
});

describe("releaseNotesHeading", () => {
  it("names the new version and how many releases came since, after an update", () => {
    expect(releaseNotesHeading("update", "0.13.0", "0.11.0", 2)).toEqual({
      title: "What's new in v0.13.0",
      description: "Updated from v0.11.0 · 2 new releases",
    });
    expect(releaseNotesHeading("update", "0.13.0", "0.12.0", 1).description).toBe(
      "Updated from v0.12.0 · 1 new release",
    );
    expect(releaseNotesHeading("update", "0.13.0", "0.12.0", 0).description).toBe("Updated from v0.12.0");
  });

  it("is the plain history from Settings", () => {
    expect(releaseNotesHeading("history", "0.13.0", null, 0)).toEqual({
      title: "Release notes",
      description: "You're on v0.13.0.",
    });
  });
});

describe("detailsSummary", () => {
  it("counts the generated list's entries", () => {
    expect(detailsSummary(release("0.1.0").details)).toBe("Details · 2 changes");
    expect(detailsSummary("- one\n\n**Full Changelog**: …")).toBe("Details · 1 change");
    expect(detailsSummary("A sentence written by hand.")).toBe("Details");
  });
});

describe("releaseDate", () => {
  it("formats the day in UTC, and is empty without one", () => {
    expect(releaseDate("2026-11-28T23:30:00Z")).toBe("28 Nov 2026");
    expect(releaseDate(null)).toBe("");
    expect(releaseDate("not a date")).toBe("");
  });
});

describe("releaseNotesBridge", () => {
  const base: DesktopBridge = {
    setTheme: () => {},
    notify: () => {},
    setBadge: () => {},
    onNotificationClick: () => () => {},
  };

  it("is null in a browser or a shell from before release notes", () => {
    expect(releaseNotesBridge(null)).toBeNull();
    expect(releaseNotesBridge(base)).toBeNull();
    expect(releaseNotesBridge({ ...base, getWhatsNew: async () => ({}) as never })).toBeNull();
  });

  it("is the bridge once the shell has every method", () => {
    const full: DesktopBridge = {
      ...base,
      getWhatsNew: async () => ({ currentVersion: "0.13.0", since: null, showReleaseNotes: true }),
      listReleases: async () => ({ ok: true, releases: [] }),
      dismissWhatsNew: () => {},
      setShowReleaseNotes: () => {},
    };
    expect(releaseNotesBridge(full)).toBe(full);
  });
});

describe("closeAction", () => {
  it("marks the update's notes seen, passing the opt-out on", () => {
    expect(closeAction("update", false, false)).toEqual({ dismiss: true, stopShowing: false });
    expect(closeAction("update", false, true)).toEqual({ dismiss: true, stopShowing: true });
  });

  it("leaves them for the next launch when they couldn't be loaded, unless the user opted out", () => {
    expect(closeAction("update", true, false)).toBeNull();
    expect(closeAction("update", true, true)).toEqual({ dismiss: true, stopShowing: true });
  });

  it("tells the shell nothing when opened from Settings", () => {
    expect(closeAction("history", false, true)).toBeNull();
    expect(closeAction("history", true, false)).toBeNull();
  });
});

describe("highlightSections", () => {
  it("splits at each ### heading and tones the ones the format names", () => {
    expect(highlightSections("### New\n- One\n\n### Improved\n- Two\n### Fixed\n- Three")).toEqual([
      { heading: "New", tone: "success", body: "- One" },
      { heading: "Improved", tone: "info", body: "- Two" },
      { heading: "Fixed", tone: "warning", body: "- Three" },
    ]);
  });

  it("keeps text before the first heading, and leaves other headings neutral", () => {
    expect(highlightSections("A short intro.\n\n### Under the hood\n- Faster")).toEqual([
      { heading: null, tone: null, body: "A short intro." },
      { heading: "Under the hood", tone: null, body: "- Faster" },
    ]);
  });

  it("matches the heading's case loosely and ignores closing hashes", () => {
    expect(highlightSections("### FIXED ###\n- One")[0]).toMatchObject({ heading: "FIXED", tone: "warning" });
  });

  it("doesn't split inside a code fence", () => {
    expect(highlightSections("### New\n```md\n### not a heading\n```")).toEqual([
      { heading: "New", tone: "success", body: "```md\n### not a heading\n```" },
    ]);
  });

  it("is one plain section without headings", () => {
    expect(highlightSections("Just a note.")).toEqual([{ heading: null, tone: null, body: "Just a note." }]);
  });
});
