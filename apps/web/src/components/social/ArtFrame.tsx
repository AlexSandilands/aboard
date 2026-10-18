import type { SocialPostKind } from "@repo/contracts";
import { useMemo } from "react";
import { ART_FRAME_ALLOW, ART_FRAME_CSP, ART_FRAME_SANDBOX, artDocument } from "./artFrame.logic";

/**
 * A piece of agent art, running live in its locked-down frame (see artFrame.logic.ts). `csp` is CSP Embedded
 * Enforcement: where the browser supports it (Chromium, so Electron too) the frame can't load any document that
 * doesn't accept the policy, which stops the piece navigating itself somewhere that would let it reach the network.
 */
export function ArtFrame({
  kind,
  body,
  title,
}: {
  kind: Exclude<SocialPostKind, "text">;
  body: string;
  title: string;
}) {
  const srcDoc = useMemo(() => artDocument(kind, body), [kind, body]);
  return (
    <iframe
      title={title}
      sandbox={ART_FRAME_SANDBOX}
      srcDoc={srcDoc}
      allow={ART_FRAME_ALLOW}
      referrerPolicy="no-referrer"
      loading="lazy"
      {...{ csp: ART_FRAME_CSP }}
      className="block aspect-[4/3] w-full max-w-xl rounded-lg border border-border/60 bg-white"
    />
  );
}
