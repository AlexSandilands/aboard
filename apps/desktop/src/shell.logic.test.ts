import { BRAND } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { LogTail, decideNavigation, isOwnHealth } from "./shell.logic.ts";

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

describe("LogTail", () => {
  it("joins chunks split mid-line and keeps the last lines", () => {
    const tail = new LogTail(2);
    tail.push("one\ntw");
    tail.push("o\r\nthree\nfou");
    expect(tail.toString()).toBe("two\nthree\nfou");
  });
});
