import type { SavedView } from "@repo/contracts";
import { BookmarkIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { useApplyFilterParams, useBoardFilterParams } from "~/components/board/boardNavigation";
import { Button } from "~/components/ui/button";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, useSidebar } from "~/components/ui/sidebar";
import { activeView } from "~/components/views/views.logic";
import { useDialogs } from "~/state/ui";
import { useSavedViews, useViewActions } from "~/state/views";

/** "Views": the saved filter sets. Click one to apply it; rename and delete show on hover. Hidden until one is saved. */
export function ViewsSection() {
  const [expanded, setExpanded] = useState(true);
  const views = useSavedViews();
  const params = useBoardFilterParams();
  const apply = useApplyFilterParams();
  const { isMobile, setOpenMobile } = useSidebar();
  const { remove } = useViewActions();
  if (views.length === 0) return null;
  const active = activeView(views, params);

  return (
    <SidebarGroup>
      <CollapsibleSectionHeader
        expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        accessory={<span className="shrink-0 text-2xs tabular-nums">{views.length}</span>}
      >
        Views
      </CollapsibleSectionHeader>
      {expanded ? (
        <SidebarMenu>
          {views.map((view) => (
            <ViewRow
              key={view.id}
              view={view}
              active={view.id === active?.id}
              onApply={() => {
                void apply(view.filters);
                if (isMobile) setOpenMobile(false);
              }}
              onRename={() => useDialogs.getState().openViewDialog({ kind: "rename", viewId: view.id })}
              onDelete={() => remove(view.id)}
            />
          ))}
        </SidebarMenu>
      ) : null}
    </SidebarGroup>
  );
}

function ViewRow({
  view,
  active,
  onApply,
  onRename,
  onDelete,
}: {
  view: SavedView;
  active: boolean;
  onApply: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="group/menu-item relative rounded-md" data-sidebar="menu-item" data-slot="sidebar-menu-item">
      <SidebarMenuButton isActive={active} onClick={onApply}>
        <BookmarkIcon className="size-4" />
        <span className="min-w-0 flex-1 truncate">{view.name}</span>
      </SidebarMenuButton>
      <div className="absolute end-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100">
        <Button variant="ghost-muted" size="icon-xs" aria-label={`Rename view ${view.name}`} onClick={onRename}>
          <PencilIcon className="size-3.5" />
        </Button>
        <Button variant="ghost-muted" size="icon-xs" aria-label={`Delete view ${view.name}`} onClick={onDelete}>
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}
