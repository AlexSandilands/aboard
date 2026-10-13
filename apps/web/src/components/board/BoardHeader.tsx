import type { Project } from "@taskboard/contracts";
import { ListFilterIcon, SearchIcon, XIcon } from "lucide-react";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { Button } from "~/components/ui/button";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { SidebarTrigger, useSidebar } from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useBoardView, usePalette } from "~/state/ui";
import { useSetProjectFilter } from "./boardNavigation";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The board's 52px top bar: title or scoped project, filters, and the palette hint. */
export function BoardHeader({ scopedProject }: { scopedProject: Project | null }) {
  const { isMobile, open } = useSidebar();
  const attentionOnly = useBoardView((s) => s.attentionOnly);
  const setAttentionOnly = useBoardView((s) => s.setAttentionOnly);
  const hasPrOnly = useBoardView((s) => s.hasPrOnly);
  const setHasPrOnly = useBoardView((s) => s.setHasPrOnly);
  const showArchived = useBoardView((s) => s.showArchived);
  const setShowArchived = useBoardView((s) => s.setShowArchived);
  const filtered = attentionOnly || hasPrOnly || showArchived;
  const setProjectFilter = useSetProjectFilter();

  return (
    <header className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 ps-(--workspace-gutter-start) pe-(--workspace-gutter-end)">
      {isMobile || !open ? <SidebarTrigger variant="ghost-muted" size="icon-sm" aria-label="Toggle sidebar" /> : null}
      {scopedProject ? (
        <div className="flex min-w-0 items-center gap-2">
          <ProjectFavicon title={scopedProject.title} icon={scopedProject.icon} className="size-4" />
          <h1 className="truncate text-sm font-medium">{scopedProject.title}</h1>
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost-muted" size="icon-micro" aria-label="Show all projects" onClick={() => void setProjectFilter(null)} />}
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipPopup>Show all projects</TooltipPopup>
          </Tooltip>
        </div>
      ) : (
        <h1 className="text-sm font-medium">Board</h1>
      )}
      <div className="ms-auto flex items-center gap-1.5">
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={<Button variant={filtered ? "secondary" : "ghost-muted"} size="icon-sm" aria-label="Filter board" />}
                />
              }
            >
              <ListFilterIcon />
            </TooltipTrigger>
            <TooltipPopup>Filter</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuGroup>
              <MenuGroupLabel>Show</MenuGroupLabel>
              <MenuCheckboxItem checked={attentionOnly} onCheckedChange={setAttentionOnly}>
                Needs attention only
              </MenuCheckboxItem>
              <MenuCheckboxItem checked={hasPrOnly} onCheckedChange={setHasPrOnly}>
                Has PR
              </MenuCheckboxItem>
              <MenuCheckboxItem checked={showArchived} onCheckedChange={setShowArchived}>
                Show archived
              </MenuCheckboxItem>
            </MenuGroup>
          </MenuPopup>
        </Menu>
        <Button variant="outline" size="xs" onClick={() => usePalette.getState().openPalette()}>
          <SearchIcon />
          <span className="text-muted-foreground">Search</span>
          <KbdGroup>
            <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </Button>
      </div>
    </header>
  );
}
