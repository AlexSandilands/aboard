/** Art drawn behind the sidebar brand row. Every banner is dark so the white wordmark stays legible. */
export const STAGE_BANNERS = [
  { id: "nightly", label: "Nightly" },
  { id: "aurora", label: "Aurora" },
  { id: "dusk", label: "Dusk" },
  { id: "circuit", label: "Circuit" },
  { id: "cards", label: "Cards" },
] as const;

export type StageBannerId = (typeof STAGE_BANNERS)[number]["id"];
/** What the user picked: a specific banner, or a different one each day. */
export type StageBannerChoice = StageBannerId | "rotate";

export const DEFAULT_STAGE_BANNER: StageBannerId = "nightly";

const MS_PER_DAY = 86_400_000;

export function isStageBannerChoice(value: unknown): value is StageBannerChoice {
  return value === "rotate" || STAGE_BANNERS.some((banner) => banner.id === value);
}

/** The banner to draw. "rotate" steps through the list once per local calendar day. */
export function resolveStageBanner(choice: unknown, now: Date = new Date()): StageBannerId {
  if (!isStageBannerChoice(choice)) return DEFAULT_STAGE_BANNER;
  if (choice !== "rotate") return choice;
  // Count local days, not UTC ones, so the banner changes at the user's midnight.
  const day = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY);
  return STAGE_BANNERS[day % STAGE_BANNERS.length]!.id;
}
