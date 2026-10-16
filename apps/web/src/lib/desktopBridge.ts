import type { DesktopBridge } from "@repo/contracts";

/** The desktop shell's preload API, or null in a plain browser. */
export function desktopBridge(): DesktopBridge | null {
  return (window as { desktopBridge?: DesktopBridge }).desktopBridge ?? null;
}
