import { describe, expect, it } from "vitest";
import { iconCanvasLayout, smallestDataUrl } from "./projectIconImage.logic";

describe("iconCanvasLayout", () => {
  it("scales large images down to fit, centred, without cropping", () => {
    expect(iconCanvasLayout(512, 256, 128)).toEqual({ canvas: 128, x: 0, y: 32, width: 128, height: 64 });
    expect(iconCanvasLayout(300, 600, 128)).toEqual({ canvas: 128, x: 32, y: 0, width: 64, height: 128 });
  });

  it("never upscales small images", () => {
    expect(iconCanvasLayout(16, 16, 128)).toEqual({ canvas: 16, x: 0, y: 0, width: 16, height: 16 });
    expect(iconCanvasLayout(32, 20, 128)).toEqual({ canvas: 32, x: 0, y: 6, width: 32, height: 20 });
  });

  it("fills the canvas when the image has no intrinsic size", () => {
    expect(iconCanvasLayout(0, 0, 128)).toEqual({ canvas: 128, x: 0, y: 0, width: 128, height: 128 });
  });

  it("keeps extreme aspect ratios at least a pixel tall", () => {
    expect(iconCanvasLayout(10_000, 10, 128).height).toBe(1);
  });
});

describe("smallestDataUrl", () => {
  const png = "data:image/png;base64,AAAAAAAA";
  const webp = "data:image/webp;base64,AAAA";

  it("picks the shortest accepted encoding", () => {
    expect(smallestDataUrl([png, webp], 1000)).toBe(webp);
  });

  it("ignores encodings over the cap or of an unexpected type", () => {
    expect(smallestDataUrl([png, webp], png.length - 1)).toBe(webp);
    expect(smallestDataUrl(["data:image/jpeg;base64,A", png], 1000)).toBe(png);
    expect(smallestDataUrl([png], 5)).toBeNull();
  });
});
