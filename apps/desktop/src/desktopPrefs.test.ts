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

describe("parsePrefs", () => {
  it("keeps a known tray icon style", () => {
    expect(parsePrefs({ trayIcon: "white" })).toEqual({ trayIcon: "white" });
    expect(parsePrefs({ trayIcon: "black" })).toEqual({ trayIcon: "black" });
  });

  it("falls back to colour for anything else", () => {
    for (const value of [null, "white", 3, [], {}, { trayIcon: "auto" }, { trayIcon: 1 }]) {
      expect(parsePrefs(value)).toEqual({ trayIcon: "colour" });
    }
  });
});

describe("readPrefs and writePrefs", () => {
  it("defaults when there is no file", () => {
    expect(readPrefs(join(dir, "missing"))).toEqual({ trayIcon: "colour" });
  });

  it("round trips, creating the directory", () => {
    const nested = join(dir, "profile");
    writePrefs(nested, { trayIcon: "black" });
    expect(readPrefs(nested)).toEqual({ trayIcon: "black" });
    expect(readdirSync(nested)).toEqual(["prefs.json"]);
  });

  it("recovers from a corrupt file", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "prefs.json"), "{ not json");
    expect(readPrefs(dir)).toEqual({ trayIcon: "colour" });
  });

  it("recovers from a file with an unknown value", () => {
    writeFileSync(join(dir, "prefs.json"), JSON.stringify({ trayIcon: "neon" }));
    expect(readPrefs(dir)).toEqual({ trayIcon: "colour" });
  });
});
