import { describe, expect, it } from "vitest";
import {
  cropClipCss,
  cropTransform,
  freshSource,
  radiusCss,
  transformCss,
  turnDurationMs,
  visibleSource,
  zoomDurationMs,
  zoomTransform,
} from "./windowZoom.logic";

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

describe("zoomDurationMs", () => {
  it("is twice the Panel animations setting, and off at 0", () => {
    expect(zoomDurationMs(150)).toBe(300);
    expect(zoomDurationMs(100)).toBe(200);
    expect(zoomDurationMs(0)).toBe(0);
  });
});

describe("freshSource", () => {
  it("gives the source recorded for the task, or for whichever task is open", () => {
    expect(freshSource({ taskId: "a", source: "card", at: 1000 }, "a", 1100)).toBe("card");
    expect(freshSource({ taskId: null, source: "panel", at: 1000 }, "a", 1100)).toBe("panel");
  });

  it("gives none for another task, a stale record or no record", () => {
    expect(freshSource({ taskId: "b", source: "card", at: 1000 }, "a", 1100)).toBeNull();
    expect(freshSource({ taskId: "a", source: "card", at: 1000 }, "a", 9000)).toBeNull();
    expect(freshSource(null, "a", 0)).toBeNull();
  });
});

describe("visibleSource", () => {
  const board = rect(200, 50, 1000, 700);

  it("keeps a card on screen, whole", () => {
    const card = rect(300, 100, 260, 90);
    expect(visibleSource(card, board)).toBe(card);
  });

  it("keeps a card at least half showing on each side", () => {
    expect(visibleSource(rect(300, 700, 260, 90), board)).not.toBeNull();
    expect(visibleSource(rect(300, 710, 260, 90), board)).toBeNull();
    expect(visibleSource(rect(1100, 100, 260, 90), board)).toBeNull();
  });

  it("drops a card scrolled out of the board or with no box", () => {
    expect(visibleSource(rect(300, 900, 260, 90), board)).toBeNull();
    expect(visibleSource(rect(300, -200, 260, 90), board)).toBeNull();
    expect(visibleSource(rect(0, 0, 0, 0), board)).toBeNull();
  });
});

describe("zoomTransform", () => {
  it("moves the window's centre onto the source's and scales it to the source's size", () => {
    const transform = zoomTransform(rect(100, 200, 200, 100), rect(400, 100, 1000, 800));
    expect(transform).toEqual({ dx: -700, dy: -250, sx: 0.2, sy: 0.125 });
    expect(transformCss(transform!)).toBe("translate(-700px, -250px) scale(0.2, 0.125)");
  });

  it("is the identity for a source that is the window's own box", () => {
    expect(zoomTransform(rect(10, 20, 300, 400), rect(10, 20, 300, 400))).toEqual({ dx: 0, dy: 0, sx: 1, sy: 1 });
  });

  it("is null when either box has no size", () => {
    expect(zoomTransform(rect(0, 0, 0, 10), rect(0, 0, 10, 10))).toBeNull();
    expect(zoomTransform(rect(0, 0, 10, 10), rect(0, 0, 10, 0))).toBeNull();
  });
});

describe("radiusCss", () => {
  it("divides the source's radius by the scale on each axis, so it looks right once scaled", () => {
    expect(radiusCss(8, { dx: 0, dy: 0, sx: 0.2, sy: 0.125 })).toBe("40px / 64px");
    expect(radiusCss(0, { dx: 0, dy: 0, sx: 0.4, sy: 1.1 })).toBe("0px / 0px");
  });
});

describe("turnDurationMs", () => {
  it("is the whole duration from rest", () => {
    expect(turnDurationMs(300, 1)).toBe(300);
  });

  it("is the share already covered when turning around, but never a jump", () => {
    expect(turnDurationMs(300, 0.7)).toBe(210);
    expect(turnDurationMs(300, 0.05)).toBe(120);
  });
});

describe("cropTransform", () => {
  const window = rect(200, 100, 1200, 800);

  it("moves the window's corner onto the panel's and crops it to the panel's size, unscaled", () => {
    expect(cropTransform(rect(1100, 40, 480, 760), window)).toEqual({ dx: 900, dy: -60, right: 720, bottom: 40 });
  });

  it("crops nothing on a side where the panel is larger than the window", () => {
    expect(cropTransform(rect(1100, 0, 480, 1000), window)).toMatchObject({ right: 720, bottom: 0 });
  });

  it("gives none without a box", () => {
    expect(cropTransform(rect(0, 0, 0, 0), window)).toBeNull();
  });
});

describe("cropClipCss", () => {
  it("insets the right and bottom, and grows past the box by the outset at rest", () => {
    expect(cropClipCss({ right: 720, bottom: 40 }, 0)).toBe("inset(0px 720px 40px 0px round 0px)");
    expect(cropClipCss({ right: 0, bottom: 0 }, 16, 64)).toBe("inset(-64px -64px -64px -64px round 16px)");
  });
});
