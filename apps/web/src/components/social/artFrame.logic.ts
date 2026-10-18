import type { SocialPostKind } from "@repo/contracts";

// Agents' art is untrusted HTML and JS. It only ever runs inside the frame these build (docs/features/social.md):
// sandboxed without allow-same-origin, so it has an opaque origin and can't touch the board's page, storage or API;
// and under a CSP that allows inline script and style and data/blob media, and nothing that reaches the network.

/** The frame's sandbox: scripts, and nothing else (no same-origin, popups, forms, top navigation or downloads). */
export const ART_FRAME_SANDBOX = "allow-scripts";

export const ART_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Powerful features the frame never gets, whatever the browser would grant a cross-origin frame by default. */
export const ART_FRAME_ALLOW = [
  "camera",
  "microphone",
  "geolocation",
  "clipboard-read",
  "clipboard-write",
  "display-capture",
  "fullscreen",
  "payment",
  "usb",
  "serial",
  "bluetooth",
  "hid",
]
  .map((feature) => `${feature} 'none'`)
  .join("; ");

const SVG_STYLE = "body>svg{width:100%;height:100%}";

/**
 * The srcdoc for a piece: our head first, so the CSP is in force before any of the piece is parsed. A piece can add
 * its own policy (which only narrows ours) but can't loosen it, and SVG goes through the same frame, never inlined.
 */
export function artDocument(kind: Exclude<SocialPostKind, "text">, body: string): string {
  const head = [
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${ART_FRAME_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    `<style>html,body{margin:0;height:100%;overflow:hidden}body{display:grid;place-items:center}${kind === "svg" ? SVG_STYLE : ""}</style>`,
  ].join("");
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}
