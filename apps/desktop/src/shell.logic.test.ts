import { BRAND } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  LogTail,
  allowSubFrameNavigation,
  decideNavigation,
  isDesktopTheme,
  isOwnHealth,
  linuxAutostartEntry,
  parseBackgroundColor,
  parseDesktopBadge,
  parseDesktopNotification,
} from "./shell.logic.ts";

describe("isOwnHealth", () => {
  it("accepts only our brand id", () => {
    expect(isOwnHealth({ ok: true, id: BRAND.id, version: "1.0.0" })).toBe(true);
    expect(isOwnHealth({ ok: true, id: "something-else", version: "1.0.0" })).toBe(false);
    // Older servers answered `{ ok: true }` without an id.
    expect(isOwnHealth({ ok: true })).toBe(false);
    expect(isOwnHealth("<html>")).toBe(false);
  });
});

describe("decideNavigation", () => {
  const board = "http://127.0.0.1:4317";

  it("keeps board pages in the window", () => {
    expect(decideNavigation("http://127.0.0.1:4317/?task=abc", board)).toBe("allow");
  });

  it("sends other sites and T3 Code deep links to the OS", () => {
    expect(decideNavigation("https://github.com/o/r/pull/1", board)).toBe("external");
    expect(decideNavigation("http://localhost:4317/", board)).toBe("external");
    expect(decideNavigation("t3code://threads/env/thread", board)).toBe("external");
  });

  it("blocks unsafe schemes and garbage", () => {
    expect(decideNavigation("file:///C:/Windows/system32/calc.exe", board)).toBe("block");
    expect(decideNavigation("javascript:alert(1)", board)).toBe("block");
    expect(decideNavigation("not a url", board)).toBe("block");
  });
});

describe("allowSubFrameNavigation", () => {
  it("lets a frame load its srcdoc or a blank page and nothing else", () => {
    expect(allowSubFrameNavigation("about:srcdoc")).toBe(true);
    expect(allowSubFrameNavigation("about:blank")).toBe(true);
    // Not even the board: a sandboxed piece has no business loading it, or anything that sheds its CSP.
    expect(allowSubFrameNavigation("http://127.0.0.1:4317/")).toBe(false);
    expect(allowSubFrameNavigation("https://example.com/?leak=1")).toBe(false);
    expect(allowSubFrameNavigation("data:text/html,<script>fetch('//x')</script>")).toBe(false);
    expect(allowSubFrameNavigation("javascript:alert(1)")).toBe(false);
    expect(allowSubFrameNavigation("about:srcdoc#x")).toBe(false);
  });
});

describe("LogTail", () => {
  it("joins chunks split mid-line and keeps the last lines", () => {
    const tail = new LogTail(2);
    tail.push("one\ntw");
    tail.push("o\r\nthree\nfou");
    expect(tail.toString()).toBe("two\nthree\nfou");
  });
});

describe("parseBackgroundColor", () => {
  it("accepts only #rrggbb, lower-cased", () => {
    expect(parseBackgroundColor("#0A0A0A")).toBe("#0a0a0a");
    expect(parseBackgroundColor("#fff")).toBeNull();
    expect(parseBackgroundColor("oklch(0.2 0.02 300)")).toBeNull();
    expect(parseBackgroundColor(42)).toBeNull();
  });
});

describe("isDesktopTheme", () => {
  it("accepts only the web app's theme choices", () => {
    expect(["light", "dark", "system"].every(isDesktopTheme)).toBe(true);
    expect(isDesktopTheme("blue")).toBe(false);
    expect(isDesktopTheme({ toString: () => "dark" })).toBe(false);
  });
});

describe("parseDesktopNotification", () => {
  const ok = { id: "n1", title: "Checks failing on PR #7", body: "#1 Ship it", taskId: "t1" };

  it("accepts a notification, with or without a task", () => {
    expect(parseDesktopNotification(ok)).toEqual(ok);
    expect(parseDesktopNotification({ ...ok, taskId: null })).toEqual({ ...ok, taskId: null });
  });

  it("cuts long text rather than losing the notification", () => {
    const cut = parseDesktopNotification({ ...ok, title: "t".repeat(500), body: "x".repeat(5000) });
    expect(cut?.title).toHaveLength(300);
    expect(cut?.body).toHaveLength(1000);
  });

  it("drops anything else, including extra keys and an oversized id", () => {
    expect(parseDesktopNotification({ ...ok, id: "i".repeat(200) })).toBeNull();
    expect(parseDesktopNotification({ ...ok, extra: 1 })).toEqual(ok);
    expect(parseDesktopNotification({ ...ok, title: 1 })).toBeNull();
    expect(parseDesktopNotification({ ...ok, taskId: 3 })).toBeNull();
    expect(parseDesktopNotification({ id: "n1" })).toBeNull();
    expect(parseDesktopNotification(null)).toBeNull();
    expect(parseDesktopNotification("hi")).toBeNull();
  });
});

describe("parseDesktopBadge", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";

  it("accepts a count with an overlay, or none", () => {
    expect(parseDesktopBadge({ count: 3, description: "3 unread", overlay: png })).toEqual({
      count: 3,
      description: "3 unread",
      overlay: png,
    });
    expect(parseDesktopBadge({ count: 0, description: "", overlay: null })).toEqual({
      count: 0,
      description: "",
      overlay: null,
    });
  });

  it("refuses a bad count and anything but a small PNG data URL", () => {
    expect(parseDesktopBadge({ count: -1, description: "", overlay: null })).toBeNull();
    expect(parseDesktopBadge({ count: 1.5, description: "", overlay: null })).toBeNull();
    expect(parseDesktopBadge({ count: 1, description: "", overlay: "https://evil.example/x.png" })).toBeNull();
    expect(parseDesktopBadge({ count: 1, description: "", overlay: "data:image/svg+xml;base64,AAAA" })).toBeNull();
    expect(
      parseDesktopBadge({ count: 1, description: "", overlay: `data:image/png;base64,${"A".repeat(60_000)}` }),
    ).toBeNull();
    expect(parseDesktopBadge({ count: 1, overlay: null })).toBeNull();
  });
});

describe("linuxAutostartEntry", () => {
  it("writes a desktop entry that runs the app with its arguments", () => {
    expect(linuxAutostartEntry("Aboard", "/opt/aboard/aboard", ["--hidden"])).toBe(
      "[Desktop Entry]\nType=Application\nName=Aboard\nExec=/opt/aboard/aboard --hidden\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
    );
  });

  it("quotes paths with spaces and escapes what the Exec key reserves", () => {
    const entry = linuxAutostartEntry("Aboard", "/home/me/My Apps/Aboard.AppImage", ["--hidden"]);
    expect(entry).toContain('Exec="/home/me/My Apps/Aboard.AppImage" --hidden\n');
    // Quoting escapes these with a backslash, and the string value doubles every backslash again.
    expect(linuxAutostartEntry("Aboard", '/a/$b"c`d\\e', [])).toContain('Exec="/a/\\\\$b\\\\"c\\\\`d\\\\\\\\e"\n');
    expect(linuxAutostartEntry("Aboard", "/a/100%", [])).toContain("Exec=/a/100%%\n");
  });
});
