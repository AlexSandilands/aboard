import type { DesktopUpdateState } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { agoText, updateStatusView } from "./desktopUpdate.logic";

const base: DesktopUpdateState = {
  mode: "self-update",
  disabledReason: null,
  currentVersion: "2026.11.6",
  autoCheck: true,
  status: "idle",
  version: null,
  percent: null,
  checkedAt: null,
  error: null,
  noticeVia: null,
};
const now = Date.UTC(2026, 10, 8, 12);

describe("agoText", () => {
  it("rounds down to the largest unit", () => {
    expect(agoText(now - 10_000, now)).toBe("just now");
    expect(agoText(now - 60_000, now)).toBe("1 minute ago");
    expect(agoText(now - 12 * 60_000, now)).toBe("12 minutes ago");
    expect(agoText(now - 3 * 3_600_000, now)).toBe("3 hours ago");
    expect(agoText(now - 50 * 3_600_000, now)).toBe("2 days ago");
  });
});

describe("updateStatusView", () => {
  it("offers Check now when up to date, with when it last checked", () => {
    const view = updateStatusView({ ...base, status: "up-to-date", checkedAt: now - 12 * 60_000 }, now);
    expect(view.badge).toEqual({ label: "Up to date", tone: "success" });
    expect(view.text).toBe("Checked 12 minutes ago.");
    expect(view.button).toEqual({ label: "Check now", action: "check", primary: false });
  });

  it("shows progress while downloading, with the button disabled", () => {
    const view = updateStatusView({ ...base, status: "downloading", version: "2026.11.10", percent: 42 }, now);
    expect(view.percent).toBe(42);
    expect(view.button.action).toBeNull();
  });

  it("offers Restart to update once ready, and says why an install failed", () => {
    const ready = { ...base, status: "ready" as const, version: "2026.11.10" };
    expect(updateStatusView(ready, now).button).toEqual({
      label: "Restart to update",
      action: "install",
      primary: true,
    });
    expect(updateStatusView({ ...ready, error: "Access denied" }, now).text).toMatch(/couldn't start: Access denied/);
  });

  it("points notice-only installs at their package manager or the release page", () => {
    const available = { ...base, mode: "notice-only" as const, status: "available" as const, version: "2026.11.10" };
    expect(updateStatusView({ ...available, noticeVia: "pacman" }, now).text).toMatch(/pacman -Syu/);
    expect(updateStatusView({ ...available, noticeVia: "download" }, now).text).toMatch(/release page/);
    expect(updateStatusView(available, now).button.action).toBe("notes");
  });

  it("reports a failed check with Try again", () => {
    const view = updateStatusView({ ...base, status: "error", error: "No connection." }, now);
    expect(view.badge?.tone).toBe("error");
    expect(view.button).toMatchObject({ label: "Try again", action: "check" });
  });

  it("is off, with no action, when updates are", () => {
    const view = updateStatusView({ ...base, mode: "disabled", disabledReason: "dev builds" }, now);
    expect(view.text).toMatch(/off in dev builds/);
    expect(view.button.action).toBeNull();
  });
});
