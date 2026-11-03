import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A document that can be hidden, and a shell bridge whose hidden state the test sets. */
function setup(withBridge: boolean) {
  const doc = Object.assign(new EventTarget(), { hidden: false });
  let shellListener: ((hidden: boolean) => void) | undefined;
  const bridge = {
    onWindowHidden(listener: (hidden: boolean) => void) {
      shellListener = listener;
      listener(false);
      return () => {};
    },
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", withBridge ? { desktopBridge: bridge } : {});
  return {
    setDocumentHidden: (hidden: boolean) => {
      doc.hidden = hidden;
      doc.dispatchEvent(new Event("visibilitychange"));
    },
    setShellHidden: (hidden: boolean) => shellListener?.(hidden),
  };
}

describe("pageHidden", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("is hidden when the document is or when the shell's window is", async () => {
    const { setDocumentHidden, setShellHidden } = setup(true);
    const { pageHidden } = await import("./pageHidden");
    expect(pageHidden()).toBe(false);
    setShellHidden(true);
    expect(pageHidden()).toBe(true);
    setShellHidden(false);
    setDocumentHidden(true);
    expect(pageHidden()).toBe(true);
  });

  it("calls listeners for both kinds of change until unsubscribed", async () => {
    const { setDocumentHidden, setShellHidden } = setup(true);
    const { onPageHiddenChange } = await import("./pageHidden");
    const listener = vi.fn<() => void>();
    const unsubscribe = onPageHiddenChange(listener);
    setShellHidden(true);
    setDocumentHidden(true);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setShellHidden(false);
    setDocumentHidden(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("falls back to the document in a plain browser", async () => {
    const { setDocumentHidden } = setup(false);
    const { pageHidden } = await import("./pageHidden");
    expect(pageHidden()).toBe(false);
    setDocumentHidden(true);
    expect(pageHidden()).toBe(true);
  });
});
