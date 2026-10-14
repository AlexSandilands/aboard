import { StageSvg, useArtIds } from "./stageArt";

const COLUMN_WIDTH = 72;
const CARD = { width: 56, height: 14, inset: 8 };

// Accent hues echo the board's status colours.
const ACCENTS = {
  violet: "oklch(0.7 0.17 295)",
  amber: "oklch(0.8 0.15 75)",
  emerald: "oklch(0.75 0.15 160)",
  sky: "oklch(0.75 0.13 235)",
} as const;

type Accent = keyof typeof ACCENTS;

/** Three columns per tile, with different card counts so the repeat is less obvious. */
const COLUMNS: ReadonlyArray<ReadonlyArray<Accent | null>> = [
  ["violet", null, "sky", null],
  [null, "amber"],
  ["emerald", null, null, "violet", null],
];

/** A tiny kanban board: columns of cards, one of them mid-drag. */
export function CardsArt() {
  const ids = useArtIds(["bg", "glow", "glows", "board", "shadow"] as const);
  return (
    <StageSvg art="cards">
      <defs>
        <linearGradient
          id={ids.bg}
          x1="0"
          y1="0"
          x2="260"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop stopColor="oklch(0.25 0.08 280)" />
          <stop offset="1" stopColor="oklch(0.19 0.05 255)" />
        </linearGradient>
        <radialGradient
          id={ids.glow}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(200 10) rotate(140) scale(140 90)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="oklch(0.6 0.16 285)" stopOpacity="0.3" />
          <stop offset="1" stopColor="oklch(0.6 0.16 285)" stopOpacity="0" />
        </radialGradient>
        <pattern id={ids.glows} width="600" height="96" patternUnits="userSpaceOnUse">
          <rect width="600" height="96" fill={`url(#${ids.glow})`} />
        </pattern>
        <filter id={ids.shadow} x="-20%" y="-40%" width="140%" height="200%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="black" floodOpacity="0.45" />
        </filter>
        <pattern id={ids.board} width={COLUMN_WIDTH * COLUMNS.length} height="96" patternUnits="userSpaceOnUse">
          {COLUMNS.map((cards, column) => {
            const x = column * COLUMN_WIDTH + CARD.inset / 2;
            return (
              <g key={x}>
                <rect x={x} y="3" width={CARD.width + CARD.inset} height="96" rx="4" fill="white" fillOpacity="0.03" />
                {cards.map((accent, row) => {
                  const y = 7 + row * 18;
                  return <MiniCard key={y} x={x + CARD.inset / 2} y={y} accent={accent} />;
                })}
              </g>
            );
          })}
          <g transform="translate(86 44) rotate(-6)" filter={`url(#${ids.shadow})`}>
            <MiniCard x={0} y={0} accent="sky" lifted />
          </g>
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${ids.bg})`} />
      <rect width="100%" height="96" fill={`url(#${ids.glows})`} />
      <rect width="100%" height="96" fill={`url(#${ids.board})`} />
    </StageSvg>
  );
}

function MiniCard({ x, y, accent, lifted = false }: { x: number; y: number; accent: Accent | null; lifted?: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect
        width={CARD.width}
        height={CARD.height}
        rx="2.5"
        fill={lifted ? "oklch(0.36 0.07 275)" : "white"}
        fillOpacity={lifted ? 1 : 0.045}
        stroke="white"
        strokeOpacity={lifted ? 0.3 : 0.09}
        strokeWidth="0.6"
      />
      {accent ? (
        <rect x="3" y="3.5" width="1.6" height="7" rx="0.8" fill={ACCENTS[accent]} fillOpacity={lifted ? 1 : 0.75} />
      ) : null}
      <rect x="7" y="4" width={lifted ? 32 : 28} height="2" rx="1" fill="white" fillOpacity={lifted ? 0.5 : 0.13} />
      <rect x="7" y="8" width="18" height="2" rx="1" fill="white" fillOpacity={lifted ? 0.3 : 0.08} />
    </g>
  );
}
