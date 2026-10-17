// Adapted from T3 Code (apps/web/src/routes/settings.tsx, components/settings/SettingsSidebarNav.tsx,
// SettingsBreadcrumb.tsx, components/sidebar/SidebarChrome.tsx), MIT — see NOTICE.
import { Outlet, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BlocksIcon,
  FolderIcon,
  ListTodoIcon,
  type LucideIcon,
  SquareKanbanIcon,
  ZapIcon,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useRef } from "react";
import { AppShell } from "~/components/layout/AppShell";
import { SidebarBrandRow } from "~/components/sidebar/SidebarBrandRow";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarTrigger,
  useSidebar,
} from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import { useSettingsNav } from "~/state/ui";
import {
  activeSectionId,
  isSettingsGroup,
  sectionOf,
  SETTINGS_GROUPS,
  settingsCrumbs,
  type SettingsGroupId,
} from "./settingsNav.logic";
import { useLeaveSettings, useOpenSettings } from "./settingsNavigation";

const GROUP_ICONS: Record<SettingsGroupId, LucideIcon> = {
  board: SquareKanbanIcon,
  tasks: ListTodoIcon,
  autopilot: ZapIcon,
  integrations: BlocksIcon,
  project: FolderIcon,
};

/** `/settings/<group>[/<editor>…]` → the group, and whether an editor sub-page is open. */
function useSettingsLocation(): { group: SettingsGroupId | null; inEditor: boolean } {
  const pathname = useLocation({ select: (location) => location.pathname });
  const parts = pathname.split("/").filter(Boolean);
  const group = parts[1];
  return { group: isSettingsGroup(group) ? group : null, inEditor: parts.length > 2 };
}

/** The `?project=` of the project page and its rule editor. */
function useSettingsProjectParam(): string | undefined {
  return useSearch({ strict: false, select: (search) => search.project });
}

/**
 * Route component for `/settings`: the settings list in place of the board's sidebar, and the page. Esc leaves an
 * editor for its page, and a page for the board.
 */
export function SettingsShell() {
  const { group, inEditor } = useSettingsLocation();
  const project = useSettingsProjectParam();
  const navigate = useNavigate();
  const leave = useLeaveSettings();
  const back =
    inEditor && group
      ? () =>
          navigate({
            to: "/settings/$group",
            params: { group },
            search: group === "project" && project ? { project } : {},
          })
      : leave;
  return (
    <AppShell sidebar={<SettingsSidebar />} sidebarLabel="Settings" onBack={back}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </AppShell>
  );
}

/**
 * The settings list: each group's heading opens its page, and the sub-section links beneath scroll to that part
 * of it. The section in view is highlighted. On narrow windows this is the off-canvas sheet, which closes on a pick.
 */
function SettingsSidebar() {
  const { group: current, inEditor } = useSettingsLocation();
  const project = useSettingsProjectParam();
  const active = useSettingsNav((s) => s.activeSection);
  const openSettings = useOpenSettings();
  const leave = useLeaveSettings();
  const { isMobile, setOpenMobile } = useSidebar();

  const go = (target: string, group: SettingsGroupId) => {
    if (isMobile) setOpenMobile(false);
    // Highlight the pick right away rather than wait for the scroll to reach it.
    if (target !== group) useSettingsNav.getState().setActiveSection(target);
    // Moving within a page replaces the entry, so Back doesn't step through every section visited.
    openSettings(target, {
      project: group === "project" ? project : undefined,
      replace: group === current && !inEditor,
    });
  };

  return (
    <>
      <SidebarBrandRow />
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {SETTINGS_GROUPS.map((group) => {
              const Icon = GROUP_ICONS[group.id];
              const here = group.id === current;
              return (
                <SidebarMenuItem key={group.id}>
                  <SidebarMenuButton
                    isActive={here && (inEditor || active === null)}
                    aria-current={here ? "page" : undefined}
                    onClick={() => go(group.id, group.id)}
                  >
                    <Icon />
                    <span className="truncate">{group.label}</span>
                  </SidebarMenuButton>
                  <SidebarMenuSub className="mt-0.5 mb-1.5">
                    {group.sections.map((section) => (
                      <SidebarMenuSubItem key={section.id}>
                        <SidebarMenuSubButton
                          // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the label is the children useRender merges in
                          render={<button type="button" />}
                          size="sm"
                          className="w-full text-sidebar-muted-foreground data-[active=true]:text-sidebar-foreground"
                          isActive={here && !inEditor && active === section.id}
                          onClick={() => go(section.id, group.id)}
                        >
                          <span>{section.label}</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                leave();
              }}
            >
              <ArrowLeftIcon />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}

/**
 * The page's top bar: the sidebar toggle when the list is hidden, and "Settings / Group[ / Editor]". On an editor
 * the group crumb goes back to its page.
 */
export function SettingsTopBar({
  group,
  editor = null,
  actions,
}: {
  group: SettingsGroupId;
  editor?: string | null;
  actions?: ReactNode;
}) {
  const { isMobile, open } = useSidebar();
  const openSettings = useOpenSettings();
  const project = useSettingsProjectParam();
  const crumbs = settingsCrumbs(group, editor);
  return (
    <header className="drag-region flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 ps-(--workspace-gutter-start) pe-(--workspace-gutter-end) wco:pe-(--workspace-native-controls-inset)">
      {isMobile || !open ? <SidebarTrigger variant="ghost-muted" size="icon-sm" aria-label="Toggle sidebar" /> : null}
      <nav aria-label="Settings breadcrumb" className="min-w-0">
        <ol className="m-0 flex min-w-0 list-none items-center gap-2 p-0 text-sm font-medium">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            const linksToGroup = index === 1 && !last;
            return (
              // Crumbs are distinct: Settings, a group, then an editor's "Kind: name".
              <Fragment key={crumb}>
                {index > 0 ? (
                  <li aria-hidden className="shrink-0 text-muted-foreground/60">
                    /
                  </li>
                ) : null}
                <li
                  aria-current={last ? "page" : undefined}
                  className={cn("min-w-0", last ? "truncate text-foreground" : "shrink-0 text-muted-foreground")}
                >
                  {linksToGroup ? (
                    <button
                      type="button"
                      className="cursor-pointer rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => openSettings(group, { project })}
                    >
                      {crumb}
                    </button>
                  ) : (
                    crumb
                  )}
                </li>
              </Fragment>
            );
          })}
        </ol>
      </nav>
      {actions ? <div className="ms-auto flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </header>
  );
}

// The scroll request the last mounted page handled, so a page mounting later doesn't replay an old one.
let handledScroll = 0;

/**
 * The page's scroll area. It runs scroll-spy over the `SettingsSubsection`s inside, for the list's highlight, and
 * brings a requested section or row into view once it has rendered (content may still be loading). On first mount
 * with nothing requested it honours the URL hash, so a reload lands where it was.
 */
export function SettingsScroller({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const target = useSettingsNav((s) => s.scrollTarget);
  const firstRun = useRef(true);

  useEffect(() => {
    const area = ref.current;
    if (!area) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = area.getBoundingClientRect().top;
      const sections = Array.from(area.querySelectorAll<HTMLElement>("[data-settings-section]"), (element) => ({
        id: element.dataset.settingsSection ?? "",
        top: element.getBoundingClientRect().top - top,
      }));
      const atBottom = area.scrollTop > 0 && area.scrollTop + area.clientHeight >= area.scrollHeight - 2;
      useSettingsNav.getState().setActiveSection(activeSectionId(sections, { atBottom }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    area.addEventListener("scroll", schedule, { passive: true });
    // Sections grow as their data loads, which moves the ones below without a scroll event.
    const observer = new ResizeObserver(schedule);
    if (area.firstElementChild) observer.observe(area.firstElementChild);
    schedule();
    return () => {
      area.removeEventListener("scroll", schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
      useSettingsNav.getState().setActiveSection(null);
    };
  }, []);

  useEffect(() => {
    const area = ref.current;
    if (!area) return;
    const isFirst = firstRun.current;
    firstRun.current = false;
    let id: string | null = null;
    if (target && target.nonce > handledScroll) {
      handledScroll = target.nonce;
      id = target.id;
    } else if (isFirst && window.location.hash.length > 1) {
      id = decodeURIComponent(window.location.hash.slice(1));
    }
    if (!id) return;
    if (isSettingsGroup(id)) {
      area.scrollTo({ top: 0 });
      return;
    }
    const smooth = !isFirst && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let tries = 0;
    let frame = 0;
    const attempt = () => {
      const element = document.getElementById(id);
      if (element && area.contains(element)) {
        element.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
        if (sectionOf(id)) useSettingsNav.getState().setActiveSection(sectionOf(id)!.id);
        return;
      }
      // Give loading content about two seconds to render the target.
      if (++tries < 120) frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return (
    <div ref={ref} className={cn("min-h-0 flex-1 overflow-y-auto", className)}>
      <div className="mx-auto w-full max-w-3xl space-y-8 px-4 pt-2 pb-24 sm:px-6">{children}</div>
    </div>
  );
}
