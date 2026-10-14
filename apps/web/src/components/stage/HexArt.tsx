import { StageSvg, useArtIds } from "./stageArt";

// Pointy-top hexagons. One grid tile is two rows high so odd rows can sit half a cell over.
const R = 7;
const W = Math.sqrt(3) * R;
const ROW = 1.5 * R;

function hexPath(cx: number, cy: number, r = R): string {
  const points = [-90, -30, 30, 90, 150, 210].map((deg) => {
    const rad = (deg * Math.PI) / 180;
    return `${(cx + r * Math.cos(rad)).toFixed(2)} ${(cy + r * Math.sin(rad)).toFixed(2)}`;
  });
  return `M${points.join("L")}Z`;
}

const GRID_CELLS = [hexPath(0, 0), hexPath(W, 0), hexPath(W / 2, ROW), hexPath(0, 2 * ROW), hexPath(W, 2 * ROW)];

// Lit cells repeat on a 7×6 cell block, a multiple of the grid tile so they stay on the grid.
const LIT_COLS = 7;
const LIT_ROWS = 6;
const LIT: ReadonlyArray<{ col: number; row: number; opacity: number }> = [
  { col: 1, row: 1, opacity: 0.45 },
  { col: 4, row: 2, opacity: 0.25 },
  { col: 2, row: 4, opacity: 0.35 },
  { col: 6, row: 5, opacity: 0.2 },
  { col: 5, row: 0, opacity: 0.3 },
  { col: 5, row: 1, opacity: 0.15 },
];

function cellCenter(col: number, row: number): [number, number] {
  return [col * W + (row % 2 === 1 ? W / 2 : 0), row * ROW];
}

/** A honeycomb grid that fades out towards the wordmark, with a few lit cells. */
export function HexArt() {
  const ids = useArtIds(["bg", "grid", "lit", "fade", "mask"] as const);
  return (
    <StageSvg art="hex">
      <defs>
        <linearGradient id={ids.bg} x1="0" y1="0" x2="280" y2="96" gradientUnits="userSpaceOnUse">
          <stop stopColor="oklch(0.15 0.02 260)" />
          <stop offset="1" stopColor="oklch(0.2 0.05 255)" />
        </linearGradient>
        <pattern id={ids.grid} width={W} height={2 * ROW} patternUnits="userSpaceOnUse">
          <g stroke="oklch(0.75 0.11 230)" strokeOpacity="0.4" strokeWidth="0.6">
            {GRID_CELLS.map((d) => (
              <path key={d} d={d} />
            ))}
          </g>
        </pattern>
        <pattern id={ids.lit} width={LIT_COLS * W} height={LIT_ROWS * ROW} patternUnits="userSpaceOnUse">
          {LIT.map(({ col, row, opacity }) => {
            const [cx, cy] = cellCenter(col, row);
            return (
              <path
                key={`${col}-${row}`}
                d={hexPath(cx, cy, R - 1.2)}
                fill="oklch(0.72 0.14 220)"
                fillOpacity={opacity}
              />
            );
          })}
        </pattern>
        {/* Clear behind the wordmark, full strength from mid-sidebar on, and on wider sidebars. */}
        <linearGradient id={ids.fade} x1="40" y1="0" x2="230" y2="0" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" stopOpacity="0" />
          <stop offset="1" stopColor="white" />
        </linearGradient>
        <mask id={ids.mask} maskUnits="userSpaceOnUse" x="0" y="0" width="8192" height="96">
          <rect width="8192" height="96" fill={`url(#${ids.fade})`} />
        </mask>
      </defs>

      <rect width="100%" height="96" fill={`url(#${ids.bg})`} />
      <g mask={`url(#${ids.mask})`}>
        <rect width="100%" height="96" fill={`url(#${ids.grid})`} />
        <rect width="100%" height="96" fill={`url(#${ids.lit})`} />
      </g>
    </StageSvg>
  );
}
