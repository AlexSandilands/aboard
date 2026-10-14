/**
 * Art drawn behind the sidebar brand row. "dark" banners keep a white wordmark in both themes;
 * "theme" banners are black or white with the theme and the wordmark follows (see `stage-ink`).
 * Plain options (`rotates: false`) are never picked by "Rotate daily".
 */
export const STAGE_BANNERS = [
  { id: "nightly", label: "Nightly", tone: "dark", rotates: true },
  { id: "aurora", label: "Aurora", tone: "dark", rotates: true },
  { id: "dusk", label: "Dusk", tone: "dark", rotates: true },
  { id: "circuit", label: "Circuit", tone: "dark", rotates: true },
  { id: "cards", label: "Cards", tone: "dark", rotates: true },
  { id: "hex", label: "Hex", tone: "dark", rotates: true },
  { id: "hex-mono", label: "Hex mono", tone: "theme", rotates: true },
  { id: "wires", label: "Wires", tone: "theme", rotates: true },
  { id: "black", label: "Black", tone: "dark", rotates: false },
  // No art at all: the brand row shows the plain sidebar background.
  { id: "none", label: "None", tone: "theme", rotates: false },
] as const;

export type StageBannerId = (typeof STAGE_BANNERS)[number]["id"];
/** What the user picked: a specific banner, or a different one each day. */
export type StageBannerChoice = StageBannerId | "rotate";

export const DEFAULT_STAGE_BANNER: StageBannerId = "nightly";

const ROTATION = STAGE_BANNERS.filter((banner) => banner.rotates);
const MS_PER_DAY = 86_400_000;

export function isStageBannerChoice(value: unknown): value is StageBannerChoice {
  return value === "rotate" || STAGE_BANNERS.some((banner) => banner.id === value);
}

/** The banner to draw. "rotate" steps through the rotating banners once per local calendar day. */
export function resolveStageBanner(choice: unknown, now: Date = new Date()): StageBannerId {
  if (!isStageBannerChoice(choice)) return DEFAULT_STAGE_BANNER;
  if (choice !== "rotate") return choice;
  // Count local days, not UTC ones, so the banner changes at the user's midnight.
  const day = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY);
  return ROTATION[day % ROTATION.length]!.id;
}
