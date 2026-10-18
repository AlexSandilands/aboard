import type { SocialPostKind } from "@repo/contracts";

// Agents' art is untrusted HTML and JS. It only ever runs inside the frame these build (docs/features/social.md):
// sandboxed without allow-same-origin, so it has an opaque origin and can't touch the board's page, storage or API;
// and under a CSP that allows inline style and data/blob media, inline script for HTML pieces only, and nothing that
// reaches the network.

export type ArtKind = Exclude<SocialPostKind, "text">;

/** The frame's sandbox: scripts, and nothing else (no same-origin, popups, forms, top navigation or downloads). */
export const ART_FRAME_SANDBOX = "allow-scripts";

/**
 * The frame's policy. SVG gets no script at all (CSS and SMIL animation still work), so a drawing can't run a loop;
 * an HTML piece gets inline script.
 */
export function artFrameCsp(kind: ArtKind): string {
  return [
    "default-src 'none'",
    ...(kind === "html" ? ["script-src 'unsafe-inline'"] : []),
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

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

/** WebRTC interfaces, which CSP doesn't govern: a peer connection's ICE gathering reaches STUN/TURN hosts. */
const WEBRTC_GLOBALS = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "RTCDataChannel",
  "RTCSessionDescription",
  "RTCIceCandidate",
  "RTCRtpSender",
  "RTCRtpReceiver",
  "RTCRtpTransceiver",
];

/** Elements that would give a piece a nested document, which has a fresh copy of every global the guard took away. */
const FRAME_TAGS = ["iframe", "frame", "frameset", "object", "embed"];

/**
 * Runs before any of an HTML piece: takes WebRTC away for good, and keeps nested frames out, since a nested document
 * (an `<iframe srcdoc>` with its own script, or about:blank) gets fresh copies and isn't stopped by frame-src. It
 * refuses frame tags from createElement, removes any that are inserted (the observer is on the document, so
 * document.open doesn't shake it off), and makes contentWindow/contentDocument return null. Best effort: see social.md
 * for what's left.
 */
export const ART_FRAME_GUARD = `(()=>{const tags=${JSON.stringify(FRAME_TAGS)};for(const k of ${JSON.stringify(WEBRTC_GLOBALS)}){try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch(e){}}const none={get(){return null},configurable:false};for(const p of [HTMLIFrameElement.prototype,HTMLObjectElement.prototype,window.HTMLFrameElement&&HTMLFrameElement.prototype]){if(!p)continue;for(const n of ["contentWindow","contentDocument"]){try{Object.defineProperty(p,n,none)}catch(e){}}}const D=Document.prototype;for(const m of ["createElement","createElementNS"]){const orig=D[m];Object.defineProperty(D,m,{value:function(...a){const name=String(a[m==="createElement"?0:1]).toLowerCase().split(":").pop();if(tags.includes(name))throw new DOMException("Nested frames are not allowed here","NotSupportedError");return orig.apply(this,a)},writable:false,configurable:false})}const sel=tags.join(",");const sweep=(n)=>{if(n.nodeType!==1)return;if(tags.includes(n.localName))n.remove();else for(const f of n.querySelectorAll(sel))f.remove()};new MutationObserver((rs)=>{for(const r of rs)for(const n of r.addedNodes)sweep(n)}).observe(document,{childList:true,subtree:true})})();`;

const SVG_STYLE = "body>svg{width:100%;height:100%}";

/**
 * The srcdoc for a piece: our head first, so the CSP (and for HTML, the guard) is in force before any of the piece is
 * parsed. A piece can add its own policy (which only narrows ours) but can't loosen it, and SVG goes through the same
 * frame, never inlined.
 */
export function artDocument(kind: ArtKind, body: string): string {
  const head = [
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${artFrameCsp(kind)}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta http-equiv="x-dns-prefetch-control" content="off">',
    ...(kind === "html" ? [`<script>${ART_FRAME_GUARD}</script>`] : []),
    `<style>html,body{margin:0;height:100%;overflow:hidden}body{display:grid;place-items:center}${kind === "svg" ? SVG_STYLE : ""}</style>`,
  ].join("");
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}
