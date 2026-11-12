import { StageSvg, useArtIds } from "./stageArt";

const GLOW = "oklch(0.93 0.2 120)";
const BODY = "oklch(0.32 0.05 40)";
const HEAD = "oklch(0.36 0.06 35)";
const WING = "oklch(0.9 0.04 230)";
const STAR = "oklch(0.96 0.03 230)";

// One tile of sky: [x, y, size]. Two of them get a small cross so the sky isn't only dots.
const STARS: ReadonlyArray<readonly [number, number, number]> = [
  [14, 9, 0.6],
  [38, 20, 0.4],
  [60, 6, 0.5],
  [92, 15, 0.7],
  [118, 5, 0.4],
  [140, 24, 0.45],
  [164, 10, 0.6],
  [196, 4, 0.5],
  [222, 18, 0.4],
  [248, 8, 0.65],
  [276, 14, 0.5],
  [290, 30, 0.4],
  [104, 32, 0.35],
  [30, 40, 0.35],
  [180, 36, 0.35],
  [268, 44, 0.3],
];
const SPARKLES: ReadonlyArray<readonly [number, number, number]> = [
  [164, 10, 3],
  [60, 6, 2.5],
];

/**
 * A cartoon firefly crossing a navy night sky, its dotted flight loop trailing behind. Still art: the bug sits right
 * of the wordmark, high enough that the sidebar's fade leaves its tail lit, and ends by x 245, so it stays whole at the narrowest sidebar; the stars tile across a wider one.
 */
export function FireflyArt() {
  const ids = useArtIds(["sky", "stars", "halo"] as const);
  return (
    <StageSvg art="firefly">
      <defs>
        <linearGradient id={ids.sky} x1="0" y1="0" x2="0" y2="96" gradientUnits="userSpaceOnUse">
          <stop stopColor="oklch(0.17 0.04 265)" />
          <stop offset="1" stopColor="oklch(0.26 0.06 250)" />
        </linearGradient>
        <pattern id={ids.stars} width="300" height="96" patternUnits="userSpaceOnUse">
          {STARS.map(([cx, cy, size]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={size * 1.4} fill={STAR} fillOpacity={0.5 + size * 0.6} />
          ))}
          {SPARKLES.map(([x, y, arm]) => (
            <path
              key={`${x}-${y}`}
              d={`M${x - arm} ${y}h${arm * 2}M${x} ${y - arm}v${arm * 2}`}
              stroke={STAR}
              strokeWidth="0.6"
              strokeOpacity="0.75"
            />
          ))}
        </pattern>
        <radialGradient id={ids.halo}>
          <stop stopColor={GLOW} stopOpacity="0.75" />
          <stop offset="0.45" stopColor={GLOW} stopOpacity="0.22" />
          <stop offset="1" stopColor={GLOW} stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect width="100%" height="96" fill={`url(#${ids.sky})`} />
      <rect width="100%" height="96" fill={`url(#${ids.stars})`} />
      {/* The flight loop: it starts low under the wordmark and curls once before reaching the tail. */}
      <path
        d="M102 58c22 6 40-2 46-14s-8-20-14-10 6 22 28 20 34-14 42-20"
        stroke={GLOW}
        strokeWidth="1.3"
        strokeDasharray="1.2 4"
        strokeLinecap="round"
        strokeOpacity="0.75"
      />

      {/* Drawn facing right around (0, 0): glowing tail, body, wings, then the head with its big eye. */}
      <g transform="translate(220 30) rotate(-14) scale(1.25)">
        <circle cx="-13" cy="3" r="13" fill={`url(#${ids.halo})`} />
        <ellipse cx="-12" cy="3" rx="7.5" ry="6" fill={GLOW} />
        <ellipse cx="-13.5" cy="1.5" rx="3" ry="2" fill="#fff" fillOpacity="0.7" />
        <ellipse cx="-2" cy="1" rx="7" ry="5.5" fill={BODY} />
        <path
          d="M-6 -2.5c0-.1 2 1 2 4M-2 -3.5c0 0 1.5 2 1.5 5"
          stroke="oklch(0.45 0.06 40)"
          strokeWidth="1"
          strokeLinecap="round"
        />
        <ellipse
          cx="-4"
          cy="-9"
          rx="8"
          ry="4.5"
          transform="rotate(-25 -4 -9)"
          fill={WING}
          fillOpacity="0.55"
          stroke="#fff"
          strokeOpacity="0.7"
          strokeWidth="0.7"
        />
        <ellipse
          cx="2"
          cy="-10"
          rx="7"
          ry="4"
          transform="rotate(-55 2 -10)"
          fill={WING}
          fillOpacity="0.45"
          stroke="#fff"
          strokeOpacity="0.7"
          strokeWidth="0.7"
        />
        <circle cx="7" cy="-1" r="5" fill={HEAD} />
        <path d="M5 -5.5l1 -1.8" stroke="oklch(0.62 0.18 30)" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="8.6" cy="-2" r="2.3" fill="#fff" />
        <circle cx="9.3" cy="-2" r="1.2" fill="#1b1b22" />
        <circle cx="9.7" cy="-2.5" r="0.4" fill="#fff" />
        <path d="M8 1.6q1.6 1.1 3 .1" stroke="#fff" strokeWidth="0.7" strokeLinecap="round" strokeOpacity="0.85" />
        <path d="M9 -5.5q2 -6 6 -7M7 -6q0 -6 3 -8.5" stroke={HEAD} strokeWidth="0.9" strokeLinecap="round" />
        <circle cx="15" cy="-12.5" r="1" fill={HEAD} />
        <circle cx="10" cy="-14.5" r="1" fill={HEAD} />
        <path d="M-1 5.5l-2 4M2 5.5l0 4.5M5 4.5l2 4" stroke={BODY} strokeWidth="0.9" strokeLinecap="round" />
      </g>
    </StageSvg>
  );
}
