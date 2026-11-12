import { describe, expect, it } from "vitest";
import { activeSectionId, isScrolledToBottom } from "./scrollSpy.logic";

describe("activeSectionId", () => {
  const sections = [
    { id: "a", top: 0 },
    { id: "b", top: 400 },
    { id: "c", top: 900 },
  ];

  it("picks the last section whose top has reached the threshold", () => {
    expect(activeSectionId(sections, { atBottom: false, threshold: 96 })).toBe("a");
    const scrolled = sections.map((s) => ({ ...s, top: s.top - 350 }));
    expect(activeSectionId(scrolled, { atBottom: false, threshold: 96 })).toBe("b");
  });

  it("keeps a section read while its heading has scrolled out of view above", () => {
    const middle = sections.map((s) => ({ ...s, top: s.top - 600 }));
    expect(activeSectionId(middle, { atBottom: false })).toBe("b");
  });

  it("falls back to the first before any has reached it", () => {
    const below = sections.map((s) => ({ ...s, top: s.top + 200 }));
    expect(activeSectionId(below, { atBottom: false })).toBe("a");
  });

  it("picks the last at the bottom, even when it is too short to reach the threshold", () => {
    expect(activeSectionId(sections, { atBottom: true })).toBe("c");
  });

  it("is null without sections", () => {
    expect(activeSectionId([], { atBottom: false })).toBeNull();
    expect(activeSectionId([], { atBottom: true })).toBeNull();
  });
});

describe("isScrolledToBottom", () => {
  it("is true at the end, within a pixel or two of rounding", () => {
    expect(isScrolledToBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
    expect(isScrolledToBottom({ scrollTop: 599, clientHeight: 400, scrollHeight: 1001 })).toBe(true);
  });

  it("is false above the end", () => {
    expect(isScrolledToBottom({ scrollTop: 300, clientHeight: 400, scrollHeight: 1000 })).toBe(false);
  });

  it("is false for an area that doesn't scroll, so its first section stays the one read", () => {
    expect(isScrolledToBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 400 })).toBe(false);
  });
});
