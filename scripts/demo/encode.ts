/**
 * Turns a take recorded by director.ts into the README GIF: replays the frames at a constant 30 fps, applies the zooms (a crop
 * of the 2x frames, so they stay sharp), trims, scales, then encodes with gifski, or ffmpeg's palettegen when gifski
 * isn't installed. Run on its own to re-encode a take without recording again:
 *
 *   node scripts/demo/encode.ts <take dir> [--out file.gif] [--width 1280] [--fps 20] [--quality 90]
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A rectangle in CSS pixels of the recorded viewport. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** From `at` (seconds into the take) over `ms`, ease the view onto `rect`, or back to the whole viewport when null. */
export interface Zoom {
  at: number;
  ms: number;
  rect: Rect | null;
}

export interface Timeline {
  /** The viewport in CSS pixels and the device scale it was captured at. */
  viewport: { width: number; height: number; scale: number };
  /** The part of the take to keep, in seconds. */
  start: number;
  end: number;
  zooms: Zoom[];
}

export interface EncodeOptions {
  out: string;
  width: number;
  fps: number;
  quality: number;
  /** Warn above this many bytes. */
  budget: number;
}

export const DEFAULT_ENCODE: Omit<EncodeOptions, "out"> = {
  width: 1280,
  fps: 20,
  quality: 90,
  budget: 20 * 1024 * 1024,
};

/** The view as zoompan takes it: the visible width and centre, in source pixels. */
interface View {
  w: number;
  cx: number;
  cy: number;
}

const MAX_ZOOM = 2.2;

/** The view showing `rect` with some room around it, kept inside the frame and at the viewport's aspect. */
function viewOf(rect: Rect | null, { width, height, scale }: Timeline["viewport"]): View {
  if (!rect) return { w: width * scale, cx: (width * scale) / 2, cy: (height * scale) / 2 };
  const aspect = width / height;
  // Never closer than MAX_ZOOM: a single card filling the frame loses where it is on the board.
  const w = Math.min(width, Math.max(rect.width * 1.12, rect.height * 1.12 * aspect, width / MAX_ZOOM));
  const h = w / aspect;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const cx = clamp(rect.x + rect.width / 2, w / 2, width - w / 2);
  const cy = clamp(rect.y + rect.height / 2, h / 2, height - h / 2);
  return { w: w * scale, cx: cx * scale, cy: cy * scale };
}

/** easeInOutCubic of the progress `p` (0 to 1), as an ffmpeg expression. */
const eased = (p: string) => `if(lt(${p},0.5),4*pow(${p},3),1-pow(-2*${p}+2,3)/2)`;

/** One view field over time: held between zooms, eased during them. `it` is the input frame's time. */
function expression(timeline: Timeline, field: keyof View): string {
  const views = [viewOf(null, timeline.viewport), ...timeline.zooms.map((z) => viewOf(z.rect, timeline.viewport))];
  let expr = views.at(-1)![field].toFixed(2);
  for (let i = timeline.zooms.length - 1; i >= 0; i--) {
    const zoom = timeline.zooms[i]!;
    const from = views[i]![field];
    const to = views[i + 1]![field];
    const end = zoom.at + zoom.ms / 1000;
    const p = `((it-${zoom.at.toFixed(3)})/${(zoom.ms / 1000).toFixed(3)})`;
    const during = `${from.toFixed(2)}+(${(to - from).toFixed(2)})*${eased(p)}`;
    const before = from.toFixed(2);
    expr = `if(lt(it,${zoom.at.toFixed(3)}),${before},if(lt(it,${end.toFixed(3)}),${during},${expr}))`;
  }
  return expr;
}

function zoompan(timeline: Timeline, fps: number): string {
  const { width, height, scale } = timeline.viewport;
  const w = expression(timeline, "w");
  // Two chained nested ifs per field; zoompan evaluates them per frame with `it` in seconds.
  return (
    `zoompan=z='${width * scale}/(${w})'` +
    `:x='(${expression(timeline, "cx")})-iw/zoom/2'` +
    `:y='(${expression(timeline, "cy")})-ih/zoom/2'` +
    `:d=1:fps=${fps}:s=${width * scale}x${height * scale}`
  );
}

/** The rate the captured frames are replayed at for zoompan, which steps one output frame per input frame. */
const REPLAY_FPS = 30;

/**
 * The screencast only sends a frame when something painted. This lays them out at a constant rate, each slot
 * holding the newest frame painted by then, as numbered links ffmpeg reads as an image sequence.
 */
function replayAt(takeDir: string, fps: number): string {
  const framesDir = join(takeDir, "frames");
  const { duration, frames } = JSON.parse(readFileSync(join(framesDir, "frames.json"), "utf8")) as {
    duration: number;
    frames: { file: string; at: number }[];
  };
  const dir = join(takeDir, "cfr");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  let next = 0;
  for (let i = 0; i < Math.floor(duration * fps); i++) {
    while (next + 1 < frames.length && frames[next + 1]!.at <= i / fps) next++;
    const from = join(framesDir, frames[next]!.file);
    const to = join(dir, `${String(i).padStart(5, "0")}.jpg`);
    // Windows refuses symlinks without Developer Mode; a copy works everywhere.
    try {
      symlinkSync(from, to);
    } catch {
      copyFileSync(from, to);
    }
  }
  return dir;
}

const has = (cmd: string) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;

export function encode(takeDir: string, options: EncodeOptions): void {
  const timeline = JSON.parse(readFileSync(join(takeDir, "timeline.json"), "utf8")) as Timeline;
  const pngDir = join(takeDir, "png");
  rmSync(pngDir, { recursive: true, force: true });
  mkdirSync(pngDir);
  const cfrDir = replayAt(takeDir, REPLAY_FPS);
  const filter = [
    `trim=start=${timeline.start.toFixed(3)}:end=${timeline.end.toFixed(3)}`,
    zoompan(timeline, REPLAY_FPS),
    `fps=${options.fps}`,
    `scale=${options.width}:-2:flags=lanczos`,
  ].join(",");
  const script = join(takeDir, "filter.txt");
  writeFileSync(script, filter);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      String(REPLAY_FPS),
      "-i",
      join(cfrDir, "%05d.jpg"),
      "-/filter:v",
      script,
      // Without it the image muxer is variable-rate and drops the frames fps repeated, which speeds the take up.
      "-fps_mode",
      "passthrough",
      join(pngDir, "%05d.png"),
    ],
    { stdio: "inherit" },
  );
  const pngs = readdirSync(pngDir)
    .filter((f) => f.endsWith(".png"))
    .sort()
    .map((f) => join(pngDir, f));
  const out = resolve(options.out);
  if (has("gifski")) {
    execFileSync(
      "gifski",
      // Without --width gifski shrinks anything over about 800x600, halving the frames scale= made.
      [
        "--quiet",
        "--width",
        String(options.width),
        "--fps",
        String(options.fps),
        "--quality",
        String(options.quality),
        "-o",
        out,
        ...pngs,
      ],
      { stdio: "inherit" },
    );
  } else {
    console.warn("[demo] gifski isn't installed; falling back to ffmpeg's palettegen, which bands more");
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-framerate",
        String(options.fps),
        "-i",
        join(pngDir, "%05d.png"),
        "-vf",
        "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a",
        out,
      ],
      { stdio: "inherit" },
    );
  }
  const size = statSync(out).size;
  const mb = (size / 1024 / 1024).toFixed(2);
  const seconds = (pngs.length / options.fps).toFixed(1);
  console.log(`[demo] wrote ${out}: ${seconds}s, ${pngs.length} frames, ${mb} MB`);
  if (size > options.budget) {
    console.warn(`[demo] over the ${(options.budget / 1024 / 1024).toFixed(0)} MB budget: lower --quality or --width`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [takeDir, ...rest] = process.argv.slice(2);
  if (!takeDir) {
    console.error("usage: node scripts/demo/encode.ts <take dir> [--out file.gif] [--width n] [--fps n] [--quality n]");
    process.exit(1);
  }
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  encode(takeDir, {
    ...DEFAULT_ENCODE,
    out: flag("out") ?? join(takeDir, "demo.gif"),
    ...(flag("width") ? { width: Number(flag("width")) } : {}),
    ...(flag("fps") ? { fps: Number(flag("fps")) } : {}),
    ...(flag("quality") ? { quality: Number(flag("quality")) } : {}),
  });
}
