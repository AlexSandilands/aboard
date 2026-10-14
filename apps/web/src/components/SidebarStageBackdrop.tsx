import type { ComponentType } from "react";
import { useAppearance } from "~/state/ui";
import { AuroraArt } from "./stage/AuroraArt";
import { CardsArt } from "./stage/CardsArt";
import { CircuitArt } from "./stage/CircuitArt";
import { DuskArt } from "./stage/DuskArt";
import { HexArt } from "./stage/HexArt";
import { NightlyArt } from "./stage/NightlyArt";
import { NoneArt } from "./stage/NoneArt";
import { type StageBannerId, resolveStageBanner } from "./stage/stageBanner.logic";
import { WiresArt } from "./stage/WiresArt";

const STAGE_ART: Record<StageBannerId, ComponentType> = {
  nightly: NightlyArt,
  aurora: AuroraArt,
  dusk: DuskArt,
  circuit: CircuitArt,
  cards: CardsArt,
  hex: HexArt,
  wires: WiresArt,
  none: NoneArt,
};

/**
 * Header art for the sidebar. Static; no animation. Shows the user's banner unless one is passed.
 * Put `stage-ink` on the container and colour text with `--stage-ink` so it stays legible.
 */
export function SidebarStageBackdrop({ banner }: { banner?: StageBannerId }) {
  const choice = useAppearance((s) => s.banner);
  const Art = STAGE_ART[banner ?? resolveStageBanner(choice)];
  return (
    <div
      aria-hidden
      className="sidebar-stage-backdrop pointer-events-none absolute inset-x-0 top-0 z-0 h-20 select-none overflow-hidden"
    >
      <Art />
    </div>
  );
}
