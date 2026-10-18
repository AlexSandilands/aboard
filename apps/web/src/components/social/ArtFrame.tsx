import { PlayIcon, SquareIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { ART_FRAME_ALLOW, ART_FRAME_SANDBOX, artDocument, artFrameCsp, type ArtKind } from "./artFrame.logic";

const FRAME_CLASS = "block aspect-[4/3] w-full max-w-xl rounded-lg border border-border/60";

/**
 * A piece of agent art in its locked-down frame (see artFrame.logic.ts). `csp` is CSP Embedded Enforcement: where the
 * browser supports it (Chromium, so Electron too) the frame can't load any document that doesn't accept the policy,
 * which stops the piece navigating itself somewhere that would let it reach the network.
 *
 * An HTML piece runs only once it's asked to, and can be stopped: a sandboxed frame may share the board's process, so a
 * runaway loop would otherwise slow or hang the page. SVG has no script, so it shows straight away.
 */
export function ArtFrame({ kind, body, title }: { kind: ArtKind; body: string; title: string }) {
  const [running, setRunning] = useState(kind === "svg");
  const srcDoc = useMemo(() => artDocument(kind, body), [kind, body]);
  if (!running) {
    return (
      <button
        type="button"
        onClick={() => setRunning(true)}
        className={`${FRAME_CLASS} flex flex-col items-center justify-center gap-2 bg-muted/30 text-sm text-muted-foreground hover:text-foreground`}
      >
        <PlayIcon className="size-6" />
        Run this piece
      </button>
    );
  }
  return (
    <div className="space-y-1.5">
      <iframe
        title={title}
        sandbox={ART_FRAME_SANDBOX}
        srcDoc={srcDoc}
        allow={ART_FRAME_ALLOW}
        referrerPolicy="no-referrer"
        loading="lazy"
        {...{ csp: artFrameCsp(kind) }}
        className={`${FRAME_CLASS} bg-white`}
      />
      {kind === "html" ? (
        <Button size="xs" variant="ghost" onClick={() => setRunning(false)}>
          <SquareIcon />
          Stop
        </Button>
      ) : null}
    </div>
  );
}
