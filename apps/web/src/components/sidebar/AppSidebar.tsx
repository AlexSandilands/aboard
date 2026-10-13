import { Skeleton } from "~/components/ui/skeleton";
import { SidebarContent, SidebarGroup } from "~/components/ui/sidebar";
import { useBoard } from "~/state/queries";
import { AttentionSection } from "./AttentionSection";
import { ProjectsSection } from "./ProjectsSection";
import { SidebarBrandRow } from "./SidebarBrandRow";
import { SidebarSearchHeader } from "./SidebarSearchHeader";

/** Sidebar contents: brand row, search header, "Needs attention" and "Projects". */
export function AppSidebar() {
  const board = useBoard().data;
  return (
    <>
      <SidebarBrandRow />
      <SidebarContent
        fixedHeader={
          // Lifted above the stage backdrop, whose fade bleeds below the brand row.
          <SidebarGroup className="z-[1]">
            <SidebarSearchHeader projects={board?.projects ?? []} />
          </SidebarGroup>
        }
      >
        {board ? (
          <>
            <AttentionSection tasks={board.tasks} projects={board.projects} />
            <ProjectsSection board={board} />
          </>
        ) : (
          <SidebarGroup aria-busy>
            <Skeleton className="mx-2 my-2.5 h-3 w-20" />
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="flex h-8 items-center gap-2 px-2.5">
                <Skeleton className="size-4" />
                <Skeleton className="h-3 w-28" />
              </div>
            ))}
          </SidebarGroup>
        )}
      </SidebarContent>
    </>
  );
}
