import { StageSvg } from "./stageArt";

/** Plain black in both themes. */
export function BlackArt() {
  return (
    <StageSvg art="black">
      <rect width="100%" height="96" fill="#000" />
    </StageSvg>
  );
}
