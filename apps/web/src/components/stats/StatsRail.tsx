import type { StatsResponse } from "@repo/contracts";
import {
  BotIcon,
  CoinsIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  type LucideIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  TerminalIcon,
  TimerIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
  WorkflowIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import {
  hasStatsCharts,
  STATS_SECTIONS,
  type StatsSectionId,
  statsSectionOf,
  visibleStatsCards,
} from "./statsNav.logic";

const SECTION_ICONS: Record<StatsSectionId, LucideIcon> = {
  "stats.throughput": TrendingUpIcon,
  "stats.tokens": CoinsIcon,
  "stats.cycle-time": TimerIcon,
  "stats.flow": WorkflowIcon,
  "stats.prs": GitPullRequestIcon,
  "stats.pr-flow": GitMergeIcon,
  "stats.sessions": TerminalIcon,
  "stats.autopilot": BotIcon,
  "stats.friction": TriangleAlertIcon,
};

/**
 * The Stats page's contents, in a rail at the window's left: each section, with the chart cards it draws beneath it.
 * A pick scrolls the page to it, and the part being read is highlighted. While the stats load, or when nothing
 * happened, only the sections are listed, and they lead nowhere. Below `md` it is a rail of the sections' icons, which
 * its top button expands over the page with the full list, until a pick or the button again.
 */
export function StatsRail({
  data,
  active,
  onJump,
}: {
  data: StatsResponse | undefined;
  /** The section or card being read, or just picked. */
  active: string | null;
  onJump: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const charted = hasStatsCharts(data);
  const activeSection = charted && active ? (statsSectionOf(active)?.id ?? null) : null;

  // The list is taller than a short window: keep the part being read in view. The card when it is shown, else (in the
  // icon rail, or on a section's tiles) its section.
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const lit = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[aria-current="location"]') ?? []).filter(
      (element) => element.offsetParent !== null,
    );
    lit.at(-1)?.scrollIntoView({ block: "nearest" });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- it reads what they render: the lit rows in the DOM
  }, [active, expanded]);

  const jump = (id: string) => {
    setExpanded(false);
    onJump(id);
  };

  return (
    // The wrapper keeps the icon rail's room while the list lies expanded over the page, so the page isn't laid out
    // wider meanwhile (its charts would resize, and a pick would be measured against that layout).
    <div className="flex w-60 shrink-0 max-md:w-14">
      <nav
        aria-label="Stats sections"
        className={cn(
          "flex w-full flex-col border-e bg-sidebar text-sidebar-foreground",
          expanded && "max-md:absolute max-md:inset-y-0 max-md:start-0 max-md:z-10",
        )}
      >
        <SidebarHeader className="pb-0 md:hidden">
          <SidebarMenuButton
            aria-label={expanded ? "Hide the list" : "Show the list"}
            aria-expanded={expanded}
            title={expanded ? "Hide the list" : "Show the list"}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
            <span className={cn("truncate", !expanded && "sr-only")}>Contents</span>
          </SidebarMenuButton>
        </SidebarHeader>
        <SidebarContent className="overflow-x-hidden">
          <SidebarGroup>
            <SidebarMenu ref={listRef}>
              {STATS_SECTIONS.map((section) => {
                const Icon = SECTION_ICONS[section.id];
                const here = section.id === activeSection;
                const cards = visibleStatsCards(section, data);
                return (
                  <SidebarMenuItem key={section.id}>
                    <SidebarMenuButton
                      disabled={!charted}
                      isActive={here && active === section.id}
                      aria-current={here ? "location" : undefined}
                      title={section.label}
                      // In the icon rail the cards are hidden, so the section's icon stays lit wherever it is scrolled.
                      className={cn(here && !expanded && "max-md:bg-sidebar-row-active max-md:text-sidebar-foreground")}
                      onClick={() => jump(section.id)}
                    >
                      <Icon />
                      <span className={cn("truncate", !expanded && "max-md:sr-only")}>{section.label}</span>
                    </SidebarMenuButton>
                    {cards.length > 0 ? (
                      <SidebarMenuSub className={cn("mt-0.5 mb-1.5", !expanded && "max-md:hidden")}>
                        {cards.map((card) => (
                          <SidebarMenuSubItem key={card.id}>
                            <SidebarMenuSubButton
                              // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the label is the children useRender merges in
                              render={<button type="button" />}
                              size="sm"
                              className="w-full text-sidebar-muted-foreground data-[active=true]:text-sidebar-foreground"
                              isActive={active === card.id}
                              aria-current={active === card.id ? "location" : undefined}
                              onClick={() => jump(card.id)}
                            >
                              <span>{card.label}</span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    ) : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </nav>
    </div>
  );
}
