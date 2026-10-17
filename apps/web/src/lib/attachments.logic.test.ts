import { describe, expect, it } from "vitest";
import { fitWithin, insertAtSelection, KEEP_BELOW_BYTES, planImage, pickUpload } from "./attachments.logic";

const MB = 1024 * 1024;

describe("fitWithin", () => {
  it("scales the long side down to the cap and keeps the ratio, never scaling up", () => {
    expect(fitWithin(5120, 2560)).toEqual({ width: 2560, height: 1280 });
    expect(fitWithin(1000, 6000)).toEqual({ width: 427, height: 2560 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe("planImage", () => {
  const png = { type: "image/png", width: 1200, height: 800 };
  it("keeps a small image and a GIF as they are", () => {
    expect(planImage({ ...png, size: 200_000 })).toEqual({ kind: "keep" });
    expect(planImage({ type: "image/gif", width: 5000, height: 5000, size: 3 * MB })).toEqual({ kind: "keep" });
  });
  it("re-encodes a heavy image, and scales a big one down", () => {
    expect(planImage({ ...png, size: KEEP_BELOW_BYTES + 1 })).toEqual({
      kind: "reencode",
      width: 1200,
      height: 800,
      resized: false,
    });
    expect(planImage({ type: "image/png", width: 5120, height: 2880, size: 500_000 })).toEqual({
      kind: "reencode",
      width: 2560,
      height: 1440,
      resized: true,
    });
  });
  it("converts a type the board doesn't store, however small", () => {
    expect(planImage({ type: "image/bmp", width: 10, height: 10, size: 400 })).toMatchObject({ kind: "reencode" });
  });
  it("rejects a GIF over the cap", () => {
    expect(planImage({ type: "image/gif", width: 10, height: 10, size: 6 * MB })).toMatchObject({
      kind: "reject",
      reason: expect.stringContaining("6.0 MB"),
    });
  });
});

describe("pickUpload", () => {
  it("keeps the original when re-encoding made it no smaller", () => {
    expect(
      pickUpload({ originalType: "image/jpeg", originalSize: 1.2 * MB, encodedSize: 1.5 * MB, resized: false }),
    ).toEqual({
      use: "original",
      size: 1.2 * MB,
    });
  });
  it("uses the new bytes when they are smaller, or the image was resized, or its type isn't stored", () => {
    expect(
      pickUpload({ originalType: "image/png", originalSize: 3 * MB, encodedSize: 1 * MB, resized: false }).use,
    ).toBe("encoded");
    expect(
      pickUpload({ originalType: "image/png", originalSize: 1 * MB, encodedSize: 2 * MB, resized: true }).use,
    ).toBe("encoded");
    expect(
      pickUpload({ originalType: "image/bmp", originalSize: 1 * MB, encodedSize: 2 * MB, resized: false }).use,
    ).toBe("encoded");
  });
  it("gives up with a message when it is still over 5 MB", () => {
    expect(
      pickUpload({ originalType: "image/png", originalSize: 9 * MB, encodedSize: 6 * MB, resized: true }),
    ).toMatchObject({
      use: "none",
      reason: expect.stringContaining("limit is 5.0 MB"),
    });
  });
});

describe("insertAtSelection", () => {
  it("spaces the token from the words around it and puts the cursor after it", () => {
    expect(insertAtSelection("see this", 3, 3, "[x]")).toEqual({ text: "see [x] this", caret: 7 });
    expect(insertAtSelection("", 0, 0, "[x]")).toEqual({ text: "[x]", caret: 3 });
    expect(insertAtSelection("a\n", 2, 2, "[x]")).toEqual({ text: "a\n[x]", caret: 5 });
  });
  it("replaces a selection and clamps a position past the end", () => {
    expect(insertAtSelection("a bad b", 2, 5, "[x]")).toEqual({ text: "a [x] b", caret: 5 });
    expect(insertAtSelection("ab", 99, 99, "[x]")).toEqual({ text: "ab [x]", caret: 6 });
  });
});
