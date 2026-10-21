import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CDPSession, Page } from "playwright";

/** One captured frame: its file and when the browser painted it, in seconds since the recording started. */
interface Frame {
  file: string;
  at: number;
}

export interface Recording {
  /** Seconds since the recording started, on the same clock as the frames. */
  now(): number;
  /** Stops capturing and writes `frames.json`: each frame's file and when it was painted. */
  stop(): Promise<{ duration: number }>;
}

/**
 * Records the page with Chromium's screencast rather than Playwright's video, which is a low-bitrate VP8 at CSS
 * size. Frames come at device pixels (so a zoom in post stays sharp) and only when something painted, each with the
 * time it arrived, so encode.ts can replay them at their real pace.
 */
export async function startRecording(
  page: Page,
  dir: string,
  size: { width: number; height: number },
): Promise<Recording> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const frames: Frame[] = [];
  const started = performance.now();
  const now = () => (performance.now() - started) / 1000;
  cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
    const file = `${String(frames.length).padStart(5, "0")}.jpg`;
    writeFileSync(join(dir, file), Buffer.from(data, "base64"));
    // Arrival time rather than the metadata's compositor clock: close enough at this rate, and on the same clock as
    // now(), which the director's zoom keyframes use.
    frames.push({ file, at: now() });
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  // Without a size the frames come at CSS pixels, not device pixels.
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 92,
    everyNthFrame: 1,
    maxWidth: size.width,
    maxHeight: size.height,
  });
  return {
    now,
    async stop() {
      await cdp.send("Page.stopScreencast");
      const duration = now();
      writeFileSync(join(dir, "frames.json"), JSON.stringify({ duration, frames }));
      return { duration };
    },
  };
}
