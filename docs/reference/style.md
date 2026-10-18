# Style reference — porting T3 Code's look

T3 Code (`C:\Code\t3code`, MIT, © 2026 T3 Tools Inc.) is the visual source of truth. **Read the
source files listed here directly** rather than re-deriving styles; copy class strings verbatim.
Keep the MIT notice in `NOTICE`. Never modify the t3code repo.

Paths below: `W/` = `C:\Code\t3code\apps\web\src\`.

## 1. Stack parity

- Tailwind **v4**, CSS-first (`@import "tailwindcss"`, `@tailwindcss/vite`), no config file, no animation plugin.
- `@base-ui/react` ^1.5 (not Radix, not cmdk), `class-variance-authority` 0.7, `tailwind-merge` ^3.6, `lucide-react` 0.564.
- `@dnd-kit/core` ^6.3, `@dnd-kit/sortable` ^10, `@dnd-kit/modifiers` ^9, `@dnd-kit/utilities` ^3.2.
- `react-markdown` ^10 + `remark-gfm`, React 19.2, zustand 5, `@tanstack/react-router`.
- `cn` = `twMerge(cx(...))` with `extendTailwindMerge({ extend: { theme: { text: ["2xs","3xs","4xs","5xs"] } } })` — `W/lib/utils.ts`.
- Fonts: system stacks only. Sans `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`; mono `"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace`.

## 2. Tokens — `W/index.css`

Copy these blocks (line numbers approximate):

| Block | Lines | Notes |
|---|---|---|
| `@custom-variant dark/light/any-hover` | top | `dark` = `.dark` class on `<html>` |
| `:root` layout vars (`--control-radius`, `--glass-*`, `--workspace-topbar-height: 52px`, scrollbar vars, sidebar insets, `--command-*-inset`) | 89–149 | |
| `@theme inline` color + radius mapping, `--text-2xs/3xs`, `--color-zinc-25`, inset shadows, `--ease-drawer` | 172–282 | Map `--color-foreground` etc. to **raw** tokens (we drop the `--contrast-*` layer) |
| `@utility` glass: `surface-glass`, `dropdown-glass`, `dialog-glass`, `dialog-backdrop` | ~395–436 | |
| `@layer base` | 638–708 | `* { border-border outline-ring/50 }`, body bg `--app-chrome-background` |
| `:root` color tokens + `@variant dark` | 1087–1196 | The default T3 Code look (it's the *unthemed* set) |
| `[data-app-sidebar]` scope overrides | 1201–1243 | Dark sidebar is pure `#000` with 8/11/7% row mixes |
| Grain: `--surface-grain` SVG + `@utility surface-grain` | 1683–1700 | Baked into each surface, not an overlay |
| Scrollbars | 1750–1766 | 6px, `rgb(255 255 255 / 8%)` thumb in dark |
| `.chat-markdown*` prose CSS | 1766–1900 | For description/plan-context/notes markdown |
| Keyframes `skeleton`, `status-pulse` (stepped), `.no-transitions` | search | No continuous smooth animations |
| `sidebar-stage-backdrop` utility + `--stage-night-*` vars | search | For `SidebarStageBackdrop.tsx` |

Resolved defaults (dark): background `#0a0a0a`, card/popover `#111111`, text `#f5f5f5`, muted text `#818181`,
border `rgb(255 255 255/6%)`, input `/8%`, primary `oklch(0.571 0.21 264)` (light: `oklch(0.488 0.217 264)`),
radius `0.625rem`. Semantic: success = emerald-500, info = blue-500, warning = amber-500, error = red-500;
`-foreground` variants are -700 (light) / -400 (dark). Full table: `C:\Code\t3code\packages\shared\src\themePalettes.ts`
(`T3_CODE_LIGHT_THEME_COLORS` / `T3_CODE_DARK_THEME_COLORS`).

Radius scale: sm = r-4px, md = r-2px, lg = r, xl = r+4, 2xl = r+8, 3xl = r+12.

## 3. Primitives — `W/components/ui/`

Copy, trimming app-specific imports: `button.tsx`, `badge.tsx`, `input.tsx`, `textarea.tsx`, `dialog.tsx`
+ `dialog-styles.ts`, `sheet.tsx`, `popover.tsx`, `menu.tsx`, `tooltip.tsx`, `select.tsx`, `combobox.tsx`,
`autocomplete.tsx`, `command.tsx`, `kbd.tsx`, `scroll-area.tsx`, `separator.tsx`, `switch.tsx`, `toggle.tsx`,
`toggle-group.tsx`, `collapsible.tsx`, `skeleton.tsx`, `spinner.tsx`, `empty.tsx`, `toast.tsx` (+ helpers),
`alert.tsx`, `sidebar.tsx` (simplify). No Card/Tabs/Avatar primitives exist in T3 — cards are ad hoc.

Rules carried over (from `C:\Code\t3code\docs\internals\web-ui.md` + AGENTS.md "Taste"):
- `components/ui` exports own their look: choose `variant`/`size`; `className` only for layout. Add a variant when a generic look is missing.
- Compose with slot objects (see `W/components/chat/ComposerBanner.tsx`), every part has `data-slot`.
- Density flips at `sm:` (`h-9 sm:h-8`), focus `ring-2 ring-inset ring-ring`, disabled `opacity-64`, press `scale-[0.97]`.
- Popups enter/exit via `data-starting-style:`/`data-ending-style:` `scale-98 opacity-0`.
- Theme-only rules use `@variant dark/light`, never `.dark` selectors in CSS.
- **No continuously repainting animations.** Spinners use `motion-safe:visible-animate-spin`; pulses are `steps()`.
  The one exception is the Autopilot pill (`.autopilot-pill` in `index.css`): a conic-gradient arc circles its border
  and a glow breathes while a run is going, so it reads as alive. It is a deliberate product choice, runs only while
  a run is active, and is off under `prefers-reduced-motion`.

## 4. Pattern sources for our components

| Our component | T3 source to imitate |
|---|---|
| App shell, resizable sidebar, rail | `W/components/AppSidebarLayout.tsx`, `W/components/ui/sidebar.tsx`, `W/hooks/useResizeDrag.ts`, `W/components/threadSidebarWidth.ts` (default 256px, min 208) |
| Sidebar header (search + `size-7` icon buttons) | `W/components/sidebar/SidebarThreadHeader.tsx` |
| Sidebar footer (settings + utility icon row) | `SidebarChromeFooter` / `SidebarUtilityMenu` in `W/components/sidebar/SidebarChrome.tsx` |
| Project filter combobox (gear per row) | `W/components/Sidebar.tsx` ~5060–5190, `W/components/ui/combobox.tsx` |
| Attention rows / compact task rows | `SidebarThreadRow` in `W/components/Sidebar.tsx` ~1112 & ~1959–2225; status text map ~1301 |
| Section headers ("Needs attention", "Projects") | `W/components/ui/collapsible-section-header.tsx` |
| Project icon / monogram / colours / identity | `W/components/ProjectFavicon.tsx`, `W/components/ProjectMonogram.tsx`, `W/projectIconColors.ts`, `W/projectIdentity.ts`, `C:\Code\t3code\packages\contracts\src\project.ts` (schema) |
| Icon picker dialog | `W/components/settings/ProjectIconPickerDialog.tsx`, `W/projectIconOptions.ts` |
| Command palette, view stack, Kbd footer, folder browse | `W/components/CommandPalette.tsx`, `CommandPalette.logic.ts`, `CommandPaletteContent.tsx`, `CommandPaletteResults.tsx` |
| "Setup Required" badge | `Button variant="warning-outline" size="micro"` (CommandPalette ~1540) |
| Detail panel frame + resize handle | `W/components/preview/PreviewPanelShell.tsx`, `RightPanelResizeHandle.tsx`, `W/hooks/useResizableWidth.ts` |
| Panel rows ("Open in T3 Code", PR rows) | `W/components/chat/threadDetailsPanelStyles.ts`, `ThreadDetailsCard.tsx`, `ThreadDetailsSection.tsx` |
| Settings-style grouped card | `W/components/settings/SettingsGroup.tsx`, `settingsLayout.tsx` |
| Plan step icons/colours, segmented progress | `W/components/chat/ComposerTasksBadge.tsx` (`TaskSegments`) |
| Activity log lines | `W/components/chat/WorkLog.tsx` |
| Rich Markdown editor (`components/editor/`) | `W/components/ComposerPromptEditorTiptap.tsx`, `W/composer-rich-text-doc.ts`, `W/composer-rich-text.ts`, `C:\Code\t3code\docs\internals\composer-editors.md` |
| Plan card look | `W/components/chat/ProposedPlanCard.tsx` |
| PR state icons/colours | `W/components/pullRequest/pullRequestIcons.tsx`, `PullRequestRow.tsx` |
| Status colour semantics | `resolveThreadStatusPill` in `W/components/Sidebar.logic.ts` ~1179 |
| Relative time ("23h") | `W/timestampFormat.ts` (`formatRelativeTime*`, `formatElapsedDurationLabel`) |
| dnd-kit usage | `W/components/LegacySidebar.tsx` ~2925–3470, `W/components/settings/EnvironmentRoutesList.tsx` |
| Empty states | `W/components/ui/empty.tsx`, `NoProjectsHero.tsx` |
| Theme boot (no flash) | `C:\Code\t3code\apps\web\index.html`, `W/hooks/useTheme.ts` |
| Sidebar night-sky art | `W/components/SidebarStageBackdrop.tsx` |

## 5. Key class strings (quick copy)

- Settings row: title, one short `description` line, optional `info` (`InfoHover`: `InfoIcon` in a hover popover beside the title, for detail that would crowd the row) and `status` (`StatusLine`: badge + detail on one compact line under the description). The page column is `max-w-4xl`.
- Card surface: `rounded-xl border border-border/60 bg-card/40` (settings group); plan card `rounded-3xl border border-border/80 bg-card/70`.
- Sidebar row surface: `group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring` + idle `hover:bg-sidebar-row-hover`, selected `bg-sidebar-row-selected`.
- Panel row: `h-8 min-w-0 rounded-lg border-transparent gap-2.5 px-2.5 text-left text-[13px] font-medium text-foreground/80 w-full justify-start` + hover `hover:!bg-black/[0.035] dark:hover:!bg-white/[0.08]`; icon `size-4 shrink-0 text-muted-foreground`.
- Section: `px-2 pt-2 pb-2.5 border-t border-border/65`; heading `text-2xs font-medium text-muted-foreground`.
- Step icons: done `text-success`, in progress `text-primary`, pending `text-muted-foreground/40`; text done `text-muted-foreground/55`, active `text-foreground/90`, pending `text-muted-foreground/70`.
- Segments: wrapper `flex w-10 shrink-0 items-center gap-0.5`, segment `h-[3px] min-w-0 flex-1 rounded-full` + `bg-success | bg-primary | bg-muted-foreground/25`.
- Soft status chip: `bg-{tone}/8 text-{tone}-foreground dark:bg-{tone}/16` (Badge success/warning/error/info).
- PR states: open `text-emerald-600 dark:text-emerald-300/90`, draft `text-zinc-500 dark:text-zinc-400/80`, closed `text-red-600 dark:text-red-300/90`, merged `text-violet-600 dark:text-violet-300/90`.
- Kbd: `pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded bg-muted px-1 font-medium font-sans text-muted-foreground text-xs`.
