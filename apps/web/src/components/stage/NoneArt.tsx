import { StageSvg } from "./stageArt";

/** Plain black, for people who want the wordmark without art. */
export function NoneArt() {
  return (
    <StageSvg art="none">
      <rect width="100%" height="96" fill="#000" />
    </StageSvg>
  );
}
