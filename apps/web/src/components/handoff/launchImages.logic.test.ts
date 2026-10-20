import { MAX_LAUNCH_IMAGES } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { admitImages, launchImageIds, launchImagesBlocker, markUploaded, type LaunchImage } from "./launchImages.logic";

const uploading = (key: string): LaunchImage => ({ key, name: `${key}.png`, status: "uploading" });
const ready = (key: string, id = `id-${key}`): LaunchImage => ({ key, name: `${key}.png`, status: "ready", id });

describe("launch images", () => {
  it("admits images up to the limit and says why the rest were left out", () => {
    expect(admitImages([], ["a", "b"])).toEqual({ admitted: ["a", "b"], error: null });
    const nine = Array.from({ length: MAX_LAUNCH_IMAGES - 1 }, (_, i) => ready(String(i)));
    expect(admitImages(nine, ["a", "b"])).toEqual({ admitted: ["a"], error: "A launch takes up to 10 images." });
    expect(admitImages([...nine, ready("x")], ["a"]).admitted).toEqual([]);
  });

  it("sends the uploaded ids in the order the images were added", () => {
    const images = [ready("a"), uploading("b"), ready("c")];
    expect(launchImageIds(images)).toEqual(["id-a", "id-c"]);
    expect(launchImageIds(markUploaded(images, "b", "id-b"))).toEqual(["id-a", "id-b", "id-c"]);
  });

  it("holds the launch while an image is still uploading", () => {
    expect(launchImagesBlocker([ready("a"), uploading("b")])).toBe("Wait for the images to upload");
    expect(launchImagesBlocker([ready("a")])).toBeNull();
    expect(launchImagesBlocker([])).toBeNull();
  });
});
