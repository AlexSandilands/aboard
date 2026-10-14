import { StageSvg, useArtIds } from "./stageArt";

// One 192-unit tile. Traces that leave an edge come back in at the same height on the other side.
const TRACES = [
  "M0 20H40L52 32H110L122 20H192",
  "M0 58H18L30 46H64",
  "M150 58H192",
  "M80 96V78L92 66H140",
  "M150 0V8L160 18V40L170 50H182",
  "M8 96V84L20 72H48",
  "M110 32V44",
  "M70 0V8L76 14",
] as const;

const PADS: ReadonlyArray<{ x: number; y: number; lit?: boolean }> = [
  { x: 64, y: 46, lit: true },
  { x: 150, y: 58 },
  { x: 140, y: 66, lit: true },
  { x: 182, y: 50 },
  { x: 48, y: 72 },
  { x: 110, y: 44 },
  { x: 76, y: 14 },
];

const TRACE_COLOR = "oklch(0.78 0.13 180)";
const BOARD_COLOR = "oklch(0.19 0.04 215)";

/** Printed-circuit traces on a dotted board. */
export function CircuitArt() {
  const ids = useArtIds(["board", "glow", "glows", "dots", "traces", "pulse"] as const);
  return (
    <StageSvg art="circuit">
      <defs>
        <linearGradient
          id={ids.board}
          x1="0"
          y1="0"
          x2="240"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop stopColor="oklch(0.17 0.035 240)" />
          <stop offset="1" stopColor={BOARD_COLOR} />
        </linearGradient>
        <radialGradient
          id={ids.glow}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(230 20) rotate(150) scale(130 80)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="oklch(0.6 0.12 185)" stopOpacity="0.3" />
          <stop offset="1" stopColor="oklch(0.6 0.12 185)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={ids.pulse}>
          <stop stopColor="oklch(0.88 0.15 175)" stopOpacity="0.55" />
          <stop offset="1" stopColor="oklch(0.88 0.15 175)" stopOpacity="0" />
        </radialGradient>
        <pattern id={ids.glows} width="560" height="96" patternUnits="userSpaceOnUse">
          <rect width="560" height="96" fill={`url(#${ids.glow})`} />
        </pattern>
        <pattern id={ids.dots} width="8" height="8" patternUnits="userSpaceOnUse">
          <circle cx="4" cy="4" r="0.35" fill={TRACE_COLOR} fillOpacity="0.22" />
        </pattern>
        <pattern id={ids.traces} width="192" height="96" patternUnits="userSpaceOnUse">
          <g stroke={TRACE_COLOR} strokeOpacity="0.5" strokeWidth="0.8" strokeLinejoin="round">
            {TRACES.map((d) => (
              <path key={d} d={d} />
            ))}
          </g>
          {PADS.map((pad) =>
            pad.lit ? (
              <circle key={`${pad.x}-${pad.y}-glow`} cx={pad.x} cy={pad.y} r="7" fill={`url(#${ids.pulse})`} />
            ) : null,
          )}
          {PADS.map((pad) => (
            <circle
              key={`${pad.x}-${pad.y}`}
              cx={pad.x}
              cy={pad.y}
              r="1.6"
              fill={pad.lit ? "oklch(0.9 0.12 175)" : BOARD_COLOR}
              stroke={TRACE_COLOR}
              strokeOpacity="0.7"
              strokeWidth="0.7"
            />
          ))}
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${ids.board})`} />
      <rect width="100%" height="96" fill={`url(#${ids.glows})`} />
      <rect width="100%" height="96" fill={`url(#${ids.dots})`} />
      <rect width="100%" height="96" fill={`url(#${ids.traces})`} />
    </StageSvg>
  );
}
