import { describe, expect, it } from "vitest";
import { ART_FRAME_ALLOW, ART_FRAME_GUARD, ART_FRAME_SANDBOX, artDocument, artFrameCsp } from "./artFrame.logic";

const directives = (csp: string) =>
  new Map(
    csp.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name!, values] as const;
    }),
  );

describe("art frame", () => {
  it("sandboxes scripts only: no same origin, popups, forms or navigation of the board", () => {
    expect(ART_FRAME_SANDBOX.split(/\s+/)).toEqual(["allow-scripts"]);
  });

  it.each(["html", "svg"] as const)("denies everything by default for %s, and reaches no network", (kind) => {
    const policy = directives(artFrameCsp(kind));
    expect(policy.get("default-src")).toEqual(["'none'"]);
    // No connect-src, frame-src, worker-src or object-src: they fall back to 'none'.
    for (const name of ["connect-src", "frame-src", "worker-src", "object-src", "child-src", "manifest-src"]) {
      expect(policy.has(name)).toBe(false);
    }
    expect(policy.get("form-action")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'none'"]);
    expect(policy.get("style-src")).toEqual(["'unsafe-inline'"]);
    // Nothing loads from a URL, and eval stays off.
    for (const [name, values] of policy) {
      if (name === "default-src" || name === "form-action" || name === "base-uri") continue;
      for (const value of values) expect(["'unsafe-inline'", "data:", "blob:"]).toContain(value);
    }
  });

  it("lets HTML pieces run inline script, and SVG none", () => {
    expect(directives(artFrameCsp("html")).get("script-src")).toEqual(["'unsafe-inline'"]);
    expect(directives(artFrameCsp("svg")).has("script-src")).toBe(false);
  });

  it("denies powerful features", () => {
    expect(ART_FRAME_ALLOW).toContain("camera 'none'");
    expect(ART_FRAME_ALLOW).toContain("clipboard-read 'none'");
    expect(ART_FRAME_ALLOW).not.toMatch(/\*|self|src/);
  });

  it("puts the policy and the guard before any of the piece", () => {
    const hostile =
      '</head><meta http-equiv="Content-Security-Policy" content="default-src *"><script>fetch("/api")</script>';
    const doc = artDocument("html", hostile);
    const policy = doc.indexOf("Content-Security-Policy");
    expect(policy).toBeGreaterThan(-1);
    expect(policy).toBeLessThan(doc.indexOf(hostile));
    expect(doc.indexOf(ART_FRAME_GUARD)).toBeGreaterThan(policy);
    expect(doc.indexOf(ART_FRAME_GUARD)).toBeLessThan(doc.indexOf(hostile));
    expect(doc.startsWith("<!doctype html><html><head><meta charset")).toBe(true);
    expect(doc).toContain(`content="${artFrameCsp("html")}"`);
    expect(doc).toContain('<meta http-equiv="x-dns-prefetch-control" content="off">');
  });

  it("takes WebRTC away for good, and the way to a nested frame's fresh copy", () => {
    // Stand-ins for the frame's globals: constructors whose prototypes the guard patches.
    const Frame = function Frame() {} as unknown as new () => { contentWindow: unknown };
    const ObjectEl = function ObjectEl() {} as unknown as new () => { contentDocument: unknown };
    Object.defineProperty(Frame.prototype, "contentWindow", { get: () => ({}), configurable: true });
    const win: Record<string, unknown> = { RTCPeerConnection: () => {}, RTCDataChannel: () => {} };
    type Methods = Record<string, (...args: string[]) => unknown>;
    const Doc = function Doc() {} as unknown as { prototype: Methods; parseHTMLUnsafe: () => unknown };
    Doc.prototype.createElement = (name: string) => ({ localName: name });
    Doc.prototype.createElementNS = (_ns: string, name: string) => ({ localName: name });
    const written: string[] = [];
    Doc.prototype.write = (...html: string[]) => written.push(...html);
    Doc.prototype.writeln = (...html: string[]) => written.push(...html);
    Doc.parseHTMLUnsafe = () => ({});
    const doc = Object.create(Doc.prototype) as Methods;
    const El = function El() {} as unknown as { prototype: Methods };
    El.prototype.attachShadow = () => ({});
    El.prototype.setHTMLUnsafe = () => {};
    const Shadow = function Shadow() {} as unknown as { prototype: Methods };
    Shadow.prototype.setHTMLUnsafe = () => {};
    win.ShadowRoot = Shadow;
    type Added = {
      nodeType: number;
      localName: string;
      removed?: boolean;
      remove(): void;
      querySelectorAll(): Added[];
    };
    let notify: (records: Array<{ addedNodes: Added[] }>) => void = () => {};
    let observed: unknown = null;
    class Observer {
      constructor(callback: typeof notify) {
        notify = callback;
      }
      observe(target: unknown) {
        observed = target;
      }
    }
    // oxlint-disable-next-line typescript/no-implied-eval -- runs the guard's source against fakes, as the frame would
    const guard = new Function(
      "window",
      "HTMLIFrameElement",
      "HTMLObjectElement",
      "HTMLFrameElement",
      "Document",
      "DOMException",
      "MutationObserver",
      "document",
      "Element",
      "ShadowRoot",
      ART_FRAME_GUARD,
    );
    guard(win, Frame, ObjectEl, undefined, Doc, Error, Observer, doc, El, Shadow);

    expect(win.RTCPeerConnection).toBeUndefined();
    expect(win.webkitRTCPeerConnection).toBeUndefined();
    expect(() => Object.defineProperty(win, "RTCPeerConnection", { value: 1 })).toThrow(TypeError);
    expect(new Frame().contentWindow).toBeNull();
    expect(new ObjectEl().contentDocument).toBeNull();

    expect(() => doc.createElement!("IFRAME")).toThrow("Nested frames");
    expect(() => doc.createElementNS!("http://www.w3.org/1999/xhtml", "html:embed")).toThrow("Nested frames");
    expect(doc.createElement!("canvas")).toEqual({ localName: "canvas" });

    // Inserted frames, on their own or inside other markup, are removed; the observer watches the document itself.
    expect(observed).toBe(doc);
    const node = (localName: string, inner: Added[] = []): Added => ({
      nodeType: 1,
      localName,
      remove() {
        this.removed = true;
      },
      querySelectorAll: () => inner,
    });
    const frame = node("iframe");
    const nested = node("object");
    const wrapper = node("div", [nested]);
    notify([{ addedNodes: [frame, wrapper] }]);
    expect(frame.removed).toBe(true);
    expect(nested.removed).toBe(true);
    expect(wrapper.removed).toBeUndefined();

    // Shadow DOM, which the observer can't see into, is refused from script.
    expect(() => El.prototype.attachShadow!()).toThrow("Shadow roots");
    expect(() => El.prototype.setHTMLUnsafe!()).toThrow("Shadow roots");
    expect(() => Shadow.prototype.setHTMLUnsafe!()).toThrow("Shadow roots");
    expect(() => Doc.parseHTMLUnsafe()).toThrow("Shadow roots");
    // document.write is refused outright: the parser joins its pieces, so an attribute split across calls (or between
    // a call and the markup after its script) would slip past any rewrite.
    expect(() => doc.write!("<template sh")).toThrow("document.write calls");
    expect(() => doc.writeln!("adowrootmode=open>")).toThrow("document.write calls");
    expect(written).toEqual([]);
  });

  it("turns declarative shadow roots in an HTML piece into a plain attribute", () => {
    const doc = artDocument(
      "html",
      '<div><template shadowrootmode="closed"><iframe srcdoc="x"></iframe></template></div>',
    );
    expect(doc).toContain('<template data-shadowrootmode="closed">');
    expect(doc.slice(doc.indexOf("<body>"))).not.toMatch(/ shadowroot/i);
    // Script reading a property of the same name is left alone.
    expect(artDocument("html", "<script>el.shadowRoot</script>")).toContain("el.shadowRoot");
  });

  it("shows SVG through the same document, sized to the frame and without the script guard", () => {
    const doc = artDocument("svg", '<svg viewBox="0 0 1 1"></svg>');
    expect(doc).toContain("body>svg{width:100%;height:100%}");
    expect(doc).toContain('<body><svg viewBox="0 0 1 1"></svg></body>');
    expect(doc).not.toContain("<script>");
    expect(artDocument("html", "<p>hi</p>")).not.toContain("body>svg");
  });
});
