# Appearance: themes, contrast, glass, motion and fonts

Board tasks: #173 and #179 (custom themes) (epic #178). Verified against T3 Code at commit `812b7006f8` (October 2026).

Settings → Board → Appearance holds the same look-and-feel options as T3 Code's Appearance page, so the board
and T3 Code look the same side by side. You pick an appearance mode (System, Light, Dark) and a theme: T3 Code
(the default), T3 Chat, Grove, Ocean, Ember or Iris, for both appearances or just one. Below that are sliders
for contrast, glass opacity and panel animations, and the interface and monospace fonts. You can also create,
edit, export and import themes, from files, VS Code themes or Open VSX. Everything is kept in the browser; the server
never sees it.

## How it works

### Themes

A theme is T3 Code's model, unchanged: an id, a label, a base `appearance` with 61 colour roles (`canvas`,
`surface`, `text`, `accent`, `sidebar`, `messageAction`, …), and optional `variants` for the other appearance.
The five built-ins in `apps/web/src/theme/palettes.ts` are copied verbatim from T3 Code's
`packages/shared/src/themePalettes.ts`. **T3 Code** isn't a theme object: it is the board's own CSS tokens,
which were already T3 Code's, so choosing it applies nothing.

The user's choice is three things:

| Choice     | Storage key (`storageKey()`) | Meaning                                                                       |
| ---------- | ---------------------------- | ----------------------------------------------------------------------------- |
| Mode       | `theme`                      | `light`, `dark` or `system` (the key the old toggle used, so saves carry over) |
| Base theme | `theme-id`                   | The theme for both appearances; absent is T3 Code                             |
| Halves     | `theme-halves`               | `{ light?, dark? }`: a theme for one appearance, overriding the base          |

Clicking a card sets the base and clears the halves. Clicking one orb on a card sets only that half. Picking
T3 Code's orb while a themed base is set turns the base into an explicit half on the other side, so that side
keeps its theme and this side falls back to T3 Code (T3 Code's `assignHalf`). A theme with colours for only
one appearance forces that appearance unless a half covers the one the mode asks for. All of this is pure
logic in `theme/themeState.logic.ts`.

Saved custom themes live in `themes` (a list in T3 Code's stored shape, parsed leniently) and are shown as cards
after the built-ins; themes sharing a `collection` (an Open VSX extension) share one card. See
[Custom themes](#custom-themes).

### Custom themes

**Colours.** Every saved colour is canonical `oklch(L C H)` (with `/ alpha` when translucent), as T3 Code saves it:
`theme/color.ts` parses any CSS colour with culori and formats it, and holds T3 Code's OKLCH ↔ sRGB conversion,
gamut mapping and WCAG contrast helpers. A theme file that leaves roles out is filled from **T3 Chat's** palette
(`getDefaultThemeColors`), because that is what T3 Code does; the editor starts from T3 Code's own palette
(`getStandardThemeColors`).

**Deriving a palette** (`theme/derive.ts`, copied from T3 Code). `createVividThemeColors(appearance, background,
accent)` steps surfaces away from the canvas in OKLCH lightness, tinted with the accent's hue; it solves text to 7:1
on the canvas and every foreground to 4.6:1 on its surface by bisecting lightness, and takes the error and warning
colours from T3 Code's, with surfaces tinted from the canvas. Whether the palette is dark is decided by the canvas's
luminance, not the appearance asked for. `updateThemeColorFamily` sets one role in advanced mode and re-derives the
roles that go with it (a surface's foreground, an action's hover, the toolbar and sidebar copies of text and
borders).

**The library.** `theme/themeLibrary.logic.ts` changes the saved list as pure functions: install, update in place,
remove, and replace a collection in the place it held. Entries this version can't read are kept, and a saved value
that isn't a list is refused rather than overwritten. `customThemeLibrary` in `useTheme.ts` wraps them with
storage: each write re-applies the theme and rewrites the selection so it no longer names a removed theme.

**The editor** (`ThemeEditorPanel.tsx`, opened through `themeEditorStore` and mounted by `ThemeEditorHost` in the app
shell, so it stays open on the board). A session seeds from the theme being edited or duplicated, or T3 Code's
palette. Simple mode edits background and accent and re-derives everything, and saves `managed: true`; a theme
without `managed` opens in advanced mode so hand-tuned colours aren't re-derived away. Advanced mode lists T3 Code's
colour families (Foundation, Brand & content, Search, Context, Status) with a filter. Typing the name of another
custom theme switches the save to adding this palette as that theme's other appearance. While open, the draft is
painted with `previewThemeColors` (`data-theme-id="__preview"`); it survives a re-apply from another tab or the OS,
is never written to the paint snapshot, and `endThemePreview` restores the saved theme when the panel unmounts.

**Inspect** (`themeInspector.ts`, copied from T3 Code). A role is found by setting its `--app-theme-*` variable to a
probe colour and seeing which computed styles change, then restoring it before the browser paints
(`html[data-theme-token-probe]` turns transitions off meanwhile). Tailwind classes that name a token (`bg-card`,
`text-muted-foreground`) short-cut the probe. Selecting a colour spotlights every element it paints, refreshed at
most twice a second while the board changes.

**Import** (`ThemeImportDialog.tsx`). JSON is pasted into a highlighted editor or read from files, each refused
above 256 KB before it is read. A file is a T3 Code theme file, or a VS Code colour theme (workbench colours with
dotted keys, or `tokenColors`), converted by `theme/vscodeThemeImport.ts`: matching workbench colours are flattened
onto what they sit on and kept only when readable, and the rest is derived. Several files at once pair "X Light" and
"X Dark" into one theme. An id already installed offers Update existing (keeping its collection) or Keep both (the
file's name, then "Name (1)"). Reserved ids (the built-ins and appearance keywords) are refused.

**Open VSX** (`theme/openVsxThemes.ts`, `ThemeSearchSection.tsx`). The browser calls `open-vsx.org` directly: its
API, files and CDN redirect all answer `Access-Control-Allow-Origin: *`, so there is no server proxy. Search keeps
extensions with an allowed open-source licence, a theme contribution and a package under 20 MB. Installing
downloads the `.vsix`, checks it against Open VSX's SHA-256, inspects the zip directory for bombs, ZIP64 and path
escapes before JSZip opens it, checks the packaged manifest matches, resolves JSONC `include`s, keeps only the
workbench colours the converter uses, and saves the themes as one collection with stable `ovx-theme-…` ids, so
installing again updates them.

### Applying a theme

`useTheme` (`apps/web/src/hooks/useTheme.ts`) resolves the appearance, toggles `.dark` on `<html>`, and for a
theme sets `data-theme-id` plus one inline `--app-theme-*` variable per role (`applyThemePalette` in
`theme/applyTheme.ts`). The `html[data-theme-id]` block in `index.css` maps those onto the board's tokens:
canvas → `--background`, surface → `--card`, text → `--foreground`, `messageAction` → `--primary` (solid
controls), focus → `--ring`, and error, warning and update roles onto their status tokens. A second block does
the same inside `[data-app-sidebar]`, which sets its own palette. Success, info, label, epic and PR colours
stay fixed. Terminal, composer, search-match and toolbar roles are kept in the data but nothing maps them.

Each built-in also tints the sidebar banner's night art (`--stage-night-*`), and T3 Chat gets its finer grain
tile, both copied from T3 Code.

Storage events on any of the keys re-apply, so other tabs follow. The OS appearance is watched for System.

### No flash on load

The palettes live in the JS bundle, so the boot script in `apps/web/index.html` can't resolve a theme itself.
Instead `useTheme` saves a **paint snapshot** (`theme-paint`) every time it applies: for each appearance the
mode can ask for, the appearance actually shown, the theme id, its variables already named, and its canvas.
The boot script reads the mode, picks the entry for the wanted appearance and paints it before first paint.
The appearance prefs get the same treatment through `appearance-paint` (below). Vite fills the keys in with a
`%STORAGE_KEY(name)%` placeholder (`brandHtml` in `apps/web/vite.config.ts`).

### The desktop title bar

The shell paints its window background and title bar overlay before the page does. `useTheme` sends it two
things: `setTheme` (the appearance its native controls follow; `resolveDesktopTheme` pins a single-appearance
theme's appearance) and `setBackgroundColor`, the theme's canvas as `#rrggbb` (converted with a 1px canvas,
because Electron doesn't take oklch). The main process accepts only `#rrggbb` from the board's origin and
re-applies it on every theme change and on show. `setBackgroundColor` is optional on `DesktopBridge`: an older
shell's preload doesn't have it.

### Contrast, glass, panel animations and fonts

These are prefs in the `useAppearance` store (`state/ui.ts`, persisted under `appearance`, clamped by
`normalizeAppearancePrefs`). `theme/appearance.ts` turns them into inline styles and data attributes on
`<html>` with `appearancePaint` (`theme/appearance.logic.ts`) and saves the same object as `appearance-paint`.

| Setting          | Range       | Default | What it drives                                                                                    |
| ---------------- | ----------- | ------- | ------------------------------------------------------------------------------------------------- |
| Contrast         | 50–200 %    | 100 %   | `--appearance-contrast-base/boost/border-boost`, read by the `--contrast-*` block                 |
| Glass opacity    | 40–100 %    | 80 %    | `--glass-opacity`; at 100 % also `--glass-blur: 0px`                                              |
| Panel animations | 0–400 ms    | 150 ms  | `--panel-animation-duration`, `--slide-duration` and `data-panel-animations` (`false` under reduced motion) |
| Smooth board motion | on / off | on    | `data-board-motion`: `snapshot` or `reflow` ([Snapshot motion](#snapshot-motion))                  |
| Zoom windows from their source | on / off | on | `data-window-zoom`: the task window grows out of its card or the panel ([Window zoom](#window-zoom)) |
| Interface font   | name; 12–20 px | system, 16 px | `--font-sans`; the size is the root font size, so every rem scales                         |
| Monospace font   | name        | system  | `--font-mono`                                                                                     |

**Contrast** uses T3 Code's formulas: below 100 % each foreground mixes toward its surface and each border
toward transparent; above it they mix toward black or white (borders a quarter as fast). The `--contrast-*`
variables are defined on `:root` and again on `[data-app-sidebar]`, and Tailwind's foreground, border and input
colours read them (`@theme inline`), so every `text-foreground`, `text-muted-foreground` and `border` follows.

**Panel animations**: board cards sliding between columns use 1.75× the duration (`useBoardFlip`, see
[board-layout.md](board-layout.md#card-motion)). The sidebar and the task panel slide for 3× the duration
(`--slide-duration`, set by `appearancePaint` from `slideDurationMs` in `lib/slide.logic.ts`: 150 ms gives 450 ms) on
`SLIDE_EASING`, `cubic-bezier(0.2, 0.9, 0.25, 1)`, fitted frame by frame from a recording of Antigravity's right-hand
panel opening: fast start, long soft tail. The settings preview plays the same length and curve.

With Smooth board motion off (or where the browser can't run it, see [Snapshot motion](#snapshot-motion)), both
slides are `startSlide` in `lib/slide.ts`, with the board making room as they move. Two Web Animations share one
start time: the width of the space beside the sidebar or panel (the *room*), which the main area lays out around every
frame so the board's columns and cards move with it, and a `transform` on the sidebar or panel itself (the *mover*),
which the compositor runs, so when React holds up the main thread the board waits a frame but the slide keeps going.
From rest the slide holds its first frame and starts the clock two frames later: that frame carries React's work for
the toggle, and the rAF that runs at its end has its stale start as the timeline's time. A toggle mid-slide turns
around from where it is, over the share of the duration left; a slide held in place (StrictMode runs layout effects
twice) counts as at rest. A card drag or a resize drag finishes any slide first (`finishSlides`), since dnd-kit
measures the columns as a drag starts and the slide animates the width a resize writes. Both slides are off with Panel
animations at 0 and under reduced motion.

- **Sidebar** (`useSidebarSlide` in `ui/sidebar.tsx`, offcanvas only): the room is the gap, the mover the container,
  which keeps its width so its contents never re-wrap. The button left of the wordmark (`SidebarBrandRow`) and
  `sidebar.toggle` (Ctrl/Cmd+B) hide it; the header's trigger brings it back.
- **Task panel** (`usePanelSlide` in `task/TaskPanel.tsx`): the room is the `<aside>`, the mover its contents, an
  inner wrapper pinned to the aside's right edge at `var(--resizable-width)` (at least 380px, the `@container` the
  panel's `@[460px]` queries measure). `AppLayout` keeps it mounted on the closed task until the slide-out ends.
  `panel.toggle` (Ctrl/Cmd+Alt+B) closes it or reopens the last task.
  A panel that is there when the app loads on the board with `?task=` appears in place, with no slide: `AppLayout`
  decides once, when it mounts, and passes `slideIn={false}`. Closing it, and any later open or close, still animate.
  Opening Settings or Stats doesn't unmount the board, so the panel behind the window just stays.

React work is kept out of the slide, since the board's part runs on the main thread: a card prefetches its task's
detail on pointer down (`usePrefetchTaskDetail`), so the panel renders its contents in the commit that mounts it rather
than as a second render mid-slide; `AppLayout` renders `Board` through `memo` and keeps the mark-as-read mutation in a
child of its own, since a mutation re-renders whoever holds it; `BoardContent` reads the selected task through
`useDeferredValue`, so the whole-board render that moves the card highlight is time-sliced between frames; and
`useTaskView`'s first ping, whose refetch re-renders the panel, waits until the slide is over.

Re-laying out the board every frame is what keeps everything moving together, and it costs frame rate: on a 280 Hz
display a compositor-only animation draws every frame, while a slide that lays the board out draws about 150 to 180 a
second, however cheap each frame is. `Button` has no `will-change` for that reason: it made each of the board's dozens
of buttons a compositor layer that every frame re-layered.

**Fonts** are typed by name and applied on Enter or blur, only if the browser can draw the family (and, for
the monospace font, if it is monospaced): T3 Code's canvas probes in `theme/fonts.ts`.

### Snapshot motion

**Smooth board motion** (`boardMotion: "snapshot"`, the default) moves the board differently when the task panel or the
sidebar opens or closes. The slide above lays the board out every frame, which tops out around 150 to 180 frames a
second on a 280 Hz screen however few cards there are. Snapshot motion runs the change as a View Transition instead:
the board is laid out once at its new width, and the compositor moves snapshots from their old boxes to their new
ones. The code is `lib/boardMotion.ts` and the View Transition block in `index.css`.

- **Task panel:** the router wraps the navigation (`defaultViewTransition` in `router.tsx`), only for `?task=` appearing
  or disappearing on the board (`panelTransitionType`), with the types `panel-open` and `panel-close`. Any other
  navigation returns `false`, which the router takes as no transition. While a board transition runs
  (`boardTransitionRunning`), `TaskPanel` skips `startSlide` and `AppLayout` unmounts a closing panel at once, since its
  snapshot (`task-panel`) slides out instead. A task opened from another page gets no transition, so its
  panel slides in with `startSlide`; one restored on return or load doesn't slide at all (above).
- **Sidebar:** `setOpen` (`ui/sidebar.tsx`) starts its own transition (`startSidebarTransition`, types `sidebar-open`
  and `sidebar-close`, the change applied in `flushSync`) and `useSidebarSlide` stands down. The change applies only
  once the old state is captured, so a second toggle before then starts from the state the first one asked for. The offcanvas sidebar is
  there in both states, so its snapshot (`app-sidebar`) slides between its two places by itself. An open task panel is
  in both states too, at the same place, so it holds still: its slide-in and slide-out play only in `panel-open` and
  `panel-close` transitions. Played in a sidebar transition as well, the old snapshot slid out while the new one slid in,
  so the panel closed and opened again. Only over the board
  (`sidebarSnapshotMotion`, which also wants `[data-board-scroll]` mounted): other pages name nothing, so a transition
  would hold their main area at its old layout and then jump, and there the sidebar slides with `startSlide` as before.
- **When:** `boardSnapshotMotion()`: the setting is on, Panel animations are on (so not at 0 ms or under reduced
  motion), and `snapshotMotionSupported()`, which wants transition types, `match-element` and
  `document.activeViewTransition`. Without types the router would ignore `types` and animate every navigation, so where
  they are missing it gets no `defaultViewTransition` at all and both slides fall back to `startSlide`.

`prepareBoardTransition(kind)`, called just before the transition starts, decides what moves on its own. Every name
costs: Chromium's setup grows with the square of the snapshots (on a full board, 75 took about 90 ms and 140 about
1.3 s), so it names only what is on screen and what this kind of transition moves:

- **Movers** (cards, cells, column headers and their buttons, the top bar's buttons, an epic header's title and
  roll-up) get `data-vt`, which `index.css` names with `match-element`. A right-aligned part (a column header's button,
  the epic roll-up) is named apart from its parent, so it glides with the right edge. Lane titles and the top bar's
  left side (`data-vt-left`) only move with the board's left edge, so they are named for the sidebar only.
- **Frames** (an epic band, its header) get a name of their own (`vt-frame-N`) and stretch: their right edge moves
  while the left stays, and what they hold is named separately, so only a border and a fill stretch.
- **Cards in a sidebar transition** (`data-task-card`, `data-epic-card`) also get names of their own (`vt-stretch-N`,
  class `stretch`) and stretch in width, as a `scaleX` (below). Opening or closing the sidebar changes the columns' width (with the panel
  closed; with it open they are usually at their minimum already), and a card that only moved sat at its new width from
  the first frame, so every right edge jumped and then glided. Only cards: a column header or an epic title has no box to
  stretch, only text, so those still only move, and a right-aligned part named apart from them keeps gliding with the
  right edge.
- Names live only during the transition: setting them under `html:active-view-transition-type()` restyled the whole
  page as it started. A transition started over a running one skips it and takes over its names, and the skipped one
  finishing leaves them alone.

Once the animations exist:

- `compositorOnly` drops width and height from every snapshot's keyframes. The browser animates both by default, on the
  main thread, which restyled every snapshot every frame (30 fps on a full board). Movers sit at their new size and
  clip their snapshots. What stretches (frames, and cards in a sidebar transition) gets its size animation back as a
  transform: the group sits at its new size and scales from its top left corner (`transform-origin: 0 0`), from the
  old size over the new to 1, so the compositor still runs it. Frames scale in both directions (a band's height can
  change); cards only in width. Frames used to keep their width and height animations, and cards in the first version
  of the stretch did too: those groups ran on the main thread at a fraction of the frame rate, so their edges stuttered
  while everything around them glided. As a transform the stretch costs no more main-thread style time than moving only
  (measured on the `dense` seed in headless Chromium). The snapshot scales, so a card's text is a little squeezed or
  widened while it stretches, as it was with the width.
- A card's **new snapshot shows from the start and the old one not at all** (no cross-fade), so its text is at its new
  wrap as it moves and nothing shows twice. A cross-fade looked the same and took about twice the GPU and compositor
  work on a full board.
- `holdFirstFrame` pauses every snapshot and starts their clocks together two frames later, as `startSlide` does. The
  first frame draws every new snapshot and comes late, and the curve starts fast, so on its own clock the transition
  was a third of the way there by the first frame that showed: a jump, then a slide.
- While it runs the page shows snapshots, so input would reach the live board unseen: a scroll did nothing until the
  end, then jumped. The first wheel, pointer down, key or touch hurries the transition (`hurryToEnd`): every animation
  speeds up to finish within 120 ms from where it is, and the board takes the input from there. The snapshots let
  pointer events through to the live page.
- The page underneath (`root`) doesn't cross-fade. It is the old page while opening and the new one while closing, the
  wider of the two, so the scrollbar and lane lines reach the window's edge and the panel or sidebar covers them. The
  panel's and sidebar's groups sit above the board's, since a closing panel is only in the old state, which the
  browser stacks underneath.

### Window zoom

**Zoom windows from their source** (`windowZoom`, on by default; board task #158) makes the
[task window](board-layout.md#the-task-window) grow out of where it was opened from and shrink back when it leaves.
Only the task window: Settings and Stats have no source and keep the fade. The code is `lib/windowZoom.ts` and
`windowZoom.logic.ts`; `AppRouteModal` takes it as its `zoom` prop.

- **Source.** The docked panel's `<aside>` when the panel is open, otherwise the task's card. Every way in goes through
  `useOpenTask` or `useSetTaskExpanded`, which record it just before navigating (`noteWindowSource`); `TaskWindow` takes
  the record when it mounts. A double-click's first click opens the panel, so `Board` remembers whether the panel was
  open before it and passes `from: "card"` when it wasn't. A window that is restored (on load, or coming back from
  behind Settings) has no record and fades in.
- **Leaving.** Docking (the dock button, `f`, and Esc or the backdrop when the task came from the panel) moves the
  window onto the aside (below). Without an aside behind it (the task came from the board) it fades. Closing the task
  (**×**, `panel.toggle`, a delete) shrinks it onto the card when at least half of the card is on screen
  (`visibleSource`); scrolled away, collapsed or filtered out, the window fades as before.
- **Technique.** A FLIP on the dialog's popup: it is laid out at rest and animated with the Web Animations API from a
  transform that puts it on the source. From a card that is a `translate` and `scale` (`zoomTransform`), with the
  border radius divided by the scale so the corners look like the source's; the window fades in over the first quarter
  of the distance and, going back, fades out over the last 15%, so the squash of a small card never shows. Over the
  panel it doesn't scale: the panel is about the window's height and a third of its width, so a scaled window landed
  as a frame of stretched text. It moves its top-left corner onto the panel's and is cropped to the panel's size with a
  `clip-path: inset()` (`cropTransform`, `cropClipCss`), so it lands at the size the panel shows it, and it stays
  solid. Going there, the panel can only show the task once the window has gone (one live panel), so a window landing
  on it would swap for the panel's own layout in a frame and its contents be seen settling. So docking hands over to
  an inert copy (`dockGhost`: ids, roles and the dialog's attributes stripped, scroll positions copied) and the window
  goes at once, so the task docks under the copy. The copy's contents fade out over the first 60% of its move, and its
  border and shadow over the first 25% (its grey edge would otherwise cut through the panel as it lands), so it
  lands on the panel as an empty surface; the panel's contents stay hidden meanwhile (`data-task-docking` on `<html>`,
  `index.css`), then, once the copy has landed and the panel has the task (it does only after the dialog's own closing transition,
  so a short zoom waits for it rather than uncovering the placeholder), the copy goes and they fade in from the top
  down, all at once (`revealPanel`: a sliding
  `mask-image` gradient on `[data-panel-contents]` over 1.2× the zoom, the aside taking its colour so the board
  doesn't show through). A timer undoes the copy and the hiding if the animations never end. The clip at rest reaches past the window by its shadow's size, since a clip only
  animates to another `inset()`. The keyframes name `opacity` and `scale` at both ends, so the fade's own
  `data-starting-style` and `data-ending-style` transition doesn't show through.
- **Speed and curve.** Twice Panel animations (`zoomDurationMs`: 150 ms gives 300 ms), on `ZOOM_EASING`, the slide's
  `cubic-bezier(0.2, 0.9, 0.25, 1)`, both ways. Chosen from frames in headless Chromium at 100, 150 and 300 ms; nobody
  has judged it by eye on a real screen yet.
- **Waiting.** The exit starts before the dialog closes; Base UI waits for the popup's animations before it reports the
  window closed, so the navigation that docks or closes still comes after. An exit over a running entrance (Esc as the
  window opens) starts from the transform the window has and runs for the share already covered, at least 40%.
- **Board transitions.** A View Transition shows snapshots, and the window is in none, so it would be unseen until the
  transition ended. A task opened straight into the window therefore starts no `panel-open` transition
  (`panelTransitionType`): its panel appears in place and the board is at its new width at once. Under a double-click
  the first click has started one; the zoom waits for it and measures the card where it ended up.
- **Off** when the switch is off, with Panel animations at 0 and under reduced motion (`data-panel-animations`): the
  window then fades and scales in place. The switch is disabled with a note in the last two cases.

### Grain

The board, sidebar and column headers carry T3 Code's grain: a faint noise tile in each surface's own background
(`--surface-grain`, the `surface-grain` utility). T3 Code draws it as an SVG `feTurbulence` filter; this app uses PNG
tiles of that same SVG, rendered once by Chromium at 1x and 2x (`apps/web/src/assets/grain/`, chosen with
`image-set`), which match it to within two levels per channel. As an SVG background the filter ran again for every
tile the GPU rastered. The slide and scrolling re-raster most of the screen, so on a 1440p screen it was most of a
frame's raster cost, and with the GPU at idle clocks the first frames of a slide or a scroll dropped. To change the
noise, edit the SVG's parameters (in the comment beside `--surface-grain`) and render the tiles again: draw the SVG at
each size on a canvas in Chromium and save it as PNG.

The board's scroller (`[data-board-scroll]`) and the Settings pages' scroller (`SettingsScroller`) paint their own
opaque background and grain, scrolling with the content (`bg-local`). Chromium only scrolls an element on the
compositor when it can keep its subpixel text, which needs an opaque background inside the scroller. Over the main
area's background they instead repainted and re-rastered the whole screen on every scroll frame, a cost that grows
with the screen's size and with what is on it. A new scrolling page over the main area needs the same.

`pnpm sandbox --prod --seed dense` has a project with twenty cards in every column, one with an epic across every
column, fifteen cards spread across the columns beside the same fifteen in backlog, and a single card, for checking
how the board renders when full. Judge performance on that production build: React's development build renders several
times slower.

## Decisions

- **Copy T3 Code verbatim.** Same roles, palettes, file format, CSS mapping and formulas, so a theme means the
  same thing in both apps and a T3 Code theme file will import unchanged (#179).
- **Web only.** The server never reads a theme, so nothing is in contracts except the desktop bridge method.
- **A paint snapshot, not palettes in `index.html`.** Duplicating 61 roles × 10 palettes in the boot script
  would drift; the snapshot is whatever the app last applied, so custom themes work too.
- **culori for colours**, as T3 Code. #173 checked colours with a regex; saving canonical oklch and deriving
  palettes needs a real parser, and the same one keeps saved values identical to T3 Code's.
- **Open VSX from the browser.** It allows any origin, and the integrity checks don't depend on where the code runs.
- **A native range input**, as T3 Code uses, rather than Base UI's Slider.
- **The mode key stays `theme`.** The old toggle's saves keep working; the theme id is a new key.
- **Settings the board skips:** environment identification, composer context, chat width, diff colours, word
  wrap, and the prompt and terminal fonts. The board has none of those surfaces.

## Alternatives considered

| Option                                                  | Why not chosen                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| Store theme choices in server settings                  | Per-browser like T3 Code's; the server has no use for them               |
| A transition on the task panel's width                  | Dragging its edge would lag behind the pointer                           |
| Lay the main area out once, then glide it with a transform | Its right edge (header controls, the docked panel) jumped a sidebar width |
| The panel slides over the board, which resizes when it lands | The columns all snapped narrower at the end instead of moving with it |
| Compositor-only slides (the board doesn't re-lay out) | Every frame at 280 Hz, but the columns snap at the start or end; chose moving together |
| Inline the built-in palettes in the boot script          | Duplicated data that drifts, and no answer for custom themes             |
| Proxy Open VSX through the server                       | Open VSX allows any origin; a proxy adds a route with nothing to guard   |
| Keep T3 Code's palette as the fill for partial files    | T3 Code fills from T3 Chat's; a partial file would look different in each |

## Code map

| File                                                        | What it does                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/web/src/theme/palettes.ts`                            | Roles, types, T3 Code's colours, the five built-ins, role → variable |
| `apps/web/src/theme/themeFile.ts`                           | T3 Code's theme file: parse, serialize, stored themes               |
| `apps/web/src/theme/color.ts`, `derive.ts`                  | Colour parsing and contrast; deriving palettes and colour families   |
| `apps/web/src/theme/themeLibrary.logic.ts`                  | Install, update, remove, replace a collection in the saved list      |
| `apps/web/src/theme/vscodeThemeImport.ts`, `openVsxThemes.ts` | VS Code theme conversion; Open VSX search and install              |
| `apps/web/src/components/settings/ThemeEditorPanel.tsx`, `ThemeEditorHost.tsx`, `themeEditorStore.ts`, `themeEditor.logic.ts` | The theme editor |
| `apps/web/src/components/settings/ThemeColorPicker.tsx`, `components/ui/color-picker.tsx` | A colour row and its picker |
| `apps/web/src/components/settings/themeInspector.ts`        | Inspect: which role paints an element, and the spotlight             |
| `apps/web/src/components/settings/ThemeImportDialog.tsx`, `ThemeSearchSection.tsx`, `themeImport.logic.ts` | Add theme |
| `apps/web/src/theme/themeState.logic.ts`                    | Resolving the appearance and theme, halves, the paint snapshot       |
| `apps/web/src/theme/applyTheme.ts`                          | Writing a palette to `<html>`; colour → hex for the shell            |
| `apps/web/src/hooks/useTheme.ts`                            | The theme store: storage, apply, tabs, OS changes, the shell         |
| `apps/web/src/theme/appearance.logic.ts`, `appearance.ts`   | Contrast, glass, animation and font prefs and applying them          |
| `apps/web/src/lib/slide.ts`, `slide.logic.ts`               | The sidebar and task panel slide: `startSlide`, its curve and maths  |
| `apps/web/src/lib/windowZoom.ts`, `windowZoom.logic.ts`     | The task window's zoom: its source, the FLIP and its maths           |
| `apps/web/src/theme/fonts.ts`                               | Whether a font family is installed / monospaced                      |
| `apps/web/src/theme/themePreview.ts`                        | How a card's orbs are drawn                                          |
| `apps/web/src/components/settings/AppearanceSection.tsx`    | The Appearance settings                                              |
| `apps/web/src/components/settings/ThemeLibrary.tsx`         | Mode tiles and theme cards                                           |
| `apps/web/src/components/settings/ThemePreviewCircles.tsx`, `ThemeWireframe.tsx`, `PanelAnimationsPreview.tsx` | T3 Code's previews (the panel one plays the slide's curve) |
| `apps/web/src/components/ui/slider.tsx`                     | The settings slider                                                  |
| `apps/web/src/index.css`                                    | `html[data-theme-id]` mapping, `--contrast-*`, `.settings-slider`                 |
| `apps/web/index.html`                                       | The boot script                                                      |
| `apps/desktop/src/main.ts`, `titleBar.ts`, `preload.ts`     | `desktop:set-background` and the window colours                      |
