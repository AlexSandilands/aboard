import { describe, expect, it } from "vitest";
import { dismissedPrefs, parseGitHubReleases, pendingWhatsNew } from "./shell.logic.ts";

const entry = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: `Board ${tag}`,
  body: `## Highlights\n- Something in ${tag}\n## Details\n* PR`,
  draft: false,
  prerelease: false,
  published_at: "2026-11-20T10:00:00Z",
  html_url: `https://github.com/o/r/releases/tag/${tag}`,
  ...extra,
});

describe("parseGitHubReleases", () => {
  it("keeps published v<semver> releases, newest first, with the body split", () => {
    const releases = parseGitHubReleases([entry("v0.9.0"), entry("v0.10.0"), entry("v0.10.1")]);
    expect(releases?.map((r) => r.version)).toEqual(["0.10.1", "0.10.0", "0.9.0"]);
    expect(releases?.[0]).toEqual({
      version: "0.10.1",
      name: "Board v0.10.1",
      publishedAt: "2026-11-20T10:00:00Z",
      url: "https://github.com/o/r/releases/tag/v0.10.1",
      highlights: "- Something in v0.10.1",
      details: "* PR",
    });
  });

  it("drops drafts, prereleases, the pacman release and other tags", () => {
    const releases = parseGitHubReleases([
      entry("v1.0.0", { draft: true }),
      entry("v1.1.0", { prerelease: true }),
      entry("pacman"),
      entry("v1.2.0-beta.1"),
      entry("1.3.0"),
      entry("v0.0.0"),
      entry("v0.8.0"),
    ]);
    expect(releases?.map((r) => r.version)).toEqual(["0.8.0"]);
  });

  it("skips entries of the wrong shape and names an unnamed release by its tag", () => {
    const releases = parseGitHubReleases([{ tag_name: 3 }, null, entry("v0.8.0", { name: null, body: null })]);
    expect(releases).toEqual([
      expect.objectContaining({ version: "0.8.0", name: "v0.8.0", highlights: "", details: "" }),
    ]);
  });

  it("is null for a response that isn't a list", () => {
    expect(parseGitHubReleases({ message: "API rate limit exceeded" })).toBeNull();
  });
});

describe("pendingWhatsNew", () => {
  const prefs = (lastSeenVersion: string | null, showReleaseNotes = true) => ({ lastSeenVersion, showReleaseNotes });

  it("shows the releases since the last seen version after an update", () => {
    expect(pendingWhatsNew(prefs("0.11.0"), "0.13.0", "self-update")).toEqual({ since: "0.11.0", record: false });
    expect(pendingWhatsNew(prefs("0.11.0"), "0.13.0", "notice-only")).toEqual({ since: "0.11.0", record: false });
  });

  it("records a fresh install's version and shows nothing", () => {
    expect(pendingWhatsNew(prefs(null), "0.13.0", "self-update")).toEqual({ since: null, record: true });
  });

  it("does nothing on the version already seen", () => {
    expect(pendingWhatsNew(prefs("0.13.0"), "0.13.0", "self-update")).toEqual({ since: null, record: false });
  });

  it("records without showing when the notes are off, or after a downgrade", () => {
    expect(pendingWhatsNew(prefs("0.11.0", false), "0.13.0", "self-update")).toEqual({ since: null, record: true });
    expect(pendingWhatsNew(prefs("0.14.0"), "0.13.0", "self-update")).toEqual({ since: null, record: true });
  });

  it("never shows or records in a build whose updates are off", () => {
    expect(pendingWhatsNew(prefs("0.11.0"), "0.13.0", "disabled")).toEqual({ since: null, record: false });
    expect(pendingWhatsNew(prefs(null), "0.0.0", "self-update")).toEqual({ since: null, record: false });
  });
});

describe("dismissedPrefs", () => {
  const prefs = { trayIcon: "colour", lastSeenVersion: "0.11.0", showReleaseNotes: true };

  it("records the running version as seen, keeping the other prefs", () => {
    expect(dismissedPrefs(prefs, "0.13.0", "self-update", false)).toEqual({ ...prefs, lastSeenVersion: "0.13.0" });
  });

  it("also turns the notes off with Don't show after updates", () => {
    expect(dismissedPrefs(prefs, "0.13.0", "notice-only", true)).toEqual({
      ...prefs,
      lastSeenVersion: "0.13.0",
      showReleaseNotes: false,
    });
  });

  it("keeps no version in a build whose updates are off, but still takes the opt-out", () => {
    expect(dismissedPrefs(prefs, "0.0.0", "disabled", false)).toBeNull();
    expect(dismissedPrefs(prefs, "0.0.0", "disabled", true)).toEqual({ ...prefs, showReleaseNotes: false });
  });

  it("is null when nothing changes", () => {
    expect(dismissedPrefs({ ...prefs, lastSeenVersion: "0.13.0" }, "0.13.0", "self-update", false)).toBeNull();
  });
});
