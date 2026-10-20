import { describe, expect, it } from "vitest";
import {
  attachedImagesLines,
  attachmentIdOf,
  attachmentIdsIn,
  attachmentToken,
  formatBytes,
  LaunchAttachmentIds,
  withAttachedImages,
} from "./attachments.ts";

const A = "0b6c1f0e-3a4d-4c1e-9d7a-2f5b8c9e1a11";
const B = "7d3e9a52-1c8f-4b6a-a0e4-5c2d7f8b3e22";

describe("attachment tokens", () => {
  it("round-trips an id through the token and finds each once, in order", () => {
    const text = `see ${attachmentToken(A, "bug")} and ${attachmentToken(B)} then ${attachmentToken(A)}`;
    expect(attachmentIdsIn(text)).toEqual([A, B]);
    expect(attachmentIdOf(`attachment:${A}`)).toBe(A);
  });
  it("ignores ordinary images and links, and keeps brackets out of the alt text", () => {
    expect(attachmentIdsIn("![x](https://example.com/a.png) [y](attachment:nope)")).toEqual([]);
    expect(attachmentIdOf("https://example.com/a.png")).toBeNull();
    expect(attachmentToken(A, "a]b[c")).toBe(`![a b c](attachment:${A})`);
    expect(attachmentIdsIn(null)).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("rounds to a readable unit", () => {
    expect(formatBytes(7)).toBe("7 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("launch images", () => {
  const images = [
    { filename: "bug.png", path: "C:/data/attachments/t/a.png" },
    { filename: "after", path: "/data/attachments/t/b.webp" },
  ];
  it("points at each image in T3 Code's wording, a blank line apart", () => {
    expect(attachedImagesLines(images)).toBe(
      '[Attached image "bug.png" is saved at: C:/data/attachments/t/a.png]\n\n' +
        '[Attached image "after" is saved at: /data/attachments/t/b.webp]',
    );
    expect(withAttachedImages("Fix it.", images.slice(0, 1))).toBe(
      'Fix it.\n\n[Attached image "bug.png" is saved at: C:/data/attachments/t/a.png]',
    );
  });
  it("leaves a prompt without images alone", () => {
    expect(withAttachedImages("Fix it.", [])).toBe("Fix it.");
  });
  it("takes up to ten image ids", () => {
    expect(LaunchAttachmentIds.safeParse(Array(10).fill(A)).success).toBe(true);
    expect(LaunchAttachmentIds.safeParse(Array(11).fill(A)).success).toBe(false);
    expect(LaunchAttachmentIds.safeParse(["nope"]).success).toBe(false);
  });
});
