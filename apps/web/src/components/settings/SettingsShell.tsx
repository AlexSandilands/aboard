// Adapted from T3 Code (apps/web/src/routes/_chat.settings.tsx, components/settings/SettingsSidebarNav.tsx,
// SettingsBreadcrumb.tsx), MIT — see NOTICE.
import type { AppSettings } from "@repo/contracts";
import { desktopBridge } from "~/lib/desktopBridge";
import { Outlet, useLocation, useSearch } from "@tanstack/react-router";
import {
  BlocksIcon,
  BotIcon,
  FolderIcon,
  KeyboardIcon,
  ListTodoIcon,
  type LucideIcon,
  SquareKanbanIcon,
  ZapIcon,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import {
  APP_WINDOW_HEADER_CLASS,
  AppRouteModal,
  AppRouteModalClose,
  closeAppWindow,
} from "~/components/layout/AppRouteModal";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import { useSettingsSelect } from "~/state/queries";
import { useSuggestions } from "~/state/suggestions";
import { useSettingsNav } from "~/state/ui";
import { SettingsSearch } from "./SettingsSearch";
import type { SettingsIndexEntry } from "./settingsIndex.logic";
import {
  activeSectionId,
  isEditorPath,
  isSettingsGroup,
  sectionOf,
  SETTINGS_GROUPS,
  settingsCrumbs,
  type SettingsGroupId,
  visibleSections,
} from "./settingsNav.logic";
import { useLeaveEditor, useLeaveWindow, useOpenSettings } from "./settingsNavigation";

const GROUP_ICONS: Record<SettingsGroupId, LucideIcon> = {
  board: SquareKanbanIcon,
  keybindings: KeyboardIcon,
  tasks: ListTodoIcon,
  agents: BotIcon,
  autopilot: ZapIcon,
  integrations: BlocksIcon,
  project: FolderIcon,
};

/** `/settings/<group>[/<editor>…]` → the group, and whether an editor sub-page is open. */
function useSettingsLocation(): { group: SettingsGroupId | null; inEditor: boolean } {
  const pathname = useLocation({ select: (location) => location.pathname });
  const parts = pathname.split("/").filter(Boolean);
  const group = parts[1];
  return { group: isSettingsGroup(group) ? group : null, inEditor: isEditorPath(pathname) };
}

/** The `?project=` of the project page and its rule editor. */
function useSettingsProjectParam(): string | undefined {
  return useSearch({ strict: false, select: (search) => search.project });
}

/**
 * Route component for `/settings`: the Settings window over the board, with the settings list in a rail beside the
 * page. Closing it returns to the board as it was.
 */
export function SettingsShell() {
  const leave = useLeaveWindow();
  const { inEditor } = useSettingsLocation();
  return (
    <AppRouteModal label="Settings" onClosed={leave} backdropDismisses={!inEditor}>
      <div className="relative flex min-h-0 flex-1">
        <SettingsRail />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </AppRouteModal>
  );
}

/** What Esc does in Settings: leave an editor for its page, and close the window from a page. */
export function useSettingsBack(): () => unknown {
  const { group, inEditor } = useSettingsLocation();
  const project = useSettingsProjectParam();
  const leaveEditor = useLeaveEditor();
  if (!inEditor || !group) return closeAppWindow;
  return () => leaveEditor(group, project);
}

const selectProviders = (settings: AppSettings) => settings.providers;

/**
 * The settings list, in a rail at the window's left: each group's heading opens its page, and the sub-section links
 * beneath scroll to that part of it. The section in view is highlighted. A search box above it finds any setting and
 * jumps to it. Below `md` it is a rail of the groups' icons, and searching expands it over the page with the full
 * list, until a pick or its close button.
 */
function SettingsRail() {
  const { group: current, inEditor } = useSettingsLocation();
  const project = useSettingsProjectParam();
  const active = useSettingsNav((s) => s.activeSection);
  const openSettings = useOpenSettings();
  const [expanded, setExpanded] = useState(false);
  // Open suggestions wait on the user, so their section shows how many.
  const openSuggestions = useSuggestions().data?.open ?? 0;
  const providers = useSettingsSelect(selectProviders);
  const countOf = (sectionId: string) => (sectionId === "tasks.suggestions" ? openSuggestions : 0);
  // The list is taller than a short window: keep the page being shown in view.
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (current) listRef.current?.querySelector(`[data-group="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const go = (target: string, group: SettingsGroupId) => {
    setExpanded(false);
    // Highlight the pick right away rather than wait for the scroll to reach it.
    if (target !== group) useSettingsNav.getState().setActiveSection(target);
    // Moving within a page replaces the entry, so Back doesn't step through every section visited.
    openSettings(target, {
      project: group === "project" ? project : undefined,
      replace: group === current && !inEditor,
    });
  };

  const openResult = (entry: SettingsIndexEntry) => {
    setExpanded(false);
    useSettingsNav.getState().setActiveSection(entry.sectionId);
    openSettings(entry.id, {
      project: entry.group === "project" ? project : undefined,
      replace: entry.group === current && !inEditor,
      // A sub-section is a whole stretch of the page: scrolling to it says enough.
      highlight: entry.kind !== "section",
    });
  };

  return (
    <nav
      aria-label="Settings"
      className={cn(
        "flex w-60 shrink-0 flex-col border-e bg-sidebar text-sidebar-foreground max-md:w-14",
        expanded && "max-md:absolute max-md:inset-y-0 max-md:start-0 max-md:z-10 max-md:w-full",
      )}
    >
      <SettingsSearch onOpen={openResult} expanded={expanded} onExpandedChange={setExpanded}>
        <SidebarContent className="overflow-x-hidden">
          <SidebarGroup>
            <SidebarMenu ref={listRef}>
              {SETTINGS_GROUPS.map((group) => {
                const Icon = GROUP_ICONS[group.id];
                const here = group.id === current;
                return (
                  <SidebarMenuItem key={group.id} data-group={group.id}>
                    <SidebarMenuButton
                      isActive={here && (inEditor || active === null)}
                      aria-current={here ? "page" : undefined}
                      title={group.label}
                      // In the icon rail the sections are hidden, so the page's icon stays lit wherever it is scrolled.
                      className={cn(here && !expanded && "max-md:bg-sidebar-row-active max-md:text-sidebar-foreground")}
                      onClick={() => go(group.id, group.id)}
                    >
                      <Icon />
                      <span className={cn("truncate", !expanded && "max-md:sr-only")}>{group.label}</span>
                    </SidebarMenuButton>
                    <SidebarMenuSub className={cn("mt-0.5 mb-1.5", !expanded && "max-md:hidden")}>
                      {visibleSections(group, providers, desktopBridge() !== null).map((section) => (
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
                            {countOf(section.id) > 0 ? (
                              <span
                                aria-label={`${countOf(section.id)} open`}
                                className="ms-auto rounded-full bg-info/15 px-1.5 text-[10px] leading-4 font-medium text-info-foreground tabular-nums"
                              >
                                {countOf(section.id)}
                              </span>
                            ) : null}
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
      </SettingsSearch>
    </nav>
  );
}

/**
 * The window's header: "Settings / Group[ / Editor]", the page's actions and the close button. On an editor the
 * group crumb goes back to its page.
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
  const openSettings = useOpenSettings();
  const project = useSettingsProjectParam();
  const crumbs = settingsCrumbs(group, editor);
  return (
    <header className={APP_WINDOW_HEADER_CLASS}>
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
      <div className="ms-auto flex shrink-0 items-center gap-1.5">
        {actions}
        <AppRouteModalClose />
      </div>
    </header>
  );
}

/** How long a scrolled-to target is kept in view while sections above it load and grow. */
const PIN_MS = 1500;

/**
 * Keeps `element` at the top of `area` while the content around it settles: sections fill in as their queries load,
 * which would push a target scrolled to early off the screen, or leave it short of the top. Settles after `PIN_MS`,
 * or as soon as the user scrolls; the returned function stops it without settling.
 */
function pinInView(area: HTMLElement, element: HTMLElement, onSettled: () => void): () => void {
  const content = area.firstElementChild;
  if (!content) {
    onSettled();
    return () => {};
  }
  // On every change: a no-op when it's in place, and it catches a first scroll cut short by a page still too short.
  const observer = new ResizeObserver(() => element.scrollIntoView({ block: "start" }));
  observer.observe(content);
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
    for (const type of USER_SCROLL_EVENTS) area.removeEventListener(type, settle);
  };
  const settle = () => {
    stop();
    onSettled();
  };
  const timer = setTimeout(settle, PIN_MS);
  for (const type of USER_SCROLL_EVENTS) area.addEventListener(type, settle, { passive: true });
  return stop;
}
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/** Frames (about 60 a second) to wait for a target to render, and for one in a page that is already loaded. */
const MAX_TRIES = 120;
const JUMP_TRIES = 20;

/** How long a picked setting stays marked; the animation in `index.css` fades it over this time. */
const FLASH_MS = 1600;

const flashTimers = new WeakMap<HTMLElement, number>();

/** Marks `element` for a moment so the eye finds it after a jump (`.settings-flash`, see `index.css`). */
function flashElement(element: HTMLElement) {
  window.clearTimeout(flashTimers.get(element));
  element.classList.remove("settings-flash");
  // Reading a layout property restarts the animation when the same element is picked again.
  void element.offsetWidth;
  element.classList.add("settings-flash");
  flashTimers.set(
    element,
    window.setTimeout(() => element.classList.remove("settings-flash"), FLASH_MS),
  );
}

/** Runs `fn` once a smooth scroll in `area` has come to rest, or after a moment where `scrollend` isn't fired. */
function afterScroll(area: HTMLElement, fn: () => void): () => void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    area.removeEventListener("scrollend", run);
    fn();
  };
  const timer = setTimeout(run, 900);
  area.addEventListener("scrollend", run);
  return () => {
    done = true;
    clearTimeout(timer);
    area.removeEventListener("scrollend", run);
  };
}

/**
 * The element for a target id, or when it isn't rendered (a row that only shows in some states: the issue import's
 * model with import off) the nearest one that is, by dropping trailing `.segment`s: the card, then the sub-section.
 */
function nearestRendered(id: string): HTMLElement | null {
  for (let end = id.length; end > 0; end = id.lastIndexOf(".", end - 1)) {
    const element = document.getElementById(id.slice(0, end));
    if (element) return element;
  }
  return null;
}

// The scroll request last brought into view, so a page mounting later doesn't replay it. A request is only handled
// once a page finds its target: the page being left sees it first, and the page being opened must still act on it.
let handledScroll = 0;
/** How long a request waits for a page that has its target (the next page's data may still be loading). */
const SCROLL_REQUEST_TTL_MS = 3000;

/**
 * The page's scroll area. It runs scroll-spy over the `SettingsSubsection`s inside, for the list's highlight, and
 * brings a requested section or row into view once it has rendered (content may still be loading). On first mount
 * with nothing requested it honours the URL hash, so a reload lands where it was.
 */
export function SettingsScroller({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const target = useSettingsNav((s) => s.scrollTarget);
  // When this page opened. A request made before then is the page being opened at a target, while its sections are
  // still loading; one made after is a jump within a loaded page. (Kept per component rather than as a first-run
  // flag, so a StrictMode re-run of the effects doesn't count as a jump.)
  const [openedAt] = useState(() => Date.now());
  // Whether the URL hash (a reload, or a link from outside) has been brought into view.
  const hashDone = useRef(false);

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
    let id: string | null = null;
    let fromHash = false;
    if (target && target.nonce > handledScroll && Date.now() - target.at < SCROLL_REQUEST_TTL_MS) {
      id = target.id;
    } else if (!hashDone.current && window.location.hash.length > 1) {
      id = decodeURIComponent(window.location.hash.slice(1));
      fromHash = true;
    }
    if (!id) return;
    const nonce = target?.id === id && !fromHash ? target.nonce : null;
    if (isSettingsGroup(id)) {
      // Every page's top is a group's target, so the page being left can't tell; the next one handles it too.
      area.scrollTo({ top: 0 });
      return;
    }
    const jump = !fromHash && target !== null && target.at >= openedAt;
    const smooth = jump && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // A hash is never a jump, so it always gets the full wait.
    const limit = jump ? JUMP_TRIES : MAX_TRIES;
    let tries = 0;
    let frame = 0;
    let unpin = () => {};
    let cancelFlash = () => {};
    const attempt = () => {
      // Once the wait is up, a search pick settles for the nearest part of the page that is there. A jump within a
      // loaded page needn't wait for content to load, so it gives up sooner. A URL hash gets no fallback.
      const last = !fromHash && tries >= limit - 1;
      const element = last ? nearestRendered(id) : document.getElementById(id);
      if (element && area.contains(element)) {
        const handled = () => {
          hashDone.current = true;
          if (nonce !== null) handledScroll = Math.max(handledScroll, nonce);
        };
        // Already at the top of the view (or the scroll can't go further): no scroll, so no `scrollend` either.
        const moves = Math.abs(element.getBoundingClientRect().top - area.getBoundingClientRect().top) > 2;
        element.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
        // A smooth jump is flashed once it lands, so the mark isn't spent while the row is still travelling.
        // A target that isn't rendered lands on a larger part of the page, which isn't worth marking.
        const flash = () => {
          if (target?.highlight && !fromHash && element.id === id) flashElement(element);
        };
        if (smooth && moves) cancelFlash = afterScroll(area, flash);
        else flash();
        if (sectionOf(id)) useSettingsNav.getState().setActiveSection(sectionOf(id)!.id);
        // A page that just opened is still loading what sits above and below the target, so it stays pinned until
        // that settles, and only then counts as handled: if this effect is cleaned up first (a remount), the next
        // run picks the request up again. A jump within a loaded page needs no pin, and a pin would cut its smooth
        // scroll short.
        if (jump) handled();
        else unpin = pinInView(area, element, handled);
        return;
      }
      // Give loading content about two seconds to render the target.
      if (++tries < limit) frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => {
      cancelAnimationFrame(frame);
      unpin();
      cancelFlash();
    };
  }, [target, openedAt]);

  return (
    // Opaque, with the grain scrolling along (bg-local), so Chromium scrolls it on the compositor, as the board's
    // scroller does. Over the main area's background it repainted the whole screen on every scroll frame.
    <div ref={ref} className={cn("min-h-0 flex-1 overflow-y-auto bg-background surface-grain bg-local", className)}>
      <div className="mx-auto w-full max-w-4xl space-y-8 px-4 pt-2 pb-24 sm:px-6">{children}</div>
    </div>
  );
}
