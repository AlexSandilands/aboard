import { StageSvg, useArtIds } from "./stageArt";

const TILE = 240;
const INK = "var(--stage-mono-ink)";
const PAPER = "var(--stage-mono-bg)";

/**
 * A bundle of parallel cables that leaves its lane, runs across the tile and comes back. The
 * detour sits right of x=100 so the wordmark (x≈20–80) only ever has straight runs behind it.
 */
function bundle(lane: number, detour: number, from: number, to: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const y = lane + i * 3.2;
    const y2 = detour + i * 3.2;
    return `M0 ${y}H${from}C${from + 16} ${y} ${from + 16} ${y2} ${from + 32} ${y2}H${to}C${to + 16} ${y2} ${to + 16} ${y} ${to + 32} ${y}H${TILE}`;
  });
}

const TOP = bundle(7, 40, 118, 186, 4);
const BOTTOM = bundle(51, 22, 104, 196, 3);
// A single patch cable under the top bundle that drops to a plug. The plug sits short of x=225,
// where the brand row's icon buttons start at the default sidebar width.
const PATCH = "M0 20.6H76C94 20.6 104 24 104 31";

/** Network cables as hollow stencil lines, black on white or white on black with the theme. */
export function WiresArt() {
  const ids = useArtIds(["cables"] as const);
  return (
    <StageSvg art="wires" tone="theme">
      <defs>
        <pattern id={ids.cables} width={TILE} height="96" patternUnits="userSpaceOnUse">
          {/* Each bundle is drawn ink-then-paper, so cables read as outlined tubes and the later
              bundle hides the one it crosses. */}
          {[BOTTOM, TOP].map((cables) => (
            <g key={cables[0]} strokeLinecap="round" strokeLinejoin="round">
              <g stroke={INK} strokeOpacity="0.4" strokeWidth="2.6">
                {cables.map((d) => (
                  <path key={d} d={d} />
                ))}
              </g>
              <g stroke={PAPER} strokeWidth="1.2">
                {cables.map((d) => (
                  <path key={d} d={d} />
                ))}
              </g>
            </g>
          ))}
          <path d={PATCH} stroke={INK} strokeOpacity="0.4" strokeWidth="2.6" strokeLinecap="round" />
          <path d={PATCH} stroke={PAPER} strokeWidth="1.2" strokeLinecap="round" />
          <Plug x={100} y={31} />
          {/* Cable ties on the straight runs. */}
          <g fill={INK} fillOpacity="0.45">
            <rect x="98" y="5" width="2.4" height="15.6" rx="1" />
            <rect x="84" y="49" width="2.4" height="9.4" rx="1" />
          </g>
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={PAPER} />
      <rect width="100%" height="96" fill={`url(#${ids.cables})`} />
    </StageSvg>
  );
}

/** An RJ45 plug facing down: body, latch tab and contact lines. */
function Plug({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`} stroke={INK} strokeOpacity="0.5" strokeWidth="0.8">
      <rect width="8" height="9" rx="1" fill={PAPER} />
      <path d="M2.5 9V11H5.5V9" fill="none" />
      <path d="M2 2.5V5M4 2.5V5M6 2.5V5" strokeWidth="0.5" />
    </g>
  );
}
