import { StageSvg, useArtIds } from "./stageArt";

const STARS: ReadonlyArray<{ cx: number; cy: number; r: number }> = [
  { cx: 22, cy: 7, r: 0.45 },
  { cx: 74, cy: 13, r: 0.35 },
  { cx: 118, cy: 5, r: 0.5 },
  { cx: 208, cy: 9, r: 0.4 },
  { cx: 252, cy: 16, r: 0.35 },
];

const SUN = { cx: 172, cy: 54, r: 20 };
// Gaps cut across the lower half of the sun, widening towards the horizon.
const SUN_GAPS: ReadonlyArray<{ y: number; h: number }> = [
  { y: 52, h: 1 },
  { y: 56, h: 1.4 },
  { y: 60.5, h: 1.8 },
  { y: 65.5, h: 2.2 },
  { y: 71, h: 2.6 },
];

/** A striped retro sun setting behind rolling hills. */
export function DuskArt() {
  const ids = useArtIds(["sky", "sun", "halo", "cut", "stars", "far", "near"] as const);
  return (
    <StageSvg art="dusk">
      <defs>
        <linearGradient id={ids.sky} x1="0" y1="0" x2="0" y2="96" gradientUnits="userSpaceOnUse">
          <stop stopColor="oklch(0.2 0.07 295)" />
          <stop offset="0.42" stopColor="oklch(0.3 0.12 330)" />
          <stop offset="0.78" stopColor="oklch(0.5 0.17 15)" />
          <stop offset="1" stopColor="oklch(0.66 0.16 50)" />
        </linearGradient>
        <linearGradient
          id={ids.sun}
          x1="0"
          y1={SUN.cy - SUN.r}
          x2="0"
          y2={SUN.cy + SUN.r}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="oklch(0.93 0.12 95)" />
          <stop offset="0.5" stopColor="oklch(0.8 0.17 55)" />
          <stop offset="1" stopColor="oklch(0.66 0.22 10)" />
        </linearGradient>
        <radialGradient id={ids.halo} cx={SUN.cx} cy={SUN.cy} r={SUN.r * 3} gradientUnits="userSpaceOnUse">
          <stop stopColor="oklch(0.78 0.17 40)" stopOpacity="0.45" />
          <stop offset="1" stopColor="oklch(0.78 0.17 40)" stopOpacity="0" />
        </radialGradient>
        <mask id={ids.cut} maskUnits="userSpaceOnUse" x="0" y="0" width="400" height="96">
          <rect width="400" height="96" fill="white" />
          {SUN_GAPS.map((gap) => (
            <rect key={gap.y} y={gap.y} width="400" height={gap.h} fill="black" />
          ))}
        </mask>
        <pattern id={ids.stars} width="288" height="96" patternUnits="userSpaceOnUse">
          {STARS.map((star) => (
            <circle
              key={`${star.cx}-${star.cy}`}
              cx={star.cx}
              cy={star.cy}
              r={star.r}
              fill="oklch(0.95 0.03 330)"
              fillOpacity="0.6"
            />
          ))}
        </pattern>
        {/* One full wave per tile, so both hill lines meet themselves at the tile edge. */}
        <pattern id={ids.far} width="240" height="96" patternUnits="userSpaceOnUse">
          <path d="M0 78C40 70 80 70 120 78S200 86 240 78V96H0Z" fill="oklch(0.32 0.11 340)" fillOpacity="0.9" />
        </pattern>
        <pattern id={ids.near} width="360" height="96" patternUnits="userSpaceOnUse">
          <path d="M0 86C60 76 120 76 180 86S300 96 360 86V96H0Z" fill="oklch(0.2 0.07 300)" />
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${ids.sky})`} />
      <rect width="100%" height="96" fill={`url(#${ids.stars})`} />
      <circle cx={SUN.cx} cy={SUN.cy} r={SUN.r * 3} fill={`url(#${ids.halo})`} />
      <circle cx={SUN.cx} cy={SUN.cy} r={SUN.r} fill={`url(#${ids.sun})`} mask={`url(#${ids.cut})`} />
      <rect width="100%" height="96" fill={`url(#${ids.far})`} />
      <rect width="100%" height="96" fill={`url(#${ids.near})`} />
    </StageSvg>
  );
}
