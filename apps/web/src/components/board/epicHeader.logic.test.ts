import { describe, expect, it } from "vitest";
import { opensFromHeader } from "./epicHeader.logic";

/** A stand-in element: `controls` are the selectors it sits inside of, as closest() would find them. */
const node = (...controls: string[]) => ({
  closest: (selector: string) => (controls.some((c) => selector.split(", ").includes(c)) ? {} : null),
});

describe("opensFromHeader", () => {
  const inHeader = new Set<unknown>();
  const header = { contains: (n: never) => inHeader.has(n) };
  const within = <T>(n: T): T => {
    inHeader.add(n);
    return n;
  };

  it("opens the epic from the header's background and text", () => {
    expect(opensFromHeader(within(node()), header)).toBe(true);
  });

  it("leaves clicks on the header's own controls to them", () => {
    for (const control of ["button", "a", "input", "[role='button']", "[role='menuitem']"]) {
      expect(opensFromHeader(within(node(control)), header)).toBe(false);
    }
  });

  it("ignores clicks that bubbled from a popup portalled out of the header", () => {
    expect(opensFromHeader(node(), header)).toBe(false);
  });

  it("ignores targets that aren't elements", () => {
    expect(opensFromHeader(null, header)).toBe(false);
    expect(opensFromHeader(within({}), header)).toBe(false);
  });
});
