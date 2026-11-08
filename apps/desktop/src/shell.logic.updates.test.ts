import { describe, expect, it } from "vitest";
import {
  describeUpdateError,
  feedVersion,
  initialUpdateState,
  isNewerVersion,
  isReleaseVersion,
  latestFeedUrl,
  noticeFeedUrl,
  noticeVia,
  reduceUpdate,
  releaseNotesUrl,
  updateMenuItem,
  updateMode,
  updateNotification,
  type UpdateEnvironment,
} from "./shell.logic.ts";

const env: UpdateEnvironment = {
  packaged: true,
  sandbox: false,
  platform: "win32",
  appImage: undefined,
  version: "2026.11.6",
};

describe("versions", () => {
  it("compares dates numerically, not as text", () => {
    expect(isNewerVersion("2026.11.10", "2026.11.6")).toBe(true);
    expect(isNewerVersion("2026.11.6", "2026.11.10")).toBe(false);
    expect(isNewerVersion("2027.1.1", "2026.12.31")).toBe(true);
    expect(isNewerVersion("2026.11.6", "2026.11.6")).toBe(false);
  });

  it("never offers anything to, or from, a non-release version", () => {
    expect(isNewerVersion("2026.11.10", "0.1.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "2026.11.6")).toBe(false);
    expect(isReleaseVersion("0.1.0")).toBe(false);
    expect(isReleaseVersion("2026.1.5")).toBe(true);
  });
});

describe("updateMode", () => {
  it("self-updates the Windows installer and the AppImage", () => {
    expect(updateMode(env)).toEqual({ mode: "self-update", reason: null });
    expect(updateMode({ ...env, platform: "linux", appImage: "/home/me/Aboard.AppImage" }).mode).toBe("self-update");
  });

  it("only gives notice on other Linux installs", () => {
    expect(updateMode({ ...env, platform: "linux" }).mode).toBe("notice-only");
    expect(updateMode({ ...env, platform: "linux", appImage: "" }).mode).toBe("notice-only");
  });

  it("is off in dev, the sandbox, source builds and elsewhere, saying why", () => {
    expect(updateMode({ ...env, packaged: false })).toEqual({ mode: "disabled", reason: "dev builds" });
    expect(updateMode({ ...env, packaged: false, sandbox: true })).toEqual({ mode: "disabled", reason: "the sandbox" });
    expect(updateMode({ ...env, version: "0.1.0" })).toEqual({ mode: "disabled", reason: "builds from source" });
    expect(updateMode({ ...env, platform: "darwin" })).toEqual({ mode: "disabled", reason: "this platform" });
  });
});

describe("noticeVia", () => {
  it("is pacman only for the Arch packages", () => {
    expect(noticeVia(null, true)).toBe("pacman");
    expect(noticeVia("deb", true)).toBe("download");
    expect(noticeVia("rpm", false)).toBe("download");
    expect(noticeVia(null, false)).toBe("download");
  });
});

describe("reduceUpdate", () => {
  const self = initialUpdateState({ mode: "self-update", reason: null }, "2026.11.6", true, null);
  const notice = initialUpdateState({ mode: "notice-only", reason: null }, "2026.11.6", true, "pacman");

  it("goes check, download, ready", () => {
    let s = reduceUpdate(self, { type: "checking" });
    expect(s.status).toBe("checking");
    s = reduceUpdate(s, { type: "found", version: "2026.11.10", at: 5 });
    expect(s).toMatchObject({ status: "downloading", version: "2026.11.10", percent: 0, checkedAt: 5 });
    s = reduceUpdate(s, { type: "progress", percent: 42.7 });
    expect(s.percent).toBe(42);
    s = reduceUpdate(s, { type: "downloaded", version: "2026.11.10" });
    expect(s).toMatchObject({ status: "ready", percent: null });
  });

  it("marks a notice-only find as available, and keeps it through a failed check", () => {
    let s = reduceUpdate(notice, { type: "found", version: "2026.11.10", at: 1 });
    expect(s).toMatchObject({ status: "available", version: "2026.11.10", noticeVia: "pacman" });
    s = reduceUpdate(s, { type: "error", message: "offline", at: 2 });
    expect(s.status).toBe("available");
  });

  it("keeps a ready update through later checks and errors", () => {
    const ready = reduceUpdate(self, { type: "downloaded", version: "2026.11.10" });
    expect(reduceUpdate(ready, { type: "checking" })).toBe(ready);
    expect(reduceUpdate(ready, { type: "up-to-date", at: 1 })).toBe(ready);
    expect(reduceUpdate(ready, { type: "error", message: "x", at: 1 })).toBe(ready);
  });

  it("reports a failed check quietly as an error", () => {
    const s = reduceUpdate(reduceUpdate(self, { type: "checking" }), { type: "error", message: "nope", at: 9 });
    expect(s).toMatchObject({ status: "error", error: "nope", checkedAt: 9 });
    expect(reduceUpdate(s, { type: "checking" })).toMatchObject({ status: "checking", error: null });
  });

  it("goes back to ready with the error when an install fails", () => {
    const ready = reduceUpdate(self, { type: "downloaded", version: "2026.11.10" });
    const installing = reduceUpdate(ready, { type: "installing" });
    expect(installing.status).toBe("installing");
    expect(reduceUpdate(installing, { type: "install-failed", message: "denied" })).toMatchObject({
      status: "ready",
      error: "denied",
    });
    // Installing only starts from ready.
    expect(reduceUpdate(self, { type: "installing" })).toBe(self);
  });

  it("ignores progress outside a download, and switches auto-check", () => {
    expect(reduceUpdate(self, { type: "progress", percent: 50 })).toBe(self);
    expect(reduceUpdate(self, { type: "auto-check", enabled: false }).autoCheck).toBe(false);
  });
});

describe("describeUpdateError", () => {
  it("turns network failures and a missing feed into one quiet sentence", () => {
    for (const message of [
      "HttpError: 404 \n Not Found",
      "net::ERR_INTERNET_DISCONNECTED",
      "getaddrinfo ENOTFOUND github.com",
      "fetch failed",
    ]) {
      expect(describeUpdateError(new Error(message))).toMatch(/Couldn't reach GitHub/);
    }
  });

  it("keeps the first line of anything else, cut short", () => {
    expect(describeUpdateError(new Error("\nsha512 checksum mismatch\nstack"))).toBe("sha512 checksum mismatch");
    expect(describeUpdateError("x".repeat(300))).toHaveLength(200);
  });
});

describe("feed and release URLs", () => {
  const repo = { owner: "acme", repo: "board" };

  it("reads the version from a feed", () => {
    expect(feedVersion("version: 2026.11.10\nfiles:\n  - url: a\n")).toBe("2026.11.10");
    expect(feedVersion("version: '2026.11.10'\n")).toBe("2026.11.10");
    expect(feedVersion("files: []\n")).toBeNull();
  });

  it("points at the release, or the list", () => {
    expect(releaseNotesUrl(repo, "2026.11.10")).toBe("https://github.com/acme/board/releases/tag/v2026.11.10");
    expect(releaseNotesUrl(repo, null)).toBe("https://github.com/acme/board/releases");
    expect(latestFeedUrl(repo)).toBe("https://github.com/acme/board/releases/latest/download/latest-linux.yml");
  });
});

describe("updateMenuItem and updateNotification", () => {
  const base = initialUpdateState({ mode: "self-update", reason: null }, "2026.11.6", true, null);

  it("follows the state", () => {
    expect(updateMenuItem(base)).toEqual({ label: "Check for updates", icon: "search", action: "check" });
    expect(updateMenuItem({ ...base, status: "checking" }).action).toBeNull();
    expect(updateMenuItem({ ...base, status: "downloading", version: "2026.11.10", percent: 42 }).label).toBe(
      "Downloading v2026.11.10… 42%",
    );
    expect(updateMenuItem({ ...base, status: "ready", version: "2026.11.10" })).toEqual({
      label: "Restart to update to v2026.11.10",
      icon: "rocket",
      action: "install",
    });
    expect(updateMenuItem({ ...base, status: "available", version: "2026.11.10" }).action).toBe("notes");
    expect(updateMenuItem({ ...base, status: "error" }).action).toBe("check");
  });

  it("is off, saying why, when updates are", () => {
    const off = initialUpdateState({ mode: "disabled", reason: "dev builds" }, "0.1.0", true, null);
    expect(updateMenuItem(off)).toEqual({ label: "Updates off in dev builds", icon: "search", action: null });
  });

  it("notifies only for ready and available", () => {
    expect(updateNotification(base)).toBeNull();
    expect(updateNotification({ ...base, status: "ready", version: "2026.11.10" })?.title).toMatch(
      /v2026\.11\.10 is ready/,
    );
    expect(
      updateNotification({ ...base, status: "available", version: "2026.11.10", noticeVia: "pacman" })?.body,
    ).toMatch(/pacman -Syu/);
  });
});

describe("noticeFeedUrl", () => {
  it("follows app-update.yml's provider", () => {
    expect(noticeFeedUrl("owner: acme\nrepo: board\nprovider: github\nreleaseType: release\n")).toBe(
      "https://github.com/acme/board/releases/latest/download/latest-linux.yml",
    );
    expect(noticeFeedUrl("provider: generic\nurl: http://127.0.0.1:47123/\n")).toBe(
      "http://127.0.0.1:47123/latest-linux.yml",
    );
  });

  it("is null without a usable file", () => {
    expect(noticeFeedUrl(null)).toBeNull();
    expect(noticeFeedUrl("provider: github\n")).toBeNull();
    expect(noticeFeedUrl("provider: generic\nurl: file:///etc\n")).toBeNull();
    expect(noticeFeedUrl("provider: s3\nbucket: x\n")).toBeNull();
  });
});
