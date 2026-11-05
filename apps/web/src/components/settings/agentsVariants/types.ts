// Temporary (task #97): competing designs of Settings → Agents, switched from the dropdown at the top of Settings so
// the user can compare them. Once one is picked, the others, this registry and the dropdown go.
import type { AppSettings } from "@repo/contracts";
import type { ComponentType } from "react";

export interface AgentsVariant {
  /** Stable id, stored as the viewer's choice. */
  id: string;
  /** Shown in the dropdown, e.g. "A · Provider tabs". */
  label: string;
  /** Who built it, e.g. "Opus 5.5". */
  author: string;
  /**
   * Everything on Settings → Agents, inside the page's scroller. It must render the sections
   * `<SettingsSubsection id="agents.providers">`, and once at least one provider is added `agents.models` and
   * `agents.operations` (the sidebar and search scroll to them).
   */
  Page: ComponentType<{ settings: AppSettings }>;
}
