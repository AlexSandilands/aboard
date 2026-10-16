import { isWebUrl } from "~/components/task/links.logic";
import {
  t3BrowserThreadUrl,
  t3DesktopThreadUrl,
  type AppSettings,
  type T3IntegrationStatus,
  type T3ThreadRef,
} from "@repo/contracts";

export interface T3LinkTargets {
  primary: { href: string; label: string };
  secondary: { href: string; label: string } | null;
}

/**
 * Builds "Open in T3 Code" targets for a thread. The desktop deep link always works when the
 * T3 desktop app is installed; the browser link needs a known T3 origin (from discovery).
 */
export function t3LinkTargets(
  ref: T3ThreadRef,
  t3: T3IntegrationStatus,
  settings: Pick<AppSettings, "t3LinkTarget"> | undefined,
): T3LinkTargets {
  const desktop = { href: t3DesktopThreadUrl(ref), label: "Open in T3 Code desktop" };
  const browser = t3.origin ? { href: t3BrowserThreadUrl(t3.origin, ref), label: "Open in browser" } : null;
  if (settings?.t3LinkTarget === "browser" && browser) return { primary: browser, secondary: desktop };
  return { primary: desktop, secondary: browser };
}

/** Web URLs open in a new tab, app deep links (t3code://) in place. */
export function openHref(href: string) {
  if (isWebUrl(href)) window.open(href, "_blank", "noreferrer");
  else window.location.assign(href);
}
