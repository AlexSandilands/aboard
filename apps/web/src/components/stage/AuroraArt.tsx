import { StageSvg, useArtIds } from "./stageArt";

const STARS: ReadonlyArray<{ cx: number; cy: number; r: number; opacity: number }> = [
  { cx: 18, cy: 8, r: 0.5, opacity: 0.7 },
  { cx: 66, cy: 5, r: 0.4, opacity: 0.5 },
  { cx: 122, cy: 9, r: 0.55, opacity: 0.75 },
  { cx: 176, cy: 4, r: 0.4, opacity: 0.5 },
  { cx: 214, cy: 12, r: 0.45, opacity: 0.6 },
  { cx: 262, cy: 6, r: 0.5, opacity: 0.7 },
  { cx: 92, cy: 24, r: 0.35, opacity: 0.4 },
  { cx: 238, cy: 30, r: 0.35, opacity: 0.4 },
];

// Each ribbon is one period of a smooth wave: it starts and ends at the same height and slope, so
// the 320-unit pattern tiles without a seam. Blur is applied after tiling for the same reason.
const RIBBONS = [
  { d: "M0 30C53 14 107 14 160 30S267 46 320 30", width: 9, opacity: 0.6 },
  { d: "M0 46C53 56 107 56 160 46S267 36 320 46", width: 7, opacity: 0.45 },
  { d: "M0 16C53 8 107 8 160 16S267 24 320 16", width: 5, opacity: 0.4 },
] as const;

/** Northern lights over a mountain ridge. */
export function AuroraArt() {
  const ids = useArtIds(["sky", "ribbon", "ribbons", "rays", "glow", "streak", "stars", "ridge"] as const);
  return (
    <StageSvg art="aurora">
      <defs>
        <linearGradient id={ids.sky} x1="0" y1="0" x2="0" y2="96" gradientUnits="userSpaceOnUse">
          <stop stopColor="oklch(0.17 0.04 245)" />
          <stop offset="0.6" stopColor="oklch(0.22 0.06 220)" />
          <stop offset="1" stopColor="oklch(0.27 0.07 195)" />
        </linearGradient>
        <linearGradient id={ids.ribbon} x1="0" y1="6" x2="0" y2="60" gradientUnits="userSpaceOnUse">
          <stop stopColor="oklch(0.68 0.17 300)" />
          <stop offset="0.45" stopColor="oklch(0.74 0.14 175)" />
          <stop offset="1" stopColor="oklch(0.76 0.18 150)" />
        </linearGradient>
        <filter id={ids.glow} x="-1%" y="-50%" width="102%" height="200%">
          <feGaussianBlur stdDeviation="5.5" />
        </filter>
        <filter id={ids.streak} x="-1%" y="-50%" width="102%" height="200%">
          <feGaussianBlur stdDeviation="0.8" />
        </filter>
        <pattern id={ids.ribbons} width="320" height="96" patternUnits="userSpaceOnUse">
          <g stroke={`url(#${ids.ribbon})`} strokeLinecap="round">
            {RIBBONS.map((ribbon) => (
              <path key={ribbon.d} d={ribbon.d} strokeWidth={ribbon.width} strokeOpacity={ribbon.opacity} />
            ))}
          </g>
        </pattern>
        {/* The same waves, dashed and thick, read as the hanging curtains of an aurora. */}
        <pattern id={ids.rays} width="320" height="96" patternUnits="userSpaceOnUse">
          <g stroke={`url(#${ids.ribbon})`} strokeDasharray="0.7 3" transform="translate(0 6)">
            {RIBBONS.slice(0, 2).map((ribbon) => (
              <path key={ribbon.d} d={ribbon.d} strokeWidth={ribbon.width * 2.4} strokeOpacity={ribbon.opacity * 0.3} />
            ))}
          </g>
        </pattern>
        <pattern id={ids.stars} width="288" height="96" patternUnits="userSpaceOnUse">
          {STARS.map((star) => (
            <circle
              key={`${star.cx}-${star.cy}`}
              cx={star.cx}
              cy={star.cy}
              r={star.r}
              fill="oklch(0.95 0.02 220)"
              fillOpacity={star.opacity}
            />
          ))}
        </pattern>
        <pattern id={ids.ridge} width="288" height="96" patternUnits="userSpaceOnUse">
          <path
            d="M0 96V72L20 62L34 68L58 50L80 64L98 58L122 72L146 56L170 68L192 54L216 70L240 60L262 68L288 72V96Z"
            fill="oklch(0.15 0.03 230)"
          />
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${ids.sky})`} />
      <rect width="100%" height="96" fill={`url(#${ids.stars})`} />
      <rect width="100%" height="96" fill={`url(#${ids.ribbons})`} filter={`url(#${ids.glow})`} />
      <rect width="100%" height="96" fill={`url(#${ids.rays})`} filter={`url(#${ids.streak})`} />
      <rect width="100%" height="96" fill={`url(#${ids.ridge})`} />
    </StageSvg>
  );
}
