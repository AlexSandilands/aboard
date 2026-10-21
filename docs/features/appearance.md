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
| Panel animations | 0–400 ms    | 150 ms  | `--panel-animation-duration` and `data-panel-animations` (`false` under reduced motion)           |
| Interface font   | name; 12–20 px | system, 16 px | `--font-sans`; the size is the root font size, so every rem scales                         |
| Monospace font   | name        | system  | `--font-mono`                                                                                     |

**Contrast** uses T3 Code's formulas: below 100 % each foreground mixes toward its surface and each border
toward transparent; above it they mix toward black or white (borders a quarter as fast). The `--contrast-*`
variables are defined on `:root` and again on `[data-app-sidebar]`, and Tailwind's foreground, border and input
colours read them (`@theme inline`), so every `text-foreground`, `text-muted-foreground` and `border` follows.

**Panel animations**: the ported sidebar primitive already transitions when an ancestor has
`data-panel-animations="true"`. The task panel grows in from its edge with the `.panel-enter` keyframe and
shrinks back with `.panel-exit`: `AppLayout` keeps it mounted on the closed task until its `animationend`.
Only the `<aside>`'s width animates. Its contents sit in an inner wrapper fixed at `var(--resizable-width)` (at least
380px, the `@container` the panel's `@[460px]` queries measure), anchored left and clipped by the `<aside>`, so they
slide in and out at full size instead of being re-laid out and wrapped on every frame. The keyframes set
`overflow: hidden` only while they play, so the resize handle, which hangs over the panel's edge, isn't clipped at rest.

**Fonts** are typed by name and applied on Enter or blur, only if the browser can draw the family (and, for
the monospace font, if it is monospaced): T3 Code's canvas probes in `theme/fonts.ts`.

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
| `apps/web/src/theme/fonts.ts`                               | Whether a font family is installed / monospaced                      |
| `apps/web/src/theme/themePreview.ts`                        | How a card's orbs are drawn                                          |
| `apps/web/src/components/settings/AppearanceSection.tsx`    | The Appearance settings                                              |
| `apps/web/src/components/settings/ThemeLibrary.tsx`         | Mode tiles and theme cards                                           |
| `apps/web/src/components/settings/ThemePreviewCircles.tsx`, `ThemeWireframe.tsx`, `PanelAnimationsPreview.tsx` | Copied T3 Code previews |
| `apps/web/src/components/ui/slider.tsx`                     | The settings slider                                                  |
| `apps/web/src/index.css`                                    | `html[data-theme-id]` mapping, `--contrast-*`, `.settings-slider`, `.panel-enter` |
| `apps/web/index.html`                                       | The boot script                                                      |
| `apps/desktop/src/main.ts`, `titleBar.ts`, `preload.ts`     | `desktop:set-background` and the window colours                      |
