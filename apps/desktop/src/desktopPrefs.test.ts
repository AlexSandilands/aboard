import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePrefs, readPrefs, writePrefs } from "./desktopPrefs.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desktop-prefs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const DEFAULTS = { trayIcon: "colour", autoCheckUpdates: true, notifiedUpdate: null };

describe("parsePrefs", () => {
  it("keeps a known tray icon style", () => {
    expect(parsePrefs({ trayIcon: "white" }).trayIcon).toBe("white");
    expect(parsePrefs({ trayIcon: "black" }).trayIcon).toBe("black");
  });

  it("falls back to the defaults for anything else", () => {
    for (const value of [null, "white", 3, [], {}, { trayIcon: "auto" }, { trayIcon: 1 }]) {
      expect(parsePrefs(value)).toEqual(DEFAULTS);
    }
  });

  it("keeps the update settings, checking automatically unless told not to", () => {
    expect(parsePrefs({ autoCheckUpdates: false, notifiedUpdate: "2026.11.10" })).toEqual({
      ...DEFAULTS,
      autoCheckUpdates: false,
      notifiedUpdate: "2026.11.10",
    });
    expect(parsePrefs({ autoCheckUpdates: "no", notifiedUpdate: 3 })).toEqual(DEFAULTS);
  });

  it("reads a file from before update settings with them on", () => {
    expect(parsePrefs({ trayIcon: "white" })).toEqual({ ...DEFAULTS, trayIcon: "white" });
  });
});

describe("readPrefs and writePrefs", () => {
  it("defaults when there is no file", () => {
    expect(readPrefs(join(dir, "missing"))).toEqual(DEFAULTS);
  });

  it("round trips, creating the directory", () => {
    const nested = join(dir, "profile");
    const prefs = { trayIcon: "black", autoCheckUpdates: false, notifiedUpdate: "2026.11.10" } as const;
    writePrefs(nested, prefs);
    expect(readPrefs(nested)).toEqual(prefs);
    expect(readdirSync(nested)).toEqual(["prefs.json"]);
  });

  it("recovers from a corrupt file", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "prefs.json"), "{ not json");
    expect(readPrefs(dir)).toEqual(DEFAULTS);
  });

  it("recovers from a file with an unknown value", () => {
    writeFileSync(join(dir, "prefs.json"), JSON.stringify({ trayIcon: "neon", autoCheckUpdates: null }));
    expect(readPrefs(dir)).toEqual(DEFAULTS);
  });
});
