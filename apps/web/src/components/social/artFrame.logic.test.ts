import { describe, expect, it } from "vitest";
import { ART_FRAME_ALLOW, ART_FRAME_CSP, ART_FRAME_SANDBOX, artDocument } from "./artFrame.logic";

const directives = new Map(
  ART_FRAME_CSP.split(";").map((d) => {
    const [name, ...values] = d.trim().split(/\s+/);
    return [name!, values] as const;
  }),
);

describe("art frame", () => {
  it("sandboxes scripts only: no same origin, popups, forms or navigation of the board", () => {
    expect(ART_FRAME_SANDBOX.split(/\s+/)).toEqual(["allow-scripts"]);
  });

  it("denies everything by default, and reaches no network", () => {
    expect(directives.get("default-src")).toEqual(["'none'"]);
    // No connect-src, frame-src, worker-src or object-src: they fall back to 'none'.
    for (const name of ["connect-src", "frame-src", "worker-src", "object-src", "child-src", "manifest-src"]) {
      expect(directives.has(name)).toBe(false);
    }
    expect(directives.get("form-action")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    // Inline script and style run; nothing loads from a URL, and eval stays off.
    expect(directives.get("script-src")).toEqual(["'unsafe-inline'"]);
    expect(directives.get("style-src")).toEqual(["'unsafe-inline'"]);
    for (const [name, values] of directives) {
      if (name === "default-src" || name === "form-action" || name === "base-uri") continue;
      for (const value of values) expect(["'unsafe-inline'", "data:", "blob:"]).toContain(value);
    }
  });

  it("denies powerful features", () => {
    expect(ART_FRAME_ALLOW).toContain("camera 'none'");
    expect(ART_FRAME_ALLOW).toContain("clipboard-read 'none'");
    expect(ART_FRAME_ALLOW).not.toMatch(/\*|self|src/);
  });

  it("puts the policy before any of the piece", () => {
    const hostile =
      '</head><meta http-equiv="Content-Security-Policy" content="default-src *"><script>fetch("/api")</script>';
    const doc = artDocument("html", hostile);
    const policy = doc.indexOf("Content-Security-Policy");
    expect(policy).toBeGreaterThan(-1);
    expect(policy).toBeLessThan(doc.indexOf(hostile));
    expect(doc.startsWith("<!doctype html><html><head><meta charset")).toBe(true);
    expect(doc).toContain(`content="${ART_FRAME_CSP}"`);
  });

  it("shows SVG through the same document, sized to the frame", () => {
    const doc = artDocument("svg", '<svg viewBox="0 0 1 1"></svg>');
    expect(doc).toContain("body>svg{width:100%;height:100%}");
    expect(doc).toContain('<body><svg viewBox="0 0 1 1"></svg></body>');
    expect(artDocument("html", "<p>hi</p>")).not.toContain("body>svg");
  });
});
